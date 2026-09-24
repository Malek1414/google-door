// Map navigation mode (after Start, before Live View). Pure: no I/O, no DOM.
// Turns a position on a followed route into what the Maps nav banner and sheet show.

import { haversineM, type LatLon } from './geo'
import { durationSeconds, instructionLine, maneuverGlyph, nextManeuver, progressAlong, type Route } from './route'

export interface NavState {
  /** Material glyph for the next manoeuvre ("turn_left"), or 'flag' when arriving is next. */
  glyph: string
  /** Instruction of the next manoeuvre, or null when the next thing is arriving. */
  text: string | null
  /** Metres to that manoeuvre (or to the destination). */
  toManeuverM: number
  /** Metres left to walk to the door. */
  remainingM: number
  /** Index of the step being walked; a change means a new banner to speak. */
  walking: number
}

/**
 * Where the user is on the route. `followPath` is the path actually followed (with the
 * connectors from `connected()`), `tailM` the connector to the door. Off the path the
 * remaining distance falls back to the straight line to the path's end.
 */
export function navState(pos: LatLon, route: Route, followPath: [number, number][], tailM = 0): NavState {
  const prog = followPath.length >= 2 ? progressAlong(pos, followPath) : null
  const end = followPath[followPath.length - 1] ?? route.path[route.path.length - 1]
  const remainingM = prog ? prog.remainingM : end ? haversineM(pos, { lat: end[0], lon: end[1] }) : 0
  const next = nextManeuver(remainingM, route, tailM)
  const step = next?.step ?? null
  return {
    glyph: step ? maneuverGlyph(step.maneuver) ?? 'straight' : 'flag',
    text: step ? instructionLine(step) : null,
    toManeuverM: next ? next.toManeuverM : remainingM,
    remainingM,
    walking: next?.walking ?? 0,
  }
}

/** Seconds still to walk, scaled from the route's own duration; 1.2 m/s without one. */
export function secondsLeft(route: Route, remainingM: number): number {
  const total = durationSeconds(route)
  const dist = route.distanceM ?? 0
  if (total !== null && dist > 0) return Math.max(0, (total * remainingM) / dist)
  return Math.max(0, remainingM / 1.2)
}

/** "09:24": wall-clock arrival, 24 h. */
export function arrivalClock(now: Date, seconds: number): string {
  const d = new Date(now.getTime() + seconds * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Metres for the banner, rounded like Maps: 10 m steps below 300, 50 m above. */
export function roundNavM(m: number): number {
  if (m < 10) return Math.max(0, Math.round(m))
  return m < 300 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50
}

/** The "Dann" chip: glyph of the manoeuvre after the next one, or null when there is none. */
export function thenGlyph(route: Route, walking: number): string | null {
  const after = route.steps[walking + 2]
  if (!after) return null
  return maneuverGlyph(after.maneuver) ?? null
}

/** Nav sheet lines, as in Maps: big "3 Min.", small "210 m · 09:25". */
export function navSheetLines(seconds: number, remainingM: number, now: Date, de = true): { big: string; small: string } {
  const mins = Math.max(1, Math.round(seconds / 60))
  const m = remainingM < 1000 ? `${Math.round(remainingM / 10) * 10} m` : `${(remainingM / 1000).toFixed(1).replace('.', de ? ',' : '.')} km`
  return { big: de ? `${mins} Min.` : `${mins} min`, small: `${m} · ${arrivalClock(now, seconds)}` }
}
