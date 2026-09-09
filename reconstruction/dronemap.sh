#!/usr/bin/env bash
# DroneMap — one-click launcher.
# Starts the reconstruction server (if not already up) and opens the control
# panel as an app window. Everything — live SLAM, offline scans, downloads —
# happens inside that window.
set -u
cd "$(dirname "$0")"
export PATH="$PWD/.venv/bin:$PATH"
URL="http://127.0.0.1:8088/"

if ! curl -sf -m 1 "$URL/health" >/dev/null 2>&1; then
  echo "starting dronemap server..."
  nohup .venv/bin/python -m dronemap.cli run --serve -c configs/brio_live.yaml \
      > data/dronemap_server.log 2>&1 &
  for i in $(seq 1 40); do
    curl -sf -m 1 "${URL}health" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# app-mode window (no browser chrome) with whatever is installed
for b in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$b" >/dev/null 2>&1; then exec "$b" --app="$URL"; fi
done
exec xdg-open "$URL"
