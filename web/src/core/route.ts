// Following a walking route. Pure: no I/O, no DOM.
//
// Guidance used to aim the arrow straight at the door, which points through buildings
// and understates the walk — 88 m of pavement reported as 50 m of nothing, with a left
// turn omitted. This aims it at the next point ALONG the path instead.
//
// The rule that matters: look ahead, not at your feet. Aiming at the nearest point on
// the polyline makes the arrow swing wildly whenever GPS jitters sideways, because the
// nearest point jumps back and forth. Aiming at a point a fixed distance further along
// is stable, and it is also what a person does when walking.

import { bearingDeg, haversineM, type LatLon } from './geo'

export interface RouteStep {
  distanceM: number | null
  maneuver: string | null
  text: string | null
  endLat: number | null
  endLon: number | null
}

export interface Route {
  found: boolean
  distanceM: number | null
  path: [number, number][]
  steps: RouteStep[]
}

/** How far along the path to aim. Below this the arrow chases GPS noise. */
export const LOOKAHEAD_M = 18
/** Past this from the path, treat the user as off-route. */
export const OFF_ROUTE_M = 30

export interface Progress {
  /** Index of the path point just behind the user. */
  index: number
  /** Metres from the user to the path. */
  offPathM: number
  /** Metres still to walk along the path. */
  remainingM: number
  /** Where to aim: a point LOOKAHEAD_M further along, or the final point. */
  aim: LatLon
  /** Bearing to that aim point. */
  bearing: number
  offRoute: boolean
}

function toLatLon(p: [number, number]): LatLon {
  return { lat: p[0], lon: p[1] }
}

/** Cumulative length of the path, in metres, per point. */
export function cumulative(path: [number, number][]): number[] {
  const out = [0]
  for (let i = 1; i < path.length; i++) {
    out.push(out[i - 1] + haversineM(toLatLon(path[i - 1]), toLatLon(path[i])))
  }
  return out
}

/**
 * Where the user is on the route, and where to point.
 * Returns null for an empty path so the caller can fall back to straight-line bearing.
 */
export function progressAlong(pos: LatLon, path: [number, number][]): Progress | null {
  if (path.length === 0) return null
  if (path.length === 1) {
    const only = toLatLon(path[0])
    return {
      index: 0,
      offPathM: haversineM(pos, only),
      remainingM: 0,
      aim: only,
      bearing: bearingDeg(pos, only),
      offRoute: false,
    }
  }

  const cum = cumulative(path)
  const total = cum[cum.length - 1]

  // nearest vertex. Good enough at walking scale, and far cheaper than projecting
  // onto every segment on every frame.
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = haversineM(pos, toLatLon(path[i]))
    if (d < bestD) {
      bestD = d
      best = i
    }
  }

  const targetAlong = Math.min(total, cum[best] + LOOKAHEAD_M)
  let aimIdx = best
  while (aimIdx < path.length - 1 && cum[aimIdx] < targetAlong) aimIdx++
  const aim = toLatLon(path[aimIdx])

  return {
    index: best,
    offPathM: bestD,
    remainingM: Math.max(0, total - cum[best]),
    aim,
    bearing: bearingDeg(pos, aim),
    offRoute: bestD > OFF_ROUTE_M,
  }
}

/** The step the user is currently walking, by distance consumed along the route. */
export function currentStep(remainingM: number, route: Route): RouteStep | null {
  if (!route.steps.length) return null
  let left = remainingM
  for (let i = route.steps.length - 1; i >= 0; i--) {
    const d = route.steps[i].distanceM ?? 0
    if (left <= d) return route.steps[i]
    left -= d
  }
  return route.steps[0]
}
