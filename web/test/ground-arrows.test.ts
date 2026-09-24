// Ground arrows: the projection onto the pavement, the recognition gate, the Live View
// door spotter, and the confidence the engine now hands the screen.
import { describe, expect, it } from 'vitest'
import { MAX_AGE_MS } from '../src/core/anchor'
import { angleDelta } from '../src/core/stability'
import type { Entrance } from '../src/core/types'
import { createApproachEngine } from '../src/ui/approachEngine'
import type { ApproachView, CompassReading } from '../src/ui/approachPort'
import { DoorSpotter, SPOT_EVERY_MS, spotsDoor } from '../src/ui/doorSpotter'
import {
  FREEZE_MS,
  GROUND_MIN_CONFIDENCE,
  GroundGate,
  groundGeometry,
  MAX_CHEVRONS,
  recognised,
  type GroundInput,
} from '../src/ui/groundArrows'

const VP = { w: 390, h: 844, bottom: 560 }

describe('groundGeometry: chevrons on the pavement', () => {
  it('3 to 5 chevrons, low on the screen, above the panel, receding and shrinking', () => {
    const g = groundGeometry(0, 9, 70, VP)
    expect(g.chevrons.length).toBeGreaterThanOrEqual(3)
    expect(g.chevrons.length).toBeLessThanOrEqual(MAX_CHEVRONS)
    // Phone 20 degrees below level: the horizon sits f*tan(20) above the centre.
    const horizon = VP.h / 2 - (VP.h / 2 / Math.tan((34 * Math.PI) / 180)) * Math.tan((20 * Math.PI) / 180)
    for (const c of g.chevrons) {
      expect(c.cy).toBeLessThanOrEqual(VP.bottom)
      expect(c.cy).toBeGreaterThan(horizon + 20) // on the floor, clearly below the horizon
    }
    // Further chevrons sit higher on screen (toward the horizon) and are smaller.
    const ys = g.chevrons.map((c) => c.cy)
    expect([...ys].sort((a, b) => b - a)).toEqual(ys)
    const width = (d: string) => {
      const xs = [...d.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]))
      return Math.max(...xs) - Math.min(...xs)
    }
    expect(width(g.chevrons[0].d)).toBeGreaterThan(width(g.chevrons.at(-1)!.d))
    expect(g.chevrons[0].opacity).toBeGreaterThan(g.chevrons.at(-1)!.opacity)
  })

  it('leads toward the door x: right of centre for a door on the right, left for left', () => {
    const r = groundGeometry(15, 8, 70, VP)
    const l = groundGeometry(-15, 8, 70, VP)
    expect(r.doorX).toBeGreaterThan(VP.w / 2)
    expect(l.doorX).toBeLessThan(VP.w / 2)
    expect(r.chevrons.at(-1)!.cx).toBeGreaterThan(r.chevrons[0].cx)
    expect(l.chevrons.at(-1)!.cx).toBeLessThan(l.chevrons[0].cx)
    // Straight ahead stays on the centre line.
    const c = groundGeometry(0, 8, 70, VP)
    for (const ch of c.chevrons) expect(ch.cx).toBeCloseTo(VP.w / 2, 0)
  })

  it('tilting the phone down brings the floor, and the first chevron, closer', () => {
    const up = groundGeometry(0, 12, 88, VP)
    const down = groundGeometry(0, 12, 50, VP)
    expect(down.chevrons[0].m).toBeLessThan(up.chevrons[0].m)
  })

  it('no pitch data yet: a sensible default, not nothing', () => {
    expect(groundGeometry(0, 8, null, VP).chevrons.length).toBeGreaterThan(0)
  })

  it('the threshold ring appears only when the door is near', () => {
    expect(groundGeometry(0, 9, 55, VP).ring).toBeNull()
    expect(groundGeometry(0, 3, 55, VP).ring).not.toBeNull()
  })

  it('a door behind or far to the side gets no ground path', () => {
    expect(groundGeometry(120, 8, 70, VP).chevrons).toEqual([])
    expect(groundGeometry(NaN, 8, 70, VP).chevrons).toEqual([])
  })
})

const live: GroundInput = { tier: 1, source: 'gemini-frame', relBearingDeg: 5, distanceM: 7, confidence: 0.85 }

