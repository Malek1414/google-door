// Regression cover for Malek's e21a687 ("roughly this way"), client side.
//
// The bug that shipped: the server had no key, /api/route failed, and the client turned
// every failure into a grey straight line captioned "Ungefähr in diese Richtung". These
// tests pin the contract that replaced it: a failure is a named reason in German, a
// success is a real multi-point path, and nothing in between is invented.
//
// Server side (polyline decode, 503 without a key, Gemini 429 retry) is in
// route-server.test.ts. The browser flow is e2e/route.mjs.
import { afterEach, describe, expect, it, vi } from 'vitest'

// Directions.ts reads window (apiBase, timers) and strings.ts picks the language from
// location, both at import time. German, because that is what the user reads.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.location = { search: '?lang=de' }
  g.window = { setTimeout, clearTimeout, DOORWAY_CONFIG: { apiBase: '' } }
})

import { cachedRoute, computeRoute, D } from '../src/ui/Directions'
import { nextManeuver, progressAlong, walkMinutes, type Route } from '../src/core/route'

const FROM = { lat: 52.5249, lon: 13.3688 }
const DOOR = { lat: 52.52537, lon: 13.37043 }

// The same recording e2e/route.mjs serves: the proxy's shape (path decoded, steps flat).
const RECORDED: Route = {
  found: true,
  distanceM: 250,
  duration: '206s',
  path: [
    [52.5249, 13.3688], [52.52512, 13.36884], [52.52541, 13.36889], [52.52578, 13.36893],
    [52.5258, 13.36921], [52.52583, 13.36952], [52.52563, 13.36958], [52.52545, 13.36962],
    [52.52541, 13.3701], [52.52537, 13.37043],
  ],
  steps: [
    { distanceM: 99, maneuver: 'DEPART', text: 'Auf Ella-Trebe-Straße nach Norden', endLat: 52.52578, endLon: 13.36893 },
    { distanceM: 19, maneuver: 'TURN_RIGHT', text: 'Rechts abbiegen auf Europaplatz', endLat: 52.52583, endLon: 13.36952 },
    { distanceM: 23, maneuver: 'TURN_LEFT', text: 'Links Richtung Invalidenstraße abbiegen', endLat: 52.52545, endLon: 13.36962 },
    { distanceM: 109, maneuver: 'TURN_RIGHT', text: 'Rechts abbiegen auf Invalidenstraße\nDas Ziel befindet sich rechts', endLat: 52.52537, endLon: 13.37043 },
  ],
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function mockFetch(...replies: Response[]) {
  const f = vi.fn(async () => replies.shift() ?? json(500, {}))
  vi.stubGlobal('fetch', f)
  return f
}

/** Maps JS Routes library, as viaMapsJs reaches it through window.google. */
function mockMapsJs(impl: () => Promise<unknown>) {
  const computeRoutes = vi.fn(impl)
  ;(globalThis.window as Record<string, unknown>).google = {
    maps: { importLibrary: async () => ({ Route: { computeRoutes } }), UnitSystem: { METRIC: 0 } },
  }
  return computeRoutes
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis.window as Record<string, unknown>).google
})

describe('no server key: a German reason, never a crow-flight line (bug 1)', () => {
  it('503 not_configured from the proxy is "auth", said in German', async () => {
    mockFetch(json(503, { detail: { code: 'not_configured', message: 'ROUTES_API_KEY / MAPS_API_KEY not configured' } }))
    const out = await computeRoute(FROM, DOOR)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('auth')
    expect(out.message).toBe('Route gerade nicht verfügbar. Der Pfeil zeigt direkt zum Eingang.')
    expect(out.message).not.toMatch(/Ungefähr|Roughly/)
  })

  it('the old server\'s bare "routes 401" still reads as auth, not as "no route"', async () => {
    mockFetch(json(502, { detail: 'routes 401' }))
    const out = await computeRoute(FROM, DOOR)
    expect(out).toMatchObject({ ok: false, reason: 'auth' })
  })

  it('quota and network are told apart, so the user knows whether retrying helps', async () => {
    mockFetch(json(502, { detail: { code: 'quota', status: 429 } }))
    expect(await computeRoute(FROM, DOOR)).toMatchObject({ ok: false, reason: 'quota', message: D.quota })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await computeRoute(FROM, DOOR)).toMatchObject({ ok: false, reason: 'network', message: D.network })
  })

  it('the German error copy never falls back to the crow-flight caption', () => {
    for (const k of ['none', 'auth', 'network', 'quota', 'unknown'] as const) {
      expect(D[k]).toMatch(/[a-zäöü]/)
      expect(D[k]).not.toMatch(/Ungefähr in diese Richtung/)
    }
    expect(D.noRouteTitle).toBe('Keine Route')
    expect(D.retry).toBe('Erneut versuchen')
  })
})

