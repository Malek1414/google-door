// Walking directions: fetching them, and the turn-by-turn list.
//
// Every route used to go through POST /api/route alone, and any failure there came back
// as { found: false }. The server key was an AQ. key, which the Routes API rejects with
// 401, so EVERY route failed, silently, and the map drew a grey straight line captioned
// "Ungefähr in diese Richtung". Now:
//   1. the server proxy (keeps a server key server-side when one is configured),
//   2. then the Maps JavaScript Routes library with the browser key the map already
//      uses, which is how Google Maps on the web computes a walk,
//   3. and if both fail, a visible reason. Never a straight line posing as a route.

import { apiBase } from '../config'
import { haversineM, type LatLon } from '../core/geo'
import { instructionLine, maneuverGlyph, type Route, type RouteStep } from '../core/route'
import { lang } from '../strings'
import { h } from './dom'
import './directions.css'

export type RouteFailure = 'none' | 'auth' | 'network' | 'quota' | 'unknown'

export type RouteOutcome =
  | { ok: true; route: Route; via: 'server' | 'maps' }
  | { ok: false; reason: RouteFailure; message: string }

export const D = {
  de: {
    none: 'Für diesen Weg gibt es keine Fußgängerroute.',
    auth: 'Die Routenberechnung ist gerade nicht freigeschaltet.',
    network: 'Keine Verbindung zur Routenberechnung.',
    quota: 'Zu viele Routenanfragen. Bitte gleich noch einmal versuchen.',
    unknown: 'Die Route konnte nicht berechnet werden.',
    noRouteTitle: 'Keine Route',
    retry: 'Erneut versuchen',
    crow: (m: string) => `Luftlinie ${m}`,
    steps: 'Wegbeschreibung',
    destination: 'Ziel',
    thenArrive: (name: string) => `Ankunft: ${name}`,
    liveNoRoute: 'Keine Route. Der Pfeil zeigt direkt zum Eingang, nicht entlang der Straße.',
    rerouting: 'Neue Route wird berechnet …',
  },
  en: {
    none: 'There is no walking route for this trip.',
    auth: 'Route calculation is not enabled right now.',
    network: 'Cannot reach route calculation.',
    quota: 'Too many route requests. Please try again shortly.',
    unknown: 'The route could not be calculated.',
    noRouteTitle: 'No route',
    retry: 'Try again',
    crow: (m: string) => `${m} as the crow flies`,
    steps: 'Directions',
    destination: 'Destination',
    thenArrive: (name: string) => `Arrive: ${name}`,
    liveNoRoute: 'No route. The arrow points straight at the entrance, not along the street.',
    rerouting: 'Recalculating route …',
  },
}[lang === 'de' ? 'de' : 'en']

const fail = (reason: RouteFailure): RouteOutcome => ({ ok: false, reason, message: D[reason] })