describe('GroundGate: when the ground may show arrows', () => {
  it('only a tier-1 door, a camera source, a fresh bearing and real confidence count', () => {
    expect(recognised(live)).toBe(true)
    expect(recognised({ ...live, tier: 2 })).toBe(false)
    expect(recognised({ ...live, tier: null })).toBe(false)
    expect(recognised({ ...live, source: 'osm-fallback' })).toBe(false)
    expect(recognised({ ...live, source: null })).toBe(false)
    expect(recognised({ ...live, relBearingDeg: null })).toBe(false)
    expect(recognised({ ...live, confidence: GROUND_MIN_CONFIDENCE - 0.01 })).toBe(false)
    expect(recognised({ ...live, confidence: undefined })).toBe(false)
    expect(recognised({ ...live, done: true })).toBe(false)
  })

  it('searching until recognised; recognisedNow fires once', () => {
    const g = new GroundGate()
    expect(g.push({ ...live, source: null, relBearingDeg: null, confidence: undefined }, 0).state).toBe('searching')
    const a = g.push(live, 100)
    expect(a.state).toBe('live')
    expect(a.recognisedNow).toBe(true)
    expect(g.push({ ...live, relBearingDeg: 8 }, 200).recognisedNow).toBe(false)
  })

  it('a low-confidence fix never shows arrows', () => {
    const g = new GroundGate()
    const v = g.push({ ...live, confidence: 0.55 }, 0)
    expect(v.state).toBe('searching')
    expect(v.relBearingDeg).toBeNull()
  })

  it('a stale fix freezes the last arrows, then clears them', () => {
    const g = new GroundGate()
    g.push(live, 0)
    const stale = { ...live, source: null, relBearingDeg: null, confidence: undefined }
    const f = g.push(stale, 100)
    expect(f.state).toBe('frozen')
    expect(f.relBearingDeg).toBe(5) // the last trusted bearing, not updated
    expect(g.push(stale, 100 + FREEZE_MS - 1).state).toBe('frozen')
    expect(g.push(stale, 100 + FREEZE_MS).state).toBe('searching')
  })

  it('a map fallback after a recognition does not keep the ground arrows alive', () => {
    const g = new GroundGate()
    g.push(live, 0)
    const fb = g.push({ ...live, source: 'osm-fallback', confidence: undefined }, 50)
    expect(fb.state).toBe('frozen')
    expect(g.push({ ...live, source: 'osm-fallback', confidence: undefined }, 50 + FREEZE_MS).state).toBe('searching')
  })

  it('not tier 1, or through the door: off', () => {
    expect(new GroundGate().push({ ...live, tier: 0 }, 0).state).toBe('off')
    const g = new GroundGate()
    g.push(live, 0)
    expect(g.push({ ...live, done: true }, 10).state).toBe('off')
  })
})

