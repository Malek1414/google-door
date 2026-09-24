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
  /** Google's duration string, e.g. "72s". */
  duration?: string | null
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

  // Nearest point on any SEGMENT, not the nearest vertex. The Routes API returns sparse
  // paths (three points for 130 m is normal), and a vertex 40 m away along a straight
  // pavement made someone walking on that pavement count as off-route.
  const kx = 111320 * Math.cos((pos.lat * Math.PI) / 180)
  const ky = 110540
  let best = 0
  let bestT = 0
  let bestD = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const ax = (path[i][1] - pos.lon) * kx
    const ay = (path[i][0] - pos.lat) * ky
    const bx = (path[i + 1][1] - pos.lon) * kx
    const by = (path[i + 1][0] - pos.lat) * ky
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const tt = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
    const d = Math.hypot(ax + tt * dx, ay + tt * dy)
    if (d < bestD) {
      bestD = d
      best = i
      bestT = tt
    }
  }

  const along = cum[best] + bestT * (cum[best + 1] - cum[best])
  const aim = pointAt(path, cum, Math.min(total, along + LOOKAHEAD_M))

  return {
    index: best,
    offPathM: bestD,
    remainingM: Math.max(0, total - along),
    aim,
    bearing: bearingDeg(pos, aim),
    offRoute: bestD > OFF_ROUTE_M,
  }
}

/** The point `m` metres along the path, interpolated inside its segment. */
function pointAt(path: [number, number][], cum: number[], m: number): LatLon {
  let i = 0
  while (i < path.length - 2 && cum[i + 1] < m) i++
  const seg = cum[i + 1] - cum[i]
  const f = seg <= 0 ? 0 : Math.max(0, Math.min(1, (m - cum[i]) / seg))
  return { lat: path[i][0] + (path[i + 1][0] - path[i][0]) * f, lon: path[i][1] + (path[i + 1][1] - path[i][1]) * f }
}

/**
 * The Routes API snaps the origin to the nearest walkable way, which can be tens of
 * metres from where the user stands (inside a station, across a square). Maps joins the
 * two with a short connector; guidance has to follow that connector too, or the user
 * starts "off route" and never gets a single instruction.
 */
export const CONNECTOR_MIN_M = 5
export function connected(from: LatLon, path: [number, number][], to?: LatLon): [number, number][] {
  if (!path.length) return path
  const head: [number, number][] = haversineM(from, toLatLon(path[0])) > CONNECTOR_MIN_M ? [[from.lat, from.lon]] : []
  // Same at the far end: the destination is snapped to the street, the door is not.
  const tail: [number, number][] = to && haversineM(to, toLatLon(path[path.length - 1])) > CONNECTOR_MIN_M ? [[to.lat, to.lon]] : []
  return [...head, ...path, ...tail]
}

/** The step the user is currently walking, by distance consumed along the route. */
export interface StepAhead {
  step: RouteStep
  /** Metres still to walk before this step's manoeuvre. What the banner counts down. */
  toManeuverM: number
}

/**
 * The step being walked, and how far is left of it. Steps are measured from the end of
 * the route backwards, because remainingM is all we know: the walk is the only clock.
 */
export function stepAhead(remainingM: number, route: Route): StepAhead | null {
  if (!route.steps.length) return null
  let left = remainingM
  for (let i = route.steps.length - 1; i >= 0; i--) {
    const d = route.steps[i].distanceM ?? 0
    if (left <= d) return { step: route.steps[i], toManeuverM: Math.max(0, left) }
    left -= d
  }
  return { step: route.steps[0], toManeuverM: Math.max(0, route.steps[0].distanceM ?? 0) }
}

export function currentStep(remainingM: number, route: Route): RouteStep | null {
  return stepAhead(remainingM, route)?.step ?? null
}

