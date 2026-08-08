#!/usr/bin/env bash
# Documentation drift checker for hyrak_control.
#
# REPORTS ONLY — it never rewrites documentation. The goal is to make a future
# session's doc-sync cheap: run this, and it tells you the few things that
# actually changed, instead of the model re-reading the whole project to
# rediscover them.
#
# Usage:
#   ./scripts/sync-docs.sh            # human-readable report
#   ./scripts/sync-docs.sh --brief    # compact, paste-into-a-prompt form
#
# Optional git hook (recommended — warns, never blocks):
#   printf '#!/bin/sh\n./scripts/sync-docs.sh --brief\nexit 0\n' \
#       > .git/hooks/pre-push && chmod +x .git/hooks/pre-push

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRIEF=0
[[ "${1:-}" == "--brief" ]] && BRIEF=1

ISSUES=0
note() { ISSUES=$((ISSUES+1)); echo "  ! $*"; }
head2() { [[ $BRIEF -eq 0 ]] && echo "" && echo "$*"; }

echo "docs drift report — $(date +%F)"

# ---------------------------------------------------------------- versions ---
head2 "VERSIONS"
DESKTOP_V=$(node -e "process.stdout.write(require('./desktop/package.json').version)" 2>/dev/null || echo "?")
MANIFEST_V=$(grep -oP '^\s+desktop:\s+"\K[^"]+' docs/PROJECT_MANIFEST.yaml 2>/dev/null || echo "?")
[[ $BRIEF -eq 0 ]] && echo "  desktop/package.json: $DESKTOP_V   manifest: $MANIFEST_V"
if [[ "$DESKTOP_V" != "$MANIFEST_V" ]]; then
    note "desktop version $DESKTOP_V != PROJECT_MANIFEST.yaml $MANIFEST_V"
fi
if ! grep -q "$DESKTOP_V" docs/CHANGELOG.md 2>/dev/null; then
    note "desktop $DESKTOP_V has no CHANGELOG.md entry"
fi

# ------------------------------------------------------------- session log ---
head2 "SESSION LOG"
TODAY=$(date +%F)
if [[ ! -f "docs/SESSION_LOGS/$TODAY.md" ]]; then
    note "no docs/SESSION_LOGS/$TODAY.md for today's work"
fi

# -------------------------------------------------------- untracked in git ---
head2 "UNTRACKED (risk: exists only on this disk)"
UNTRACKED=$(git status --porcelain 2>/dev/null | grep '^??' | awk '{print $2}')
if [[ -n "$UNTRACKED" ]]; then
    COUNT=$(echo "$UNTRACKED" | wc -l)
    [[ $BRIEF -eq 0 ]] && echo "$UNTRACKED" | sed 's/^/    /'
    note "$COUNT untracked path(s) — see KNOWN_ISSUES #7"
fi

# --------------------------------------------------- modified vs doc mtime ---
head2 "MODULE DOCS vs SOURCE"
check_module() {   # $1 = source dir/file, $2 = module doc dir
    local src="$1" doc="$2"
    [[ -e "$src" && -d "$doc" ]] || return 0
    local newest_src newest_doc
    newest_src=$(find "$src" -type f \( -name '*.ts' -o -name '*.py' -o -name '*.tsx' \) \
                 -newer "$doc/README.md" 2>/dev/null | head -5)
    if [[ -n "$newest_src" ]]; then
        note "$doc/README.md is older than sources in $src:"
        echo "$newest_src" | sed 's/^/      /'
    fi
}
check_module desktop/src/bridges          modules/desktop-bridges
check_module backend/app/webrtc           modules/backend-webrtc
check_module backend/app/telemetry        modules/backend-telemetry
check_module frontend/src/lib             modules/frontend-transport

# -------------------------------------------------------- required doc set ---
head2 "REQUIRED DOCS"
for f in AI_CONTEXT.md PROJECT_OVERVIEW.md ARCHITECTURE.md CURRENT_STATE.md \
         CHANGELOG.md PROJECT_MANIFEST.yaml SESSION_HANDOVER.md \
         KNOWN_ISSUES.md ROADMAP.md GLOSSARY.md CONTRIBUTING.md; do
    [[ -f "docs/$f" ]] || note "missing docs/$f"
done

# ------------------------------------------------------------ broken links ---
# Only checks links that point at a .md file or a modules/ dir — those are real
# paths. Prose links and URLs are skipped deliberately; checking everything
# produced more noise than signal.
head2 "INTERNAL LINKS"
while IFS=: read -r file target; do
    [[ -n "$target" ]] || continue
    dir="$(dirname "$file")"
    [[ -e "$dir/$target" || -e "$target" ]] || note "broken link in $file → $target"
done < <(
    grep -rEo '\]\(([A-Za-z0-9_./-]+\.md|[A-Za-z0-9_-]+/)\)' docs modules 2>/dev/null \
    | sed -E 's/\]\(//; s/\)$//'
)

# ------------------------------------------------------------- dead code -----
head2 "KNOWN DEAD CODE"
[[ -f sitl_relay/single_relay.py ]] && note "sitl_relay/single_relay.py still present (dead — KNOWN_ISSUES #10)"

# ------------------------------------------------- duplicated ffmpeg opts ----
head2 "FFMPEG OPTION DRIFT"
A=$(grep -c 'reorder_queue_size' backend/app/webrtc/udp_video_source.py 2>/dev/null || echo 0)
B=$(grep -c 'reorder_queue_size' desktop/src/bridges/airUnitVideoBridge.ts 2>/dev/null || echo 0)
if [[ "$A" -eq 0 || "$B" -eq 0 ]]; then
    note "low-latency ffmpeg option block missing from one of the two copies (KNOWN_ISSUES #9)"
fi

echo ""
if [[ $ISSUES -eq 0 ]]; then
    echo "OK — no documentation drift detected."
else
    echo "$ISSUES item(s) need attention. Update the docs listed above, then re-run."
fi
exit 0
