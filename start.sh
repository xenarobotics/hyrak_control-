#!/usr/bin/env bash
# HYRAK launcher: backend (:8001) + frontend (:3000) + Cloudflare tunnel.
#
#   ./start.sh               start everything. This terminal shows ONE tidy
#                            feed: a startup checklist, then only what matters
#                            (errors, warnings, drone links, reloads, tunnel
#                            health). Every line of every service still lands
#                            in .logs/<service>.log.
#   ./start.sh --tabs        ... and open one terminal tab per service with
#                            its full log (gnome-terminal)
#   ./start.sh --prod        serve a PRODUCTION frontend build (next build +
#                            next start): minified and cacheable - much
#                            faster through the tunnel and the desktop app.
#                            No hot reload: rerun to pick up frontend edits.
#   ./start.sh --no-tunnel   local only
#   ./start.sh logs <backend|frontend|tunnel|events>   one service's full log
#   ./start.sh status        what is up, and how healthy the tunnel is
#
# Ctrl+C stops everything.
#
# TUNNEL WATCHDOG. cloudflared keeps 4 connections to Cloudflare; when one
# degrades, every request that lands on it stalls ~23-30 s while the others
# answer in <1 s (measured 2026-09-28: 4 of 8 requests stalled, the same
# files load locally in 2 ms). A dev page fetches ~30 files, so nearly every
# load hit a stall - "the app takes forever to load". Every 60 s the launcher
# probes the public URL; if requests stall twice in a row it restarts
# cloudflared (new connections), at most once per 5 minutes.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
LOG_DIR="$ROOT_DIR/.logs"
RUN_DIR="$LOG_DIR/.run"
PUBLIC_URL="https://dev.xenarobotics.com"
TUNNEL_NAME="xenaview"
mkdir -p "$LOG_DIR" "$RUN_DIR"
export PATH="$HOME/.local/bin:$PATH"

# -- look -------------------------------------------------------------------
if [ -t 1 ]; then
    B=$'\e[1m'; D=$'\e[2m'; R=$'\e[0m'; RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'
    CYA=$'\e[36m'; MAG=$'\e[35m'
else
    B='' D='' R='' RED='' GRN='' YEL='' CYA='' MAG=''
fi
ts() { date +%H:%M:%S; }
say() {  # service colour message
    local svc=$1 col=$2; shift 2
    printf '%s %s%-8s%s %s\n' "${D}$(ts)${R}" "$col" "$svc" "$R" "$*"
    printf '%s %-8s %s\n' "$(ts)" "$svc" "$*" >> "$LOG_DIR/events.log"
}
ok()   { say "$1" "$GRN" "${GRN}ok${R}  ${*:2}"; }
warn() { say "$1" "$YEL" "${YEL}${*:2}${R}"; }
bad()  { say "$1" "$RED" "${RED}${*:2}${R}"; }

# -- subcommands --------------------------------------------------------------
probe_tunnel() {  # prints "<stalled> <total> <slowest_s>"
    local stalled=0 slow=0 t i
    for i in 1 2 3 4; do
        t=$(curl -s -o /dev/null -m 8 -w '%{time_total}' "$PUBLIC_URL/favicon.ico?probe=$RANDOM$i" 2>/dev/null || echo 8)
        awk -v t="$t" 'BEGIN{exit !(t >= 3)}' && stalled=$((stalled + 1))
        slow=$(awk -v a="$slow" -v b="$t" 'BEGIN{print (b > a) ? b : a}')
    done
    echo "$stalled 4 $slow"
}

if [ "${1:-}" = "logs" ]; then
    f="${2:-events}"; [ "$f" = "tunnel" ] && f=cloudflared
    exec tail -n 200 -F "$LOG_DIR/$f.log"
fi
if [ "${1:-}" = "status" ]; then
    for s in "backend http://127.0.0.1:8001/api/fleet" "frontend http://127.0.0.1:3000/"; do
        set -- $s
        c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$2")
        [ "$c" = 200 ] && echo "${GRN}up${R}    $1" || echo "${RED}down${R}  $1 ($c)"
    done
    read -r st tot slow <<<"$(probe_tunnel)"
    [ "$st" = 0 ] && echo "${GRN}up${R}    tunnel  ($PUBLIC_URL, slowest ${slow}s)" \
                  || echo "${YEL}slow${R}  tunnel  ($st of $tot requests stalled, slowest ${slow}s)"
    exit 0
fi

TABS=0; PROD=0; TUNNEL=1
for a in "$@"; do
    case "$a" in
        --tabs) TABS=1 ;; --prod) PROD=1 ;; --no-tunnel) TUNNEL=0 ;;
        -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option $a (see ./start.sh --help)"; exit 1 ;;
    esac
done

