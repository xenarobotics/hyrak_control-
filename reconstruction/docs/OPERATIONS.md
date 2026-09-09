# Operations — the whole project on one page

## The two ways to make a 3D model

|                      | LIVE (SLAM)                          | OFFLINE (photogrammetry)              |
|----------------------|--------------------------------------|---------------------------------------|
| What it is           | Tracks the camera and fuses a dense colored mesh **while you move** | Records a clip, then reconstructs it **afterwards** |
| Speed                | Real time (watch it grow)            | ~1–2 min processing per minute of video |
| Accuracy             | Good; depends on smooth motion       | Best possible from the same footage   |
| Output               | `data/sessions/<time>_<name>/` — mesh (PLY/OBJ/GLB/STL) + point cloud + keyframes | `data/photogrammetry/<name>/` — sparse + dense cloud, mesh (PLY/GLB/STL) |
| Use it for           | Drone missions, instant feedback     | Highest quality, object scans → STL   |

They share everything underneath (DA3 depth, CUDA TSDF fusion, exports); the
live session even saves its keyframes so any session can be re-processed
offline later.

## Launching the application

```bash
./dronemap.sh
```

Starts the server if needed and opens the control panel as an app window.
Everything below happens inside that window: camera dropdown, live start/stop,
offline scans with progress, and download buttons for every result. The
commands in the next sections are the equivalent terminal routes.

## Running LIVE (terminal route)

```bash
.venv/bin/python -m dronemap.cli run --serve -c configs/brio_live.yaml
```

Then open **http://localhost:8088** — that page is mission control:
Start / Stop & export buttons, tracking state, keyframe count, camera FPS,
GPU memory, and the capture-quality bar (green = good motion, red = tracking
lost → slow down). Nothing else opens by default.

**Optional 3D view** (only when you want it): the session streams geometry
whether or not a viewer is attached. To watch, run `.venv/bin/rerun` and
connect to `rerun+http://127.0.0.1:9876/proxy`, or set
`viz.spawn_viewer: true` in the config to auto-open it.

## Running OFFLINE

```bash
# 1. record 60 s and check it connects (grades GOOD / PARTIAL / FRAGMENTED)
.venv/bin/python scripts/photoscan.py --device /dev/video5 --seconds 60

# 2. densify: dense colored cloud + mesh + STL
.venv/bin/python scripts/densify.py --scan data/photogrammetry/scan
```

## Viewing any result

```bash
# point cloud or mesh, any .ply:
.venv/bin/python -c "import open3d as o3d; o3d.visualization.draw_geometries([o3d.io.read_point_cloud('PATH.ply')])"
```

## The windows that can appear, and when

| Window                  | Opens when                          | Purpose |
|-------------------------|-------------------------------------|---------|
| Panel (browser, :8088)  | always, with `--serve`              | control + health; the only always-on UI |
| Rerun viewer            | only if you attach / spawn_viewer   | live 3D: image, trajectory, growing map |
| Open3D window           | only when you run a view command    | inspect a finished result |
| Terminal                | always                              | one PROGRESS line / 5 s; errors |

## Capture rules (both modes live or die by these)

1. Light the scene as brightly as the deployment allows.
2. Move at coffee-carrying speed; translate, don't pan.
3. Turn in small steps with pauses, or the frames blur.
4. Point at texture (furniture, shelves) not blank walls.
5. Finish where you started (closes the loop).
