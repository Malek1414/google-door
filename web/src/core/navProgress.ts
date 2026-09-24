// Turn-by-turn progress along a walking route. Pure: no DOM, no Maps, no clock.
// Unit-tested in test/nav-progress.test.ts.

import type { Route } from './route'

/** Same shape as core/position.ts Fix (N2). Structural so this file stands alone. */
export interface NavFix {
  lat: number
  lng: number
  accuracy: number
  headingDeg: number | null
  speed: number | null
  t: number
}

export interface NavState {
  snapped: { lat: number; lng: number }
  stepIndex: number
  distToManeuverM: number
  remainingM: number
  etaS: number
  offRoute: boolean
  arrived: boolean
  /** Metres walked along the path at the snapped point. */
  alongM: number
  /** Bearing of the path at the snapped point, 0..360 true north. */
  bearingDeg: number
}

export const WALK_MPS = 1.3
export const MAX_BACKTRACK_M = 15
export const OFF_ROUTE_MIN_M = 25
export const ARRIVE_M = 15
export const ARRIVE_MAX_ACC_M = 25

const R = 6371008.8
const rad = (d: number) => (d * Math.PI) / 180

interface Geom {
  pts: { lat: number; lng: number }[]
  cum: number[]
  total: number
  stepEnds: number[]
}

/** Local metres around a reference latitude: good to centimetres over a walking route. */
function xy(lat: number, lng: number, lat0: number): [number, number] {
  return [rad(lng) * R * Math.cos(rad(lat0)), rad(lat) * R]
}

function segLen(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const [ax, ay] = xy(a.lat, a.lng, a.lat)
  const [bx, by] = xy(b.lat, b.lng, a.lat)
  return Math.hypot(bx - ax, by - ay)
}

interface Hit {
  seg: number
  along: number
  dist: number
}

function project(g: Geom, lat: number, lng: number, minAlong = -Infinity): Hit {
  let best: Hit | null = null
  for (let i = 0; i < g.pts.length - 1; i++) {
    const a = g.pts[i]!
    const b = g.pts[i + 1]!
    const [ax, ay] = xy(a.lat, a.lng, lat)
    const [bx, by] = xy(b.lat, b.lng, lat)
    const [px, py] = xy(lat, lng, lat)
    const dx = bx - ax
    const dy = by - ay
    const L2 = dx * dx + dy * dy
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0
    // Respect the floor inside the segment too, so a long segment is not skipped.
    const segStart = g.cum[i]!
    const segL = g.cum[i + 1]! - segStart
    if (segStart + segL < minAlong) continue
    if (segL > 0 && segStart + t * segL < minAlong) t = (minAlong - segStart) / segL
    t = Math.max(0, Math.min(1, t))
    const dist = Math.hypot(ax + t * dx - px, ay + t * dy - py)
    const along = segStart + t * segL
    if (!best || dist < best.dist - 1e-9) best = { seg: i, along, dist }
  }
  return best ?? { seg: 0, along: 0, dist: 0 }
}

function pointAt(g: Geom, along: number): { lat: number; lng: number; seg: number } {
  const a = Math.max(0, Math.min(g.total, along))
  let i = 0
  while (i < g.pts.length - 2 && g.cum[i + 1]! < a) i++
  const p = g.pts[i]!
  const q = g.pts[i + 1] ?? p
  const L = g.cum[i + 1]! - g.cum[i]!
  const t = L > 0 ? (a - g.cum[i]!) / L : 0
  return { lat: p.lat + (q.lat - p.lat) * t, lng: p.lng + (q.lng - p.lng) * t, seg: i }
}

function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const f1 = rad(a.lat)
  const f2 = rad(b.lat)
  const dl = rad(b.lng - a.lng)
  const y = Math.sin(dl) * Math.cos(f2)
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)
  const d = (Math.atan2(y, x) * 180) / Math.PI
  return (d + 360) % 360
}

const cache = new WeakMap<Route, Geom>()

/** Path geometry plus where along it each step ends. Cached per route object. */
export function geometry(route: Route): Geom {
  const hit = cache.get(route)
  if (hit) return hit
  const pts = route.path.map(([lat, lng]) => ({ lat, lng }))
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + segLen(pts[i - 1]!, pts[i]!))
  const total = cum.at(-1) ?? 0
  const g: Geom = { pts, cum, total, stepEnds: [] }
  let floor = 0
  let sum = 0
  for (const st of route.steps) {
    sum += st.distanceM ?? 0
    let end: number
    if (st.endLat != null && st.endLon != null && pts.length > 1) end = project(g, st.endLat, st.endLon, floor).along
    else end = Math.min(total, Math.max(floor, sum))
    end = Math.max(floor, end)
    g.stepEnds.push(end)
    floor = end
  }
  if (g.stepEnds.length === 0) g.stepEnds.push(total)
  g.stepEnds[g.stepEnds.length - 1] = total
  cache.set(route, g)
  return g
}

export function progress(route: Route, fix: NavFix, prev?: NavState): NavState {
  const g = geometry(route)
  const floor = prev ? prev.alongM - MAX_BACKTRACK_M : -Infinity
  const hit = project(g, fix.lat, fix.lng, floor)
  const along = Math.max(hit.along, floor, 0)
  const p = pointAt(g, along)
  const tol = Math.max(OFF_ROUTE_MIN_M, 1.5 * (fix.accuracy || 0))
  // Distance from the fix to the line itself (unconstrained), so a floor never fakes off-route.
  const free = project(g, fix.lat, fix.lng)
  const offRoute = g.pts.length > 1 && free.dist > tol

  let stepIndex = g.stepEnds.findIndex((e) => e > along + 0.5)
  if (stepIndex < 0) stepIndex = g.stepEnds.length - 1
  if (prev) stepIndex = Math.max(stepIndex, Math.min(prev.stepIndex, g.stepEnds.length - 1))
  const distToManeuverM = Math.max(0, g.stepEnds[stepIndex]! - along)
  const remainingM = Math.max(0, g.total - along)

  const dest = g.pts.at(-1) ?? { lat: fix.lat, lng: fix.lng }
  const toDest = segLen({ lat: fix.lat, lng: fix.lng }, dest)
  const arrived = (prev?.arrived ?? false) || (toDest <= ARRIVE_M && fix.accuracy <= ARRIVE_MAX_ACC_M)

  const a = g.pts[p.seg] ?? dest
  const b = g.pts[p.seg + 1] ?? a
  return {
    snapped: { lat: p.lat, lng: p.lng },
    stepIndex,
    distToManeuverM,
    remainingM,
    etaS: remainingM / WALK_MPS,
    offRoute,
    arrived,
    alongM: along,
    bearingDeg: bearing(a, b),
  }
}

/** Split the path at a distance along it: walked part and the part still ahead. */
export function splitPath(route: Route, alongM: number): { walked: { lat: number; lng: number }[]; ahead: { lat: number; lng: number }[] } {
  const g = geometry(route)
  const p = pointAt(g, alongM)
  const cut = { lat: p.lat, lng: p.lng }
  return { walked: [...g.pts.slice(0, p.seg + 1), cut], ahead: [cut, ...g.pts.slice(p.seg + 1)] }
}
