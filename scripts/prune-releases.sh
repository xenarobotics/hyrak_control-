#!/usr/bin/env bash
# Prune releases/: keep only the installers the electron-updater manifests
# (releases/latest*.yml) point at, plus every file of ONE previous version,
# plus the manifests themselves. Everything else (13 GB of historical
# installers at the time of writing, served publicly at /releases) goes.
#
#   ./scripts/prune-releases.sh              dry run: prints what WOULD be deleted
#   ./scripts/prune-releases.sh --apply      actually delete
#   ./scripts/prune-releases.sh --dir PATH   another releases folder
#                                            (default <repo>/releases, or
#                                            RELEASES_DIR from the environment)
#
# "One previous version" = the highest version number present on disk that
# is lower than the lowest version any manifest references, so a rollback
# target survives for every platform. Files whose name carries no version
# (the .gitkeep, the manifests) are always kept.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${RELEASES_DIR:-$ROOT/releases}"
APPLY=0
while [ $# -gt 0 ]; do
    case "$1" in
        --apply) APPLY=1 ;;
        --dir) DIR="$2"; shift ;;
        -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option $1 (see --help)" >&2; exit 1 ;;
    esac
    shift
done
[ -d "$DIR" ] || { echo "no such directory: $DIR" >&2; exit 1; }
cd "$DIR" || exit 1

vercmp() {  # a b -> 0 if a < b (numeric, dotted)
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ] && [ "$1" != "$2" ]
}
version_of() {  # filename -> x.y.z or empty
    grep -oE '[0-9]+\.[0-9]+\.[0-9]+' <<<"$1" | head -1
}

# 1. Files the manifests reference (url: and path: lines) and their blockmaps.
declare -A KEEP
manifests=$(ls latest*.yml 2>/dev/null || true)
if [ -z "$manifests" ]; then
    echo "no latest*.yml in $DIR: nothing is published, refusing to guess what to keep" >&2
    exit 1
fi
lowest_latest=""
for m in $manifests; do
    KEEP["$m"]=manifest
    for f in $(grep -oE '^\s*(- url|path):\s*\S+' "$m" | awk '{print $NF}'); do
        KEEP["$f"]="$m"
        KEEP["$f.blockmap"]="$m"
        v=$(version_of "$f")
        if [ -n "$v" ] && { [ -z "$lowest_latest" ] || vercmp "$v" "$lowest_latest"; }; then lowest_latest="$v"; fi
    done
done

# 2. The previous version: highest on disk below the lowest published one.
prev=""
for f in *; do
    v=$(version_of "$f"); [ -n "$v" ] || continue
    if [ -n "$lowest_latest" ] && vercmp "$v" "$lowest_latest"; then
        if [ -z "$prev" ] || vercmp "$prev" "$v"; then prev="$v"; fi
    fi
done
if [ -n "$prev" ]; then
    for f in *; do
        [ "$(version_of "$f")" = "$prev" ] && [ -z "${KEEP[$f]:-}" ] && KEEP["$f"]="previous $prev"
    done
fi

# 3. Everything else with a version in its name is a candidate.
echo "releases folder: $DIR"
echo "published:       ${lowest_latest:-?} (from: $(echo $manifests | tr '\n' ' '))"
echo "kept previous:   ${prev:-none found}"
echo
echo "KEEP:"
for f in $(printf '%s\n' "${!KEEP[@]}" | sort -V); do
    [ -e "$f" ] && printf '  %-40s %8s MB  (%s)\n' "$f" "$(( $(stat -c %s "$f") / 1048576 ))" "${KEEP[$f]}"
done
echo
total=0; n=0; del=()
for f in *; do
    [ -f "$f" ] || continue
    [ -n "${KEEP[$f]:-}" ] && continue
    [ -n "$(version_of "$f")" ] || { echo "  leaving unversioned file $f"; continue; }
    del+=("$f"); n=$((n + 1)); total=$((total + $(stat -c %s "$f")))
done
if [ $APPLY = 1 ]; then echo "DELETING ($n files, $((total / 1048576)) MB):"; else echo "WOULD DELETE ($n files, $((total / 1048576)) MB; rerun with --apply):"; fi
for f in "${del[@]:-}"; do
    [ -n "$f" ] || continue
    printf '  %s\n' "$f"
    [ $APPLY = 1 ] && rm -f -- "$f"
done
[ $APPLY = 1 ] && echo "done" || true