describe('DoorSpotter (Live View)', () => {
  const DEMO = { id: 'demo/google-accessible', tier: 1 }
  it('only surveyed demo doors, tier 1, inside 25 m', () => {
    expect(spotsDoor(DEMO, 20)).toBe(true)
    expect(spotsDoor(DEMO, 30)).toBe(false)
    expect(spotsDoor({ ...DEMO, tier: 2 }, 10)).toBe(false)
    expect(spotsDoor({ id: 'node/1', tier: 1 }, 10)).toBe(false)
  })

  function rig(reply: (h: number) => unknown) {
    let t = 1000
    const bodies: { doorId: string; headingDeg: number }[] = []
    const fetch = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body))
      bodies.push(b)
      return { ok: true, status: 200, json: async () => reply(b.headingDeg) } as Response
    }) as unknown as typeof globalThis.fetch
    const sp = new DoorSpotter({ fetch, now: () => t, apiBase: '', doorId: DEMO.id })
    const flush = () => new Promise((r) => setTimeout(r, 0))
    return { sp, bodies, flush, advance: (ms: number) => (t += ms) }
  }

  it('sends the door id and carries a trusted fix with the compass', async () => {
    const r = rig((h) => ({ found: true, bearingDeg: angleDelta(h, 110), distanceM: 12, confidence: 0.8, source: 'gemini-frame' }))
    r.sp.tick(() => 'JPEG', 100)
    await r.flush()
    expect(r.bodies[0].doorId).toBe(DEMO.id)
    const a = r.sp.current(100)!
    expect(a.relBearingDeg).toBeCloseTo(10, 5)
    expect(a.confidence).toBe(0.8)
    // Turning right by 10 degrees puts the door straight ahead.
    expect(r.sp.current(110)!.relBearingDeg).toBeCloseTo(0, 5)
    // Stale after MAX_AGE_MS: gone.
    r.advance(MAX_AGE_MS + 1)
    expect(r.sp.current(110)).toBeNull()
  })

  it('found:false and low confidence leave no door', async () => {
    const r = rig(() => ({ found: true, bearingDeg: 0, distanceM: 5, confidence: 0.4 }))
    r.sp.tick(() => 'JPEG', 0)
    await r.flush()
    expect(r.sp.current(0)).toBeNull()
  })

  it('a door that jumps against the compass is rejected by the StabilityGuard', async () => {
    let n = 0
    const r = rig(() => ({ found: true, bearingDeg: n++ % 2 ? 30 : -30, distanceM: 10, confidence: 0.9 }))
    r.sp.tick(() => 'JPEG', 0)
    await r.flush()
    expect(r.sp.current(0)!.relBearingDeg).toBeCloseTo(-30, 5)
    r.advance(SPOT_EVERY_MS)
    r.sp.tick(() => 'JPEG', 0)
    await r.flush()
    // 60 degrees of swing with the phone still: not trusted, the old anchor stays.
    expect(r.sp.current(0)!.relBearingDeg).toBeCloseTo(-30, 5)
  })

  it('one request at a time, not faster than SPOT_EVERY_MS', async () => {
    const r = rig(() => ({ found: false, confidence: 0 }))
    r.sp.tick(() => 'JPEG', 0)
    r.sp.tick(() => 'JPEG', 0)
    await r.flush()
    r.advance(SPOT_EVERY_MS - 1)
    r.sp.tick(() => 'JPEG', 0)
    expect(r.bodies.length).toBe(1)
    r.advance(1)
    r.sp.tick(() => 'JPEG', 0)
    await r.flush()
    expect(r.bodies.length).toBe(2)
  })
})

describe('engine hands the fix confidence to the screen', () => {
  const DOOR: Entrance = {
    id: 'demo/google-accessible', buildingId: null, lat: 52.5, lon: 13.4, name: 'Test', kind: 'main', level: 0, stepFree: true,
    tier: 1, confidence: 'surveyed', door: 'hinged', automatic: false, approachBearing: 107, description: null,
    warnings: [], source: 'osm',
  }
  it('vision fixes carry confidence, the map fallback none', async () => {
    let t = 1000
    let tickFn = () => {}
    let headingCb: (h: CompassReading) => void = () => {}
    let found = true
    const views: ApproachView[] = []
    const fetch = (async () => ({
      ok: true, status: 200,
      json: async () => (found ? { found: true, bearingDeg: 5, distanceM: 8, confidence: 0.82, source: 'gemini-frame' } : { found: false, confidence: 0 }),
    })) as unknown as typeof globalThis.fetch
    const s = createApproachEngine({ fetch, now: () => t, every: (_m, fn) => ((tickFn = fn), () => {}), lang: 'de' })({
      door: DOOR, frame: () => 'JPEG', onHeading: (cb) => ((headingCb = cb), () => {}), onMotion: () => () => {}, apiBase: '',
    })
    s.subscribe((v) => views.push(v))
    const tick = async (ms = 100) => { t += ms; tickFn(); await new Promise((r) => setTimeout(r, 0)) }
    headingCb({ deg: 100, accuracy: 5 })
    await tick()
    await tick()
    expect(views.at(-1)!.source).toBe('gemini-frame')
    expect(views.at(-1)!.confidence).toBe(0.82)
    // Vision goes blind: after the anchor ages out the map takes over, without confidence.
    found = false
    for (let i = 0; i < 120; i++) await tick(100)
    const last = views.at(-1)!
    expect(last.source).toBe('osm-fallback')
    expect(last.confidence).toBeUndefined()
    s.stop()
  })
})
