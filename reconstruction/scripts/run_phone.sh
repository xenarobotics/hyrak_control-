#!/usr/bin/env bash
# Waits for the DroidCam loopback to deliver real frames, then starts a
# DA3 reconstruction session. The phone app suspends whenever it is
# backgrounded, so start this FIRST, then wake the app; the run begins
# the moment video flows.
set -u
cd "$(dirname "$0")/.."
DEV="${1:-/dev/video0}"
export PATH="$PWD/.venv/bin:$PATH"

echo "waiting for a live feed on $DEV (open the DroidCam app now, keep it foreground)..."
while true; do
  # a real feed has non-zero contrast; the placeholder is a frozen black frame
  stats=$(timeout 8 ffmpeg -f v4l2 -i "$DEV" -frames:v 3 -vf signalstats -f null - 2>&1 \
          | grep -o 'YAVG:[0-9.]*' | tail -1 | cut -d: -f2)
  if [ -n "${stats:-}" ] && awk "BEGIN{exit !($stats > 2)}"; then
    echo "feed is live (luma $stats); starting pipeline"
    break
  fi
  sleep 2
done

exec .venv/bin/python -m dronemap.cli run \
  --source v4l2 --uri "$DEV" --session phone --out data/sessions \
  --set camera.width=640 --set camera.height=480 --set camera.hfov_deg=65 \
  --set source.track_width=640 --set source.track_height=480 \
  --set source.stall_timeout_s=30 \
  --set depth.backend=da3 --set depth.model=depth-anything/DA3METRIC-LARGE \
  --set depth.input_size=504 --set depth.max_depth_m=10.0 \
  --set fusion.voxel_size_m=0.02 --set fusion.max_integration_depth_m=6.0 \
  --set fusion.max_vram_gb=2.5 --set keyframe.track_ratio=0.5 \
  --set pipeline.queue_keyframes=16 \
  --set export.formats=[ply,obj,glb,stl] --set export.save_keyframes=true \
  --set viz.backend=rerun --set viz.spawn_viewer=true