# -- process housekeeping -------------------------------------------------------
free_port() {
    # EVERY owner of the port, not the first one ss prints: uvicorn's reloader
    # parent and its worker share the listening socket, and after a code
    # reload the worker can be a zombie - ss lists the zombie, kill -9 on a
    # zombie does nothing, the parent keeps the port, and the next start dies
    # with "Address already in use" while the app looks up (it is wedged).
    # A zombie's PARENT is what actually holds the socket, so kill that.
    # `ss -p` walks every process's fds and has hung for minutes on this
    # machine: bounded, and fuser as the fallback.
    local port="$1" pids pid ppid state i
    pids=$(timeout 5 ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$"' | grep -oP 'pid=\K[0-9]+' | sort -u)
    [ -z "$pids" ] && pids=$(timeout 5 fuser -n tcp "$port" 2>/dev/null)
    for pid in $pids; do
        state=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')
        if [[ "$state" == Z* ]]; then
            ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
            warn launcher "port $port held by zombie $pid - stopping its parent $ppid"
            [[ -n "$ppid" && "$ppid" != 1 ]] && kill -9 "$ppid" 2>/dev/null
        else
            warn launcher "port $port in use by $pid - stopping it"
            kill -9 "$pid" 2>/dev/null
        fi
    done
    for i in $(seq 1 10); do
        curl -s -o /dev/null -m 1 "http://127.0.0.1:$port/" || return 0
        sleep 0.5
    done
    bad launcher "port $port still busy after 5 s"
}
kill_mavsdk()      { pkill -TERM -f mavsdk_server 2>/dev/null && sleep 0.5 || true; }
kill_cloudflared() { pkill -TERM -f "cloudflared tunnel run" 2>/dev/null && sleep 0.5 || true; }

PIDS=()
cleanup() {
    trap - EXIT INT TERM
    echo ""
    say launcher "$B" "stopping..."
    touch "$RUN_DIR/stopping"
    for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
    kill_cloudflared
    wait 2>/dev/null
    kill_mavsdk
    rm -f "$RUN_DIR/stopping" "$RUN_DIR/cloudflared.pid"
    say launcher "$B" "stopped"
    exit 0
}
trap cleanup EXIT INT TERM

# -- the tidy feed: one filtered stream per service ----------------------------
# What reaches this terminal. Everything else stays in .logs/<svc>.log.
feed_backend() {
    tail -n 0 -F "$LOG_DIR/backend.log" 2>/dev/null | while IFS= read -r l; do
        case "$l" in
            *'"GET '*|*'"POST '*|*'"OPTIONS '*|*'"PUT '*|*'"DELETE '*)
                # access log: only failures
                [[ "$l" =~ \"\ ([45][0-9][0-9])\  ]] && say backend "$RED" "${l#*- }" ;;
            *'Connection timed out at udpin'*) ;;   # fleet scanner probing empty SITL ports
            *Traceback*|*Error*|*ERROR*|*CRITICAL*|*Exception*) say backend "$RED" "${RED}${l#*| ERROR    | }${R}" ;;
            *WARNING*) [[ "$l" == *"libprotobuf"* ]] || say backend "$CYA" "${YEL}${l#*| WARNING  | }${R}" ;;
            *'Application startup complete'*|*Reloading*|*'Drone connected'*|*'Telemetry live'*|\
            *'LINK LOST'*|*'LINK RESTORED'*|*'disconnected'*|*'Disconnected'*|*'DepthMapper using'*|\
            *'Vision modules ready'*|*'Avoidance:'*|*'mission resumed'*|*'failsafe'*|*'ready on CUDA'*)
                say backend "$CYA" "${l#*| INFO     | }" ;;
        esac
    done
}
feed_frontend() {
    tail -n 0 -F "$LOG_DIR/frontend.log" 2>/dev/null | while IFS= read -r l; do
        case "$l" in
            *' GET '*' 200 '*|*' GET '*' 304 '*|*' POST '*' 200 '*) ;;            # routine requests
            *' GET '*|*' POST '*) say frontend "$RED" "$l" ;;                    # 4xx / 5xx
            *Ready*|*Compiled*|*'Creating an optimized'*|*'Route (app)'*) say frontend "$MAG" "$l" ;;
            *rror*|*Failed*|*'⨯'*|*'⚠'*|*warn*) say frontend "$RED" "$l" ;;
        esac
    done
}
feed_tunnel() {
    tail -n 0 -F "$LOG_DIR/cloudflared.log" 2>/dev/null | while IFS= read -r l; do
        case "$l" in
            *'Registered tunnel connection'*)
                loc=$(grep -oP 'location=\K\S+' <<<"$l"); idx=$(grep -oP 'connIndex=\K\d+' <<<"$l")
                say tunnel "$YEL" "connection $idx up ($loc)" ;;
            *' ERR '*|*'Unregistered'*|*'Retrying'*) say tunnel "$YEL" "${YEL}${l#* }${R}" ;;
        esac
    done
}