describe('the browser Routes library is the second path, not a straight line', () => {
  it('server down, Maps JS up: the Maps JS walk is used, with its real path', async () => {
    mockFetch(json(503, { detail: { code: 'not_configured' } }))
    const pts = RECORDED.path.map(([lat, lng]) => ({ lat, lng }))
    mockMapsJs(async () => ({
      routes: [{ path: pts, distanceMeters: 250, durationMillis: 206000, legs: [{ steps: [{ distanceMeters: 250, maneuver: 'DEPART', instructions: 'Los', path: pts }] }] }],
    }))
    const out = await computeRoute(FROM, DOOR)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.via).toBe('maps')
    expect(out.route.path.length).toBe(RECORDED.path.length)
    expect(out.route.duration).toBe('206s')
  })

  it('server down, Maps JS refused: the server\'s reason survives an unhelpful browser error', async () => {
    mockFetch(json(503, { detail: { code: 'not_configured' } }))
    mockMapsJs(async () => { throw new Error('something odd') })
    expect(await computeRoute(FROM, DOOR)).toMatchObject({ ok: false, reason: 'auth' })
  })

  it('a real "no walking route" answer is final: no second guess from the browser', async () => {
    mockFetch(json(200, { found: false, path: [], steps: [], distanceM: null }))
    const js = mockMapsJs(async () => ({ routes: [] }))
    expect(await computeRoute(FROM, DOOR)).toMatchObject({ ok: false, reason: 'none' })
    expect(js).not.toHaveBeenCalled()
  })

  it('a one-point "route" is not a route', async () => {
    mockFetch(json(200, { found: true, path: [[FROM.lat, FROM.lon]], steps: [], distanceM: 0 }))
    expect(await computeRoute(FROM, DOOR)).toMatchObject({ ok: false, reason: 'none' })
  })
})

describe('the drawn route is the route Start follows', () => {
  it('a server route comes back whole and is cached for guidance', async () => {
    const f = mockFetch(json(200, RECORDED))
    const out = await computeRoute(FROM, DOOR)
    expect(out).toMatchObject({ ok: true, via: 'server' })
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body).toMatchObject({ fromLat: FROM.lat, fromLon: FROM.lon, toLat: DOOR.lat, toLon: DOOR.lon, lang: 'de-DE' })
    expect(cachedRoute(FROM, DOOR)?.route.path.length).toBe(RECORDED.path.length)
  })

  it('the cache is keyed on the destination: a new target never reuses the old door\'s path (bug 2)', async () => {
    mockFetch(json(200, RECORDED))
    await computeRoute(FROM, DOOR)
    const poi = { lat: 52.52677, lon: 13.37183 }
    expect(cachedRoute(FROM, poi)).toBeNull()
    // and a user who has walked 60 m away asks again rather than following a stale start
    expect(cachedRoute({ lat: FROM.lat + 0.00055, lon: FROM.lon }, DOOR)).toBeNull()
  })
})

describe('walking the recorded route (pure core)', () => {
  it('summary: 206 s reads as 3 min, never zero', () => {
    expect(walkMinutes(RECORDED)).toBe(3)
    expect(walkMinutes({ ...RECORDED, duration: '20s' })).toBe(1)
    expect(walkMinutes({ ...RECORDED, duration: null })).toBeNull()
  })

  it('every vertex of the route is on route, and manoeuvres come in order', () => {
    const seen: (string | null)[] = []
    for (const [lat, lon] of RECORDED.path) {
      const p = progressAlong({ lat, lon }, RECORDED.path)!
      expect(p.offRoute).toBe(false)
      expect(p.offPathM).toBeLessThan(1)
      const n = nextManeuver(p.remainingM, RECORDED)!
      const m = n.step?.maneuver ?? 'ARRIVE'
      if (seen[seen.length - 1] !== m) seen.push(m)
    }
    expect(seen).toEqual(['TURN_RIGHT', 'TURN_LEFT', 'TURN_RIGHT', 'ARRIVE'])
  })

  it('remaining distance only shrinks while walking the path', () => {
    let prev = Infinity
    for (const [lat, lon] of RECORDED.path) {
      const r = progressAlong({ lat, lon }, RECORDED.path)!.remainingM
      expect(r).toBeLessThanOrEqual(prev + 0.01)
      prev = r
    }
    expect(prev).toBeLessThan(1)
  })

  it('40 m off the first leg is off route; 10 m is not', () => {
    // first leg runs north: offset east by metres / (111320 * cos(lat))
    const east = (m: number) => m / (111320 * Math.cos((52.525 * Math.PI) / 180))
    const mid = { lat: 52.5253, lon: 13.36889 }
    expect(progressAlong({ lat: mid.lat, lon: mid.lon + east(10) }, RECORDED.path)!.offRoute).toBe(false)
    expect(progressAlong({ lat: mid.lat, lon: mid.lon - east(40) }, RECORDED.path)!.offRoute).toBe(true)
  })
})