async function viaServer(from: LatLon, to: LatLon, language: string): Promise<RouteOutcome> {
  let r: Response
  try {
    const ctl = new AbortController()
    const timer = window.setTimeout(() => ctl.abort(), 12000)
    r = await fetch(`${apiBase()}/api/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromLat: from.lat, fromLon: from.lon, toLat: to.lat, toLon: to.lon, lang: language }),
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer))
  } catch {
    return fail('network')
  }
  if (!r.ok) {
    let code: RouteFailure = 'unknown'
    try {
      const body = (await r.json()) as { detail?: { code?: string } | string }
      const c = typeof body.detail === 'object' ? body.detail?.code : undefined
      if (c === 'auth' || c === 'not_configured') code = 'auth'
      else if (c === 'quota') code = 'quota'
      else if (c === 'network') code = 'network'
      // Older servers said only "routes 401".
      else if (typeof body.detail === 'string' && /routes 40[13]/.test(body.detail)) code = 'auth'
    } catch {
      /* not JSON */
    }
    return fail(code)
  }
  const route = (await r.json()) as Route
  if (!route.found || route.path.length < 2) return fail('none')
  return { ok: true, route, via: 'server' }
}

type RoutesLib = { Route: typeof google.maps.routes.Route }

async function viaMapsJs(from: LatLon, to: LatLon, language: string): Promise<RouteOutcome> {
  const maps = (window as { google?: typeof google }).google?.maps
  if (!maps?.importLibrary) return fail('unknown')
  try {
    const { Route: R } = (await maps.importLibrary('routes')) as unknown as RoutesLib
    const res = await R.computeRoutes({
      origin: { lat: from.lat, lng: from.lon },
      destination: { lat: to.lat, lng: to.lon },
      travelMode: 'WALKING',
      language,
      units: maps.UnitSystem.METRIC,
      fields: ['path', 'distanceMeters', 'durationMillis', 'legs'],
    })
    const top = res.routes?.[0]
    const path = (top?.path ?? []).map((p): [number, number] => [p.lat, p.lng])
    if (!top || path.length < 2) return fail('none')
    const steps: RouteStep[] = []
    for (const leg of top.legs ?? []) {
      for (const st of leg.steps) {
        const end = st.path.at(-1)
        steps.push({ distanceM: st.distanceMeters, maneuver: st.maneuver, text: st.instructions, endLat: end?.lat ?? null, endLon: end?.lng ?? null })
      }
    }
    const route: Route = {
      found: true,
      distanceM: top.distanceMeters ?? null,
      duration: top.durationMillis != null ? `${Math.round(top.durationMillis / 1000)}s` : null,
      path,
      steps,
    }
    return { ok: true, route, via: 'maps' }
  } catch (err) {
    const m = String((err as Error)?.message ?? err)
    return fail(/PERMISSION|REFERER|REFERRER|API key|denied|403|401/i.test(m) ? 'auth' : /quota|429|RESOURCE_EXHAUSTED/i.test(m) ? 'quota' : 'unknown')
  }
}

// The route drawn in the preview is the route Start follows: one request, one path.
let last: { from: LatLon; to: LatLon; route: Route } | null = null

/** Walking route from `from` to `to`. Server first, then Maps JS, else a reason. */
export async function computeRoute(from: LatLon, to: LatLon): Promise<RouteOutcome> {
  const language = lang === 'de' ? 'de-DE' : 'en-GB'
  let out = await viaServer(from, to, language)
  if (!out.ok && out.reason !== 'none') {
    const js = await viaMapsJs(from, to, language)
    // Keep the server's reason when the browser path has none better to give.
    out = js.ok || js.reason !== 'unknown' ? js : out
  }
  if (out.ok) last = { from, to, route: out.route }
  return out
}

/** The route last computed to this destination, and where it was asked from, if that
 *  is still about where the user is. */
export function cachedRoute(from: LatLon, to: LatLon): { route: Route; from: LatLon } | null {
  if (!last) return null
  if (haversineM(last.to, to) > 3) return null
  if (haversineM(last.from, from) > 40) return null
  return { route: last.route, from: last.from }
}

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1).replace('.', lang === 'de' ? ',' : '.')} km`
  if (m >= 100) return `${Math.round(m / 10) * 10} m`
  return `${Math.max(1, Math.round(m))} m`
}

/**
 * Turn-by-turn list as Maps shows it: a manoeuvre glyph, the instruction, and the
 * distance walked on that step underneath. The destination is the last row.
 */
export function stepsList(route: Route, destination: string): HTMLElement {
  const ms = (n: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, n)
  const rows = route.steps.map((st) => {
    const text = instructionLine(st) ?? ''
    const extra = st.text?.split('\n').slice(1).join(' ') ?? ''
    return h(
      'li',
      { class: 'dir-step' },
      h('span', { class: 'dir-ic' }, ms(maneuverGlyph(st.maneuver) ?? 'straight')),
      h(
        'div',
        { class: 'dir-body' },
        h('p', { class: 'dir-t' }, text),
        extra ? h('p', { class: 'dir-x' }, extra) : null,
        st.distanceM ? h('p', { class: 'dir-d' }, formatDistance(st.distanceM)) : null,
      ),
    )
  })
  rows.push(h('li', { class: 'dir-step dir-end' }, h('span', { class: 'dir-ic' }, ms('location_on')), h('div', { class: 'dir-body' }, h('p', { class: 'dir-t' }, destination))))
  return h('ol', { class: 'dir-list', 'aria-label': D.steps }, ...rows)
}
