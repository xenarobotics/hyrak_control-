// Hashed-block TSDF fusion kernels, compiled at runtime by CuPy/NVRTC.
//
// The volume is a sparse hash map from integer block coordinates to fixed-size
// BLOCK^3 voxel blocks. Sparse rather than dense because a drone flight sweeps
// a corridor through a large volume: a dense grid covering the same extent
// would be almost entirely empty and would not fit in 8 GB.
//
// Storage is half precision for the TSDF and weight fields. At 4 cm voxels the
// truncation band is a few centimetres and fp16 resolves it far more finely
// than the depth input justifies, so fp32 would double the memory for no gain.

#include <cuda_fp16.h>

#define EMPTY_KEY 0xFFFFFFFFFFFFFFFFULL
#define COORD_OFFSET 1048576   // 2^20, recentres signed coords into unsigned
#define COORD_MASK   0x1FFFFF  // 21 bits per axis

typedef unsigned long long u64;

__device__ __forceinline__ u64 pack_coord(int x, int y, int z) {
    u64 ux = (u64)((x + COORD_OFFSET) & COORD_MASK);
    u64 uy = (u64)((y + COORD_OFFSET) & COORD_MASK);
    u64 uz = (u64)((z + COORD_OFFSET) & COORD_MASK);
    return (ux << 42) | (uy << 21) | uz;
}

__device__ __forceinline__ void unpack_coord(u64 key, int* x, int* y, int* z) {
    *x = (int)((key >> 42) & COORD_MASK) - COORD_OFFSET;
    *y = (int)((key >> 21) & COORD_MASK) - COORD_OFFSET;
    *z = (int)( key        & COORD_MASK) - COORD_OFFSET;
}

// splitmix64 finaliser: cheap and mixes the low bits well, which matters
// because block coordinates are highly correlated between neighbours.
__device__ __forceinline__ u64 hash_key(u64 k) {
    k ^= k >> 30; k *= 0xbf58476d1ce4e5b9ULL;
    k ^= k >> 27; k *= 0x94d049bb133111ebULL;
    k ^= k >> 31;
    return k;
}

// ---------------------------------------------------------------------------
// Pass 1: which blocks does this depth image touch?
//
// One thread per (pixel, sample) pair. Samples span the truncation band along
// the ray so blocks just in front of and behind the surface are allocated too,
// which is what lets the TSDF represent a zero crossing at all.
// ---------------------------------------------------------------------------
extern "C" __global__ void touched_blocks(
    const float* __restrict__ depth,
    int H, int W, int stride,
    const float* __restrict__ T_wc,       // 4x4 row-major camera-to-world
    float fx, float fy, float cx, float cy,
    float voxel_size, int block_size,
    float trunc, float min_depth, float max_depth,
    int n_samples,
    u64* __restrict__ out_keys,           // n_pixels * n_samples
    int n_out)
{
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    int pix_w = (W + stride - 1) / stride;
    int pix_h = (H + stride - 1) / stride;
    int n_pix = pix_w * pix_h;
    if (tid >= n_pix * n_samples) return;

    int s   = tid / n_pix;
    int pix = tid - s * n_pix;
    int u = (pix % pix_w) * stride;
    int v = (pix / pix_w) * stride;
    if (u >= W || v >= H) { out_keys[tid] = EMPTY_KEY; return; }

    float d = depth[v * W + u];
    if (!(d > min_depth) || d > max_depth) { out_keys[tid] = EMPTY_KEY; return; }

    // Walk the band [d - trunc, d + trunc] in depth (not ray length): the TSDF
    // is defined along the optical axis, matching how sdf is measured below.
    float t = d - trunc + (2.0f * trunc) * ((float)s / fmaxf((float)(n_samples - 1), 1.0f));
    if (t <= 0.0f) { out_keys[tid] = EMPTY_KEY; return; }

    float xc = (u - cx) / fx * t;
    float yc = (v - cy) / fy * t;
    float zc = t;

    float xw = T_wc[0]*xc + T_wc[1]*yc + T_wc[2]*zc  + T_wc[3];
    float yw = T_wc[4]*xc + T_wc[5]*yc + T_wc[6]*zc  + T_wc[7];
    float zw = T_wc[8]*xc + T_wc[9]*yc + T_wc[10]*zc + T_wc[11];

    float bs = voxel_size * (float)block_size;
    int bx = (int)floorf(xw / bs);
    int by = (int)floorf(yw / bs);
    int bz = (int)floorf(zw / bs);
    out_keys[tid] = pack_coord(bx, by, bz);
}

