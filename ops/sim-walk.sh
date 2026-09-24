#!/usr/bin/env bash
# Walk the iOS simulator from A to B so Doorway's navigation follows a moving position.
#
#   ops/sim-walk.sh [--dry-run] <fromLat,fromLng> <toLat,toLng> [speed m/s, default 1.4]
#   ops/sim-walk.sh [--dry-run] stop
#
# The path comes from the local backend (POST /api/route, server/route.py). If that fails,
# for example because the local Maps key is one the Routes API rejects, it walks a straight
# line with a waypoint every 5 m. The points are written to $POINTS_FILE (default
# /tmp/doorway-sim-walk.txt), then handed to `xcrun simctl location start`.
# --dry-run prints the simctl command instead of running it.
set -euo pipefail

SIM="${SIM_UDID:-3AD3A463-E5B5-46BD-BB4B-E9AA16F6C2C2}"
API="${API:-http://127.0.0.1:8080}"
POINTS_FILE="${POINTS_FILE:-${TMPDIR:-/tmp}/doorway-sim-walk.txt}"

DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY=1; shift; fi

run() {
  if [[ $DRY == 1 ]]; then printf '%q ' "$@"; echo; else "$@"; fi
}

usage() { sed -n '4,5p' "$0" | sed 's/^# //' >&2; exit 2; }

[[ $# -ge 1 ]] || usage
if [[ "$1" == "stop" ]]; then
  run xcrun simctl location "$SIM" clear
  exit 0
fi
[[ $# -ge 2 ]] || usage

FROM="$1"; TO="$2"; SPEED="${3:-1.4}"
num='^-?[0-9]+(\.[0-9]+)?$'
IFS=, read -r FLAT FLNG <<<"$FROM"
IFS=, read -r TLAT TLNG <<<"$TO"
for v in "$FLAT" "$FLNG" "$TLAT" "$TLNG" "$SPEED"; do
  [[ "$v" =~ $num ]] || { echo "not a number: $v" >&2; usage; }
done

ROUTE_JSON=""
if [[ -z "${NO_ROUTE:-}" ]]; then
  ROUTE_JSON="$(curl -sf -m 10 -X POST "$API/api/route" -H 'content-type: application/json' \
    -d "{\"fromLat\":$FLAT,\"fromLon\":$FLNG,\"toLat\":$TLAT,\"toLon\":$TLNG}" 2>/dev/null || true)"
fi

# One "lat,lng" per line: the route's polyline, else a straight line every 5 m.
ROUTE_JSON="$ROUTE_JSON" python3 - "$FLAT" "$FLNG" "$TLAT" "$TLNG" >"$POINTS_FILE" <<'PY'
import json, math, os, sys
flat, flng, tlat, tlng = map(float, sys.argv[1:5])
pts = []
try:
    data = json.loads(os.environ.get("ROUTE_JSON") or "{}")
    if data.get("found") and len(data.get("path") or []) >= 2:
        pts = [(float(a), float(b)) for a, b in data["path"]]
        print("route: Routes API path", file=sys.stderr)
except Exception:
    pts = []
if not pts:
    m_lat = 111_195.0
    m_lng = m_lat * math.cos(math.radians((flat + tlat) / 2))
    dist = math.hypot((tlat - flat) * m_lat, (tlng - flng) * m_lng)
    n = max(1, math.ceil(dist / 5))
    pts = [(flat + (tlat - flat) * i / n, flng + (tlng - flng) * i / n) for i in range(n + 1)]
    print(f"route: straight line, {dist:.0f} m, {len(pts)} points", file=sys.stderr)
for a, b in pts:
    print(f"{a:.7f},{b:.7f}")
PY

POINTS=()
while IFS= read -r line; do POINTS+=("$line"); done <"$POINTS_FILE"
echo "points: ${#POINTS[@]} in $POINTS_FILE" >&2
run xcrun simctl location "$SIM" start --speed="$SPEED" "${POINTS[@]}"
