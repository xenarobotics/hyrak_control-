#!/usr/bin/env bash
# One-click launcher for the Verocore Platform (backend + frontend).
# Usage: ./start.sh
# Stop with Ctrl+C — both processes are cleaned up automatically.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
LOG_DIR="$ROOT_DIR/.logs"
mkdir -p "$LOG_DIR"

export PATH="$HOME/.local/bin:$PATH"

PIDS=()

free_port() {
    local port="$1"
    local pid
    pid=$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $0}' | grep -oP 'pid=\K[0-9]+' | head -1)
    if [[ -n "${pid:-}" ]]; then
        echo "Port $port is in use by PID $pid — stopping it..."
        kill -9 "$pid" 2>/dev/null
        sleep 0.5
    fi
}

kill_mavsdk() {
    pkill -TERM -f mavsdk_server 2>/dev/null && sleep 0.5 || true
}

kill_cloudflared() {
    pkill -TERM -f "cloudflared tunnel run" 2>/dev/null && sleep 0.5 || true
}

cleanup() {
    echo ""
    echo "Stopping Verocore Platform..."
    for pid in "${PIDS[@]:-}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null
        fi
    done
    wait 2>/dev/null
    kill_mavsdk
    kill_cloudflared
    echo "Stopped."
}
trap cleanup EXIT INT TERM

free_port 8001
free_port 3000
kill_mavsdk
kill_cloudflared

echo "Starting backend (FastAPI on :8001)..."
(cd "$BACKEND_DIR" && uv run python -m app.main) > "$LOG_DIR/backend.log" 2>&1 &
PIDS+=($!)

echo "Starting frontend (Next.js on :3000)..."
(cd "$FRONTEND_DIR" && npm run dev) > "$LOG_DIR/frontend.log" 2>&1 &
PIDS+=($!)

echo "Starting Cloudflare tunnel (xenaview)..."
cloudflared tunnel run --protocol http2 xenaview > "$LOG_DIR/cloudflared.log" 2>&1 &
PIDS+=($!)

sleep 2
echo ""
echo "=========================================="
echo " Verocore Platform"
echo "  Backend:  http://localhost:8001"
echo "  Frontend: http://localhost:3000"
echo "  Tunnel:   https://dev.xenarobotics.com"
echo "  Logs:     $LOG_DIR/backend.log"
echo "            $LOG_DIR/frontend.log"
echo "            $LOG_DIR/cloudflared.log"
echo "  Press Ctrl+C to stop all"
echo "=========================================="
echo ""

tail -f "$LOG_DIR/backend.log" "$LOG_DIR/frontend.log" "$LOG_DIR/cloudflared.log"