# -- tunnel: supervised (restarted when it exits) + watchdog -------------------
tunnel_supervisor() {
    while [ ! -f "$RUN_DIR/stopping" ]; do
        cloudflared tunnel run --protocol http2 "$TUNNEL_NAME" >> "$LOG_DIR/cloudflared.log" 2>&1 &
        echo $! > "$RUN_DIR/cloudflared.pid"
        wait $!
        [ -f "$RUN_DIR/stopping" ] && break
        warn tunnel "cloudflared exited - restarting in 3 s"
        sleep 3
    done
}
tunnel_watchdog() {
    local strikes=0 last_restart=0 st tot slow now
    sleep 45
    while [ ! -f "$RUN_DIR/stopping" ]; do
        read -r st tot slow <<<"$(probe_tunnel)"
        if [ "$st" -gt 0 ]; then
            strikes=$((strikes + 1))
            warn tunnel "$st of $tot requests stalled (slowest ${slow}s)"
            now=$(date +%s)
            if [ "$strikes" -ge 2 ] && [ $((now - last_restart)) -gt 300 ]; then
                warn tunnel "reconnecting the tunnel (new connections to Cloudflare)"
                kill "$(cat "$RUN_DIR/cloudflared.pid" 2>/dev/null)" 2>/dev/null
                last_restart=$now; strikes=0
            fi
        else
            [ "$strikes" -gt 0 ] && ok tunnel "healthy again (slowest ${slow}s)"
            strikes=0
        fi
        sleep 60
    done
}

wait_http() {  # name url timeout_s -> prints ready time
    local t0=$SECONDS
    while [ $((SECONDS - t0)) -lt "$3" ]; do
        [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$2")" = 200 ] && { ok "$1" "ready in $((SECONDS - t0)) s"; return 0; }
        sleep 1
    done
    bad "$1" "not answering after $3 s - see ./start.sh logs $1"
    return 1
}

# -- go -----------------------------------------------------------------------
clear 2>/dev/null
printf '%s\n' "${B}HYRAK${R}  ${D}$( [ $PROD = 1 ] && echo production || echo development ) - backend :8001  frontend :3000$( [ $TUNNEL = 1 ] && echo "  tunnel $PUBLIC_URL")${R}"
printf '%s\n\n' "${D}full logs: ./start.sh logs backend|frontend|tunnel     health: ./start.sh status     stop: Ctrl+C${R}"
: > "$LOG_DIR/events.log"
rm -f "$RUN_DIR/stopping"

free_port 8001
free_port 3000
kill_mavsdk
[ $TUNNEL = 1 ] && kill_cloudflared

feed_backend & PIDS+=($!)
feed_frontend & PIDS+=($!)

say backend "$CYA" "starting (FastAPI)"
(cd "$BACKEND_DIR" && exec uv run python -m app.main) >> "$LOG_DIR/backend.log" 2>&1 & PIDS+=($!)

if [ $PROD = 1 ]; then
    say frontend "$MAG" "building production bundle (1-3 min)..."
    if ! (cd "$FRONTEND_DIR" && npm run build) > "$LOG_DIR/frontend-build.log" 2>&1; then
        bad frontend "build failed - last lines:"
        tail -n 25 "$LOG_DIR/frontend-build.log"
        exit 1
    fi
    ok frontend "built"
    (cd "$FRONTEND_DIR" && exec npm run start -- -p 3000) >> "$LOG_DIR/frontend.log" 2>&1 & PIDS+=($!)
else
    say frontend "$MAG" "starting (Next.js dev, hot reload)"
    (cd "$FRONTEND_DIR" && exec npm run dev) >> "$LOG_DIR/frontend.log" 2>&1 & PIDS+=($!)
fi

if [ $TUNNEL = 1 ]; then
    feed_tunnel & PIDS+=($!)
    say tunnel "$YEL" "starting ($TUNNEL_NAME)"
    tunnel_supervisor & PIDS+=($!)
fi

wait_http backend "http://127.0.0.1:8001/api/fleet" 90
wait_http frontend "http://127.0.0.1:3000/" 120
if [ $TUNNEL = 1 ]; then
    read -r st tot slow <<<"$(probe_tunnel)"
    [ "$st" = 0 ] && ok tunnel "$PUBLIC_URL (slowest ${slow}s)" \
                  || warn tunnel "$st of $tot requests stalled - the watchdog will reconnect if it persists"
    tunnel_watchdog & PIDS+=($!)
fi

if [ $TABS = 1 ]; then
    if command -v gnome-terminal >/dev/null && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        # One call per tab: the first opens a window, the rest join it.
        gnome-terminal --window --title "HYRAK backend" -- "$ROOT_DIR/start.sh" logs backend >/dev/null 2>&1 \
            && sleep 0.5 \
            && gnome-terminal --tab --title "HYRAK frontend" -- "$ROOT_DIR/start.sh" logs frontend >/dev/null 2>&1 \
            && gnome-terminal --tab --title "HYRAK tunnel" -- "$ROOT_DIR/start.sh" logs tunnel >/dev/null 2>&1 \
            && ok launcher "opened log tabs" || warn launcher "could not open terminal tabs"
    else
        warn launcher "--tabs needs a desktop session with gnome-terminal"
    fi
fi

echo ""
say launcher "$GRN" "${GRN}${B}all up${R}  ${D}- only notable events show below${R}"
wait