// ---------------------------------------------------------------------------
// Pass 2: look up or allocate storage for a set of UNIQUE block keys.
//
// Open addressing with linear probing. Callers must pass deduplicated keys --
// that guarantee is what removes the need to spin-wait on a concurrently
// inserting thread, which in a GPU warp is a deadlock risk rather than a
// slowdown.
// ---------------------------------------------------------------------------
extern "C" __global__ void hash_lookup_or_alloc(
    const u64* __restrict__ keys, int n_keys,
    u64* __restrict__ table_keys,
    int* __restrict__ table_vals,
    int table_size,
    int* __restrict__ block_count,
    int max_blocks,
    int* __restrict__ out_index,          // storage slot per key, -1 if full
    int* __restrict__ out_coords,         // 3 ints per key
    int* __restrict__ alloc_coords,       // registry: coords of every live block
    int* __restrict__ overflow_flag)
{
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= n_keys) return;
    u64 key = keys[tid];
    if (key == EMPTY_KEY) { out_index[tid] = -1; return; }

    int cx_, cy_, cz_;
    unpack_coord(key, &cx_, &cy_, &cz_);
    out_coords[tid*3+0] = cx_;
    out_coords[tid*3+1] = cy_;
    out_coords[tid*3+2] = cz_;

    u64 slot = hash_key(key) & (u64)(table_size - 1);
    for (int probe = 0; probe < table_size; ++probe) {
        u64 cur = table_keys[slot];
        if (cur == key) { out_index[tid] = table_vals[slot]; return; }
        if (cur == EMPTY_KEY) {
            u64 prev = atomicCAS((unsigned long long*)&table_keys[slot], EMPTY_KEY, key);
            if (prev == EMPTY_KEY) {
                int idx = atomicAdd(block_count, 1);
                if (idx >= max_blocks) {
                    // VRAM budget reached. Refuse rather than overrun; the host
                    // evicts stale blocks and retries. Release the slot we
                    // claimed -- leaving the key in with val=-1 would poison
                    // this block coordinate for the rest of the session, so
                    // even after eviction it could never be mapped again.
                    atomicExch(block_count, max_blocks);
                    table_vals[slot] = -1;
                    out_index[tid] = -1;
                    atomicExch(overflow_flag, 1);
                    __threadfence();
                    atomicExch((unsigned long long*)&table_keys[slot], EMPTY_KEY);
                    return;
                }
                table_vals[slot] = idx;
                // Register the block so extraction can enumerate the volume
                // without walking the whole hash table.
                alloc_coords[idx*3+0] = cx_;
                alloc_coords[idx*3+1] = cy_;
                alloc_coords[idx*3+2] = cz_;
                out_index[tid] = idx;
                return;
            }
            if (prev == key) { out_index[tid] = table_vals[slot]; return; }
        }
        slot = (slot + 1) & (u64)(table_size - 1);
    }
    out_index[tid] = -1;              // table full
    atomicExch(overflow_flag, 1);
}

