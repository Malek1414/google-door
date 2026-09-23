// Pure. Snap a GPS fix to the nearest footway segment.
//
// CONTRACT GAP: docs/CONTRACT.md v1 ships no footway graph. Until a contract PR adds
// one, callers pass an empty graph and the fix passes through unchanged (snapped: false).
// The algorithm is here and tested so wiring in a graph later is a data change only.

import type { LatLon } from './geo'

export interface Segment {
  a: LatLon
  b: LatLon
}

export interface MatchResult {
  pos: LatLon
  snapped: boolean
  offsetM: number // distance moved by the snap, 0 when unsnapped
}

export const DEFAULT_MAX_SNAP_M = 15

const M_PER_DEG_LAT = 111_320

/** Local equirectangular projection around `ref`, metres. Accurate to cm at city scale. */
function toXY(p: LatLon, ref: LatLon): [number, number] {
  const k = Math.cos((ref.lat * Math.PI) / 180) * M_PER_DEG_LAT
  return [(p.lon - ref.lon) * k, (p.lat - ref.lat) * M_PER_DEG_LAT]
}

function fromXY(x: number, y: number, ref: LatLon): LatLon {
  const k = Math.cos((ref.lat * Math.PI) / 180) * M_PER_DEG_LAT
  return { lat: ref.lat + y / M_PER_DEG_LAT, lon: ref.lon + x / k }
}

export function snapToGraph(p: LatLon, graph: Segment[], maxSnapM = DEFAULT_MAX_SNAP_M): MatchResult {
  let best: { x: number; y: number; d: number } | null = null
  for (const s of graph) {
    const [ax, ay] = toXY(s.a, p)
    const [bx, by] = toXY(s.b, p)
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
    const x = ax + t * dx
    const y = ay + t * dy
    const d = Math.hypot(x, y)
    if (!best || d < best.d) best = { x, y, d }
  }
  if (!best || best.d > maxSnapM) return { pos: p, snapped: false, offsetM: 0 }
  return { pos: fromXY(best.x, best.y, p), snapped: true, offsetM: best.d }
}