/**
 * The manoeuvre coming up, which is what a navigation banner shows.
 *
 * Google's navigationInstruction describes the manoeuvre at the START of its step, so
 * while the user walks step i the next thing to do is step i+1's instruction, and the
 * distance to it is what is left of step i. After the last step the next "manoeuvre"
 * is the destination itself: `step` is null then and the countdown is the rest of the walk.
 */
export interface NextManeuver {
  /** The instruction to perform next, or null when the next thing is arriving. */
  step: RouteStep | null
  /** Metres until that manoeuvre (or until the destination). */
  toManeuverM: number
  /** Index into route.steps of the step being walked. */
  walking: number
}

export function nextManeuver(remainingM: number, route: Route, tailM = 0): NextManeuver | null {
  const steps = route.steps
  if (!steps.length) return null
  // tailM: the connector from where the route ends to the door. It belongs to no step,
  // so it is taken off before matching steps and added back when arriving is next.
  let left = Math.max(0, remainingM - tailM)
  for (let i = steps.length - 1; i >= 0; i--) {
    const d = steps[i].distanceM ?? 0
    // i === 0 takes whatever is left: path and step lengths never sum exactly.
    if (left <= d || i === 0) {
      const next = steps[i + 1] ?? null
      return { step: next, toManeuverM: next ? left : Math.max(0, remainingM), walking: i }
    }
    left -= d
  }
  return null
}

/** Length of the connector `connected()` appended after the route, or 0. */
export function tailLength(path: [number, number][], followPath: [number, number][]): number {
  if (!path.length || followPath.length < 2) return 0
  const a = followPath[followPath.length - 1]
  const b = path[path.length - 1]
  return a[0] === b[0] && a[1] === b[1] ? 0 : haversineM(toLatLon(b), toLatLon(a))
}

/** "206s" (Routes API duration) -> seconds, or null. */
export function durationSeconds(route: Route): number | null {
  const n = Number(String(route.duration ?? '').replace(/s$/, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Walking minutes for a route, never below 1. */
export function walkMinutes(route: Route): number | null {
  const s = durationSeconds(route)
  return s === null ? null : Math.max(1, Math.round(s / 60))
}

/** First line of a Google instruction; the rest is "destination on the right" etc. */
export function instructionLine(step: RouteStep | null): string | null {
  const x = step?.text?.split('\n')[0]?.trim()
  return x ? x : null
}

/**
 * Google's manoeuvre enum to a Material Symbols turn glyph. The route knows a left turn
 * is coming; the compass only knows the door is currently off to the left.
 */
export function maneuverGlyph(m: string | null): string | null {
  if (!m) return null
  const map: Record<string, string> = {
    DEPART: 'straight',
    STRAIGHT: 'straight',
    TURN_LEFT: 'turn_left',
    TURN_RIGHT: 'turn_right',
    TURN_SLIGHT_LEFT: 'turn_slight_left',
    TURN_SLIGHT_RIGHT: 'turn_slight_right',
    TURN_SHARP_LEFT: 'turn_sharp_left',
    TURN_SHARP_RIGHT: 'turn_sharp_right',
    UTURN_LEFT: 'u_turn_left',
    UTURN_RIGHT: 'u_turn_right',
    TURN_U_TURN_LEFT: 'u_turn_left',
    TURN_U_TURN_RIGHT: 'u_turn_right',
    RAMP_LEFT: 'turn_slight_left',
    RAMP_RIGHT: 'turn_slight_right',
    FORK_LEFT: 'fork_left',
    FORK_RIGHT: 'fork_right',
    MERGE: 'merge',
    ROUNDABOUT_LEFT: 'roundabout_left',
    ROUNDABOUT_RIGHT: 'roundabout_right',
    ROUNDABOUT_CLOCKWISE: 'roundabout_right',
    ROUNDABOUT_COUNTERCLOCKWISE: 'roundabout_left',
    FERRY: 'directions_boat',
    NAME_CHANGE: 'straight',
  }
  return map[m] ?? null
}