// ---------------------------------------------------------------------------
// Rebuild helper: insert key i with value i into an empty table. Used by
// eviction compaction, which gathers the surviving blocks to the front of the
// storage arrays and then needs the hash table to reflect the new indices.
// Keys are unique (they come from the live-block registry), so a plain
// claim-and-write suffices.
// ---------------------------------------------------------------------------
extern "C" __global__ void hash_insert(
    const u64* __restrict__ keys, int n_keys,
    u64* __restrict__ table_keys,
    int* __restrict__ table_vals,
    int table_size)
{
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= n_keys) return;
    u64 key = keys[tid];
    if (key == EMPTY_KEY) return;
    u64 slot = hash_key(key) & (u64)(table_size - 1);
    for (int probe = 0; probe < table_size; ++probe) {
        u64 prev = atomicCAS((unsigned long long*)&table_keys[slot], EMPTY_KEY, key);
        if (prev == EMPTY_KEY || prev == key) {
            table_vals[slot] = tid;
            return;
        }
        slot = (slot + 1) & (u64)(table_size - 1);
    }
}

// ---------------------------------------------------------------------------
// Pass 3: integrate the depth image into the allocated blocks.
//
// One CUDA block per voxel block, one thread per voxel. Because the key list is
// unique, no two threads ever touch the same voxel and the whole update is
// atomic-free.
// ---------------------------------------------------------------------------
extern "C" __global__ void integrate(
    const int* __restrict__ block_coords,   // 3 ints per block
    const int* __restrict__ block_index,    // storage slot per block
    int n_blocks, int block_size,
    const float* __restrict__ depth,
    const unsigned char* __restrict__ color,
    const float* __restrict__ weight_map,   // per-pixel fusion weight
    int H, int W,
    const float* __restrict__ T_cw,         // 4x4 row-major world-to-camera
    float fx, float fy, float cx, float cy,
    float voxel_size, float trunc,
    float min_depth, float max_depth, float max_weight,
    __half* __restrict__ tsdf,
    __half* __restrict__ wsum,
    unsigned char* __restrict__ rgb)
{
    int b = blockIdx.x;
    if (b >= n_blocks) return;
    int slot = block_index[b];
    if (slot < 0) return;

    int vpb = block_size * block_size * block_size;
    for (int lin = threadIdx.x; lin < vpb; lin += blockDim.x) {
        int lz =  lin / (block_size * block_size);
        int rem = lin - lz * block_size * block_size;
        int ly =  rem / block_size;
        int lx =  rem - ly * block_size;

        // Voxel centre in world coordinates.
        float xw = ((float)(block_coords[b*3+0] * block_size + lx) + 0.5f) * voxel_size;
        float yw = ((float)(block_coords[b*3+1] * block_size + ly) + 0.5f) * voxel_size;
        float zw = ((float)(block_coords[b*3+2] * block_size + lz) + 0.5f) * voxel_size;

        float xc = T_cw[0]*xw + T_cw[1]*yw + T_cw[2]*zw  + T_cw[3];
        float yc = T_cw[4]*xw + T_cw[5]*yw + T_cw[6]*zw  + T_cw[7];
        float zc = T_cw[8]*xw + T_cw[9]*yw + T_cw[10]*zw + T_cw[11];
        if (zc <= 1e-4f) continue;

        float u = fx * xc / zc + cx;
        float v = fy * yc / zc + cy;
        int ui = (int)(u + 0.5f);
        int vi = (int)(v + 0.5f);
        if (ui < 0 || ui >= W || vi < 0 || vi >= H) continue;

        float d = depth[vi * W + ui];
        if (!(d > min_depth) || d > max_depth) continue;

        float sdf = d - zc;
        // Behind the surface by more than the truncation: this voxel is
        // occluded, and writing it would carve away real geometry.
        if (sdf < -trunc) continue;

        float sdf_n = fminf(1.0f, sdf / trunc);
        float w_new = weight_map ? weight_map[vi * W + ui] : 1.0f;
        if (w_new <= 0.0f) continue;

        int off = slot * vpb + lin;
        float t_old = __half2float(tsdf[off]);
        float w_old = __half2float(wsum[off]);
        float w_tot = w_old + w_new;
        if (w_tot <= 0.0f) continue;

        tsdf[off] = __float2half((t_old * w_old + sdf_n * w_new) / w_tot);
        // Capping the weight keeps the surface responsive: an uncapped weight
        // would freeze early observations in place and prevent later, closer
        // views from correcting them.
        wsum[off] = __float2half(fminf(w_tot, max_weight));

        // Colour only from voxels near the zero crossing; far from the surface
        // the projection lands on unrelated pixels and smears the texture.
        if (fabsf(sdf_n) < 0.5f && color != nullptr) {
            int ci = (vi * W + ui) * 3;
            int vo = off * 3;
            float a = w_new / w_tot;
            for (int k = 0; k < 3; ++k) {
                float c_old = (float)rgb[vo + k];
                float c_new = (float)color[ci + k];
                rgb[vo + k] = (unsigned char)fminf(255.0f,
                    fmaxf(0.0f, c_old * (1.0f - a) + c_new * a + 0.5f));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Gather a dense sub-volume from the hash map, for meshing.
//
// Includes a one-voxel halo so marching cubes produces watertight seams between
// adjacent tiles instead of cracks.
// ---------------------------------------------------------------------------
extern "C" __global__ void gather_dense(
    const u64* __restrict__ table_keys,
    const int* __restrict__ table_vals,
    int table_size,
    const __half* __restrict__ tsdf,
    const __half* __restrict__ wsum,
    const unsigned char* __restrict__ rgb,
    int block_size,
    int ox, int oy, int oz,               // origin in voxel units
    int nx, int ny, int nz,               // dense extent in voxels
    float* __restrict__ out_tsdf,
    float* __restrict__ out_weight,
    unsigned char* __restrict__ out_rgb)
{
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    int total = nx * ny * nz;
    if (tid >= total) return;

    int iz =  tid / (nx * ny);
    int rem = tid - iz * nx * ny;
    int iy =  rem / nx;
    int ix =  rem - iy * nx;

    int gx = ox + ix, gy = oy + iy, gz = oz + iz;
    int bx = (int)floorf((float)gx / (float)block_size);
    int by = (int)floorf((float)gy / (float)block_size);
    int bz = (int)floorf((float)gz / (float)block_size);

    out_tsdf[tid] = 1.0f;      // unobserved reads as "outside the surface"
    out_weight[tid] = 0.0f;

    u64 key = pack_coord(bx, by, bz);
    u64 slot = hash_key(key) & (u64)(table_size - 1);
    int found = -1;
    for (int probe = 0; probe < table_size; ++probe) {
        u64 cur = table_keys[slot];
        if (cur == key) { found = table_vals[slot]; break; }
        if (cur == EMPTY_KEY) break;
        slot = (slot + 1) & (u64)(table_size - 1);
    }
    if (found < 0) return;

    int lx = gx - bx * block_size;
    int ly = gy - by * block_size;
    int lz = gz - bz * block_size;
    int vpb = block_size * block_size * block_size;
    int off = found * vpb + (lz * block_size * block_size + ly * block_size + lx);

    out_tsdf[tid]   = __half2float(tsdf[off]);
    out_weight[tid] = __half2float(wsum[off]);
    if (out_rgb) {
        out_rgb[tid*3+0] = rgb[off*3+0];
        out_rgb[tid*3+1] = rgb[off*3+1];
        out_rgb[tid*3+2] = rgb[off*3+2];
    }
}

__device__ __forceinline__ int find_block(
    const u64* __restrict__ table_keys, const int* __restrict__ table_vals,
    int table_size, int bx, int by, int bz)
{
    u64 key = pack_coord(bx, by, bz);
    u64 slot = hash_key(key) & (u64)(table_size - 1);
    for (int probe = 0; probe < table_size; ++probe) {
        u64 cur = table_keys[slot];
        if (cur == key) return table_vals[slot];
        if (cur == EMPTY_KEY) return -1;
        slot = (slot + 1) & (u64)(table_size - 1);
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Export the surface directly as an oriented point cloud.
//
// Every voxel adjacent to a zero crossing emits one point, positioned by linear
// interpolation of the TSDF along each axis. Cheaper than meshing and the right
// output when a point cloud is what is wanted.
// ---------------------------------------------------------------------------
extern "C" __global__ void extract_surface_points(
    const int* __restrict__ block_coords,
    const int* __restrict__ block_index,
    int n_blocks, int block_size,
    const __half* __restrict__ tsdf,
    const __half* __restrict__ wsum,
    const unsigned char* __restrict__ rgb,
    const u64* __restrict__ table_keys,
    const int* __restrict__ table_vals,
    int table_size,
    float voxel_size, float min_weight,
    float* __restrict__ out_xyz,
    unsigned char* __restrict__ out_rgb,
    int* __restrict__ out_count,
    int max_points)
{
    int b = blockIdx.x;
    if (b >= n_blocks) return;
    int slot = block_index[b];
    if (slot < 0) return;
    int vpb = block_size * block_size * block_size;

    for (int lin = threadIdx.x; lin < vpb; lin += blockDim.x) {
        int lz =  lin / (block_size * block_size);
        int rem = lin - lz * block_size * block_size;
        int ly =  rem / block_size;
        int lx =  rem - ly * block_size;

        int off = slot * vpb + lin;
        float w = __half2float(wsum[off]);
        if (w < min_weight) continue;
        float t = __half2float(tsdf[off]);

        // A sign change to the +x/+y/+z neighbour is the surface test. There is
        // deliberately no |tsdf| gate: a crossing between t=0.7 and t=-0.2 is a
        // real surface, and filtering on magnitude drops it.
        //
        // Neighbours outside this block are resolved through the hash table.
        // Skipping them instead would silently drop every voxel on a block face
        // -- about a third of the surface, showing up as a lattice of holes.
        float shift[3] = {0.0f, 0.0f, 0.0f};
        int steps[3] = {1, block_size, block_size * block_size};
        int lc[3] = {lx, ly, lz};
        bool crossed = false;
        for (int a = 0; a < 3; ++a) {
            int noff;
            if (lc[a] + 1 < block_size) {
                noff = off + steps[a];
            } else {
                int nb[3] = {block_coords[b*3+0], block_coords[b*3+1], block_coords[b*3+2]};
                nb[a] += 1;
                int nslot = find_block(table_keys, table_vals, table_size, nb[0], nb[1], nb[2]);
                if (nslot < 0) continue;
                // Same local index with axis `a` wrapped to 0 in the next block.
                int nl[3] = {lx, ly, lz};
                nl[a] = 0;
                noff = nslot * vpb + (nl[2]*block_size*block_size + nl[1]*block_size + nl[0]);
            }
            float wn = __half2float(wsum[noff]);
            if (wn < min_weight) continue;
            float tn = __half2float(tsdf[noff]);
            if (t * tn < 0.0f) {
                shift[a] = t / (t - tn);
                crossed = true;
            }
        }
        if (!crossed) continue;

        int idx = atomicAdd(out_count, 1);
        if (idx >= max_points) return;

        out_xyz[idx*3+0] = ((float)(block_coords[b*3+0]*block_size + lx) + 0.5f + shift[0]) * voxel_size;
        out_xyz[idx*3+1] = ((float)(block_coords[b*3+1]*block_size + ly) + 0.5f + shift[1]) * voxel_size;
        out_xyz[idx*3+2] = ((float)(block_coords[b*3+2]*block_size + lz) + 0.5f + shift[2]) * voxel_size;
        out_rgb[idx*3+0] = rgb[off*3+0];
        out_rgb[idx*3+1] = rgb[off*3+1];
        out_rgb[idx*3+2] = rgb[off*3+2];
    }
}
