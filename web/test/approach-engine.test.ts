// The real engine (ui/approachEngine.ts), driven through its ApproachIO with a fake
// fetch and fake sensors. Mirrors the scenarios of approach-e2e.test.ts, which composes
// the core by hand: here the composition is the production one.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STEP_M } from '../src/core/anchor'
import { STILL_MS } from '../src/core/approach'
import { bandText, fallbackLine, noCompassLine, noDirectionLine, pitchFor, safetyLine, thresholdLine, throughLine, unsureLine } from '../src/core/instruct'
import { angleDelta } from '../src/core/stability'
import type { Entrance } from '../src/core/types'
import { createApproachEngine, FALLBACK_AFTER, INSIDE_MIN_CONFIDENCE, parseDoorFix, saysInside } from '../src/ui/approachEngine'
import { engine, type ApproachView, type CompassReading } from '../src/ui/approachPort'
import { startDemoApproach } from '../src/ui/approachDemo'
import { MIN_STEP_MS, StepDetector } from '../src/ui/stepCounter'

const DOOR: Entrance = {
  id: 'node/1', buildingId: null, lat: 52.5, lon: 13.4, name: 'Test', kind: 'main', level: 0, stepFree: true,
  tier: 3, confidence: 'surveyed', door: 'sliding', automatic: true, approachBearing: 120, description: null,
  warnings: [], source: 'osm',
}

type Reply = unknown | Promise<unknown>

/** A phone in a fake world: compass, accelerometer, camera, network, clock. */
function rig(world: (req: { frame: string; headingDeg: number }) => Reply, door: Partial<Entrance> = {}) {
  let t = 1000
  let tickFn: () => void = () => {}
  let headingCb: (h: CompassReading) => void = () => {}
  let motionCb: (e: DeviceMotionEvent) => void = () => {}
  const calls: { url: string; body: { frame: string; headingDeg: number } }[] = []
  const views: ApproachView[] = []
  let stepsTaken = 0

  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    calls.push({ url, body })
    const out = await world(body)
    return { ok: true, json: async () => out } as Response
  }) as unknown as typeof fetch

  const session = createApproachEngine({
    fetch: fakeFetch,
    now: () => t,
    every: (_ms, fn) => {
      tickFn = fn
      return () => (tickFn = () => {})
    },
    lang: 'de',
  })({
    door: { ...DOOR, ...door },
    frame: () => 'JPEGBASE64',
    onHeading: (cb) => ((headingCb = cb), () => {}),
    onMotion: (cb) => ((motionCb = cb), () => {}),
    apiBase: 'https://api.test',
  })
  session.subscribe((v) => views.push(v))

  const flush = () => new Promise((r) => setTimeout(r, 0))
  return {
    session, calls, views,
    get t() { return t },
    get stepsTaken() { return stepsTaken },
    heading(deg: number) { headingCb({ deg, accuracy: 5 }) },
    /** Advance the clock and run one engine tick, then let pending fetches land. */
    async tick(ms = 100) { t += ms; tickFn(); await flush() },
    /** One walking step: half a second of 50 Hz accelerometer samples. */
    step() {
      for (let k = 0; k < 25; k++) {
        t += 20
        const z = 9.81 + 3 * Math.sin((2 * Math.PI * k) / 25)
        motionCb({ accelerationIncludingGravity: { x: 0, y: 0, z } } as unknown as DeviceMotionEvent)
      }
      stepsTaken += 1
    },
    /** What the screen would say: each instruction when it changes. */
    spoken() {
      const out: string[] = []
      for (const v of views) if (out.at(-1) !== v.instruction) out.push(v.instruction)
      return out
    },
  }
}

/** A fixed door at a compass bearing and distance: vision answers consistently. */
function door(compassDeg: number, metres: number, stepsNow: () => number) {
  return (req: { headingDeg: number }) => ({
    found: true, bearingDeg: angleDelta(req.headingDeg, compassDeg), distanceM: metres - stepsNow() * STEP_M,
    confidence: 0.9, kind: 'sliding', note: 'Glastür', source: 'gemini-frame',
  })
}

describe('the real engine, driven through ApproachIO', () => {
  it('orients, walks and reaches the threshold; safety line first and exactly once', async () => {
    let r!: ReturnType<typeof rig>
    r = rig(door(60, 9, () => r.stepsTaken)) // door 40 deg left of 100, 9 m
    r.heading(100)
    await r.tick()
    await r.tick()
    expect(r.views.at(-1)!.phase).toBe('orienting')
    expect(r.views.at(-1)!.relBearingDeg).toBeCloseTo(-40, 0)
    expect(r.views.at(-1)!.source).toBe('gemini-frame')

    for (let h = 100; h >= 60; h -= 10) { r.heading(h); await r.tick(200) }
    expect(r.views.at(-1)!.phase).toBe('walking')

    for (let i = 0; i < 14; i++) { r.step(); await r.tick() }
    expect(r.views.at(-1)!.phase).toBe('threshold')

    const spoken = r.spoken()
    expect(spoken[0]).toBe(safetyLine('de'))
    expect(spoken.filter((x) => x.includes(safetyLine('de')))).toHaveLength(1)
    expect(spoken.join(' ')).toContain(thresholdLine('de'))
  })

  it('says each distance once and counts down', async () => {
    let r!: ReturnType<typeof rig>
    r = rig(door(100, 11, () => r.stepsTaken))
    r.heading(100)
    await r.tick()
    for (let i = 0; i < 18; i++) { r.step(); await r.tick() }
    const metres = r.spoken().flatMap((x) => [...x.matchAll(/(\d+) Meter/g)].map((m) => Number(m[1])))
    expect(metres.length).toBeGreaterThan(2)
    expect(metres).toEqual([...new Set(metres)])
    expect(metres).toEqual([...metres].sort((a, b) => b - a))
    const d = r.views.filter((v) => v.distanceM !== null).map((v) => v.distanceM!)
    expect(d.at(-1)!).toBeLessThan(d[0])
  })

  it('never repeats the same instruction twice in a row while standing still', async () => {
    const r = rig(door(70, 8, () => 0))
    r.heading(100)
    for (let i = 0; i < 40; i++) await r.tick(150)
    const spoken = r.spoken()
    for (let i = 1; i < spoken.length; i++) expect(spoken[i]).not.toBe(spoken[i - 1])
    expect(spoken.filter((x) => x.includes('Links'))).toHaveLength(1)
  })

  it('an untrusted fix never becomes the anchor, and a hallucinating stream says unsure once', async () => {
    const answers = [-20, 60, -60, 40, 40, 40]
    let n = 0
    const r = rig(() => ({ found: true, bearingDeg: answers[Math.min(n++, answers.length - 1)], distanceM: 8, confidence: 0.9, source: 'gemini-frame' }))
    r.heading(100)
    await r.tick()
    const before = r.views.at(-1)!.relBearingDeg!
    expect(before).toBeCloseTo(-20, 1)

    // Next fix jumps 80 deg while the phone did not move: rejected.
    for (let i = 0; i < 15; i++) await r.tick()
    expect(n).toBe(2)
    expect(r.views.at(-1)!.relBearingDeg).toBeCloseTo(before, 1)

    // Second jump in a row: guard drops to on-demand, sticky, said once.
    for (let i = 0; i < 15; i++) await r.tick()
    expect(r.views.at(-1)!.unsure).toBe(true)
    expect(r.views.at(-1)!.relBearingDeg).toBeCloseTo(before, 1)
    const callsAtDrop = r.calls.length
    for (let i = 0; i < 30; i++) await r.tick() // anchor fresh, user still: no fix needed
    expect(r.calls.length).toBe(callsAtDrop)
    expect(r.spoken().filter((x) => x.includes(unsureLine('de')))).toHaveLength(1)
  })

  it('falls back to the surveyed bearing after repeated misses, and says so once', async () => {
    const r = rig(() => ({ found: false, bearingDeg: null, distanceM: null, confidence: 0.1, source: 'gemini-frame' }))
    r.heading(100)
    for (let i = 0; i < 16 * FALLBACK_AFTER; i++) await r.tick()
    const v = r.views.at(-1)!
    expect(v.source).toBe('osm-fallback')
    expect(v.relBearingDeg).toBeCloseTo(20, 0) // approachBearing 120, facing 100
    expect(v.distanceM).toBeNull() // the map gives a direction, not a distance
    expect(r.spoken().filter((x) => x.includes(fallbackLine('de')))).toHaveLength(1)
  })

  it('without a surveyed bearing there is no guess at all', async () => {
    const r = rig(() => ({ found: false }), { approachBearing: null })
    r.heading(100)
    for (let i = 0; i < 60; i++) await r.tick()
    expect(r.views.every((v) => v.relBearingDeg === null && v.source === null && v.beaconPitch === undefined)).toBe(true)
  })

  it('without a surveyed bearing it says so, exactly once, instead of falling silent', async () => {
    const r = rig(() => ({ found: false }), { approachBearing: null })
    r.heading(100)
    for (let i = 0; i < 40 * FALLBACK_AFTER; i++) await r.tick()
    expect(r.spoken().filter((x) => x.includes(noDirectionLine('de')))).toHaveLength(1)
  })

  it('never has more than one request in flight', async () => {
    let release!: (v: unknown) => void
    const r = rig(() => new Promise((res) => (release = res)))
    r.heading(100)
    for (let i = 0; i < 100; i++) await r.tick()
    expect(r.calls).toHaveLength(1)
    release({ found: true, bearingDeg: 0, distanceM: 5, confidence: 0.9, source: 'gemini-frame' })
    await r.tick()
    for (let i = 0; i < 20; i++) await r.tick()
    expect(r.calls).toHaveLength(2)
  })

  it('posts frame and headingDeg to /api/door-fix, and waits for the compass', async () => {
    const r = rig(() => ({ found: false }))
    for (let i = 0; i < 20; i++) await r.tick()
    expect(r.calls).toHaveLength(0)
    r.heading(42)
    await r.tick()
    expect(r.calls[0]).toEqual({ url: 'https://api.test/api/door-fix', body: { frame: 'JPEGBASE64', headingDeg: 42 } })
  })

  it('beacon pitch rises as the bearing error falls, silent without a fix', async () => {
    expect(pitchFor(0)).toBeGreaterThan(pitchFor(20))
    expect(pitchFor(20)).toBeGreaterThan(pitchFor(90))
    expect(pitchFor(-30)).toBe(pitchFor(30))
    const r = rig(door(60, 9, () => 0))
    expect(r.views[0].beaconPitch).toBeUndefined()
    r.heading(100)
    await r.tick()
    await r.tick()
    expect(r.views.at(-1)!.beaconPitch).toBe(pitchFor(r.views.at(-1)!.relBearingDeg!))
  })

  it('stillOutside and stop are safe on a fresh session', () => {
    const r = rig(() => ({ found: false }))
    expect(() => r.session.stillOutside()).not.toThrow()
    r.session.stop()
  })
})

/** Door straight ahead, 1.2 m: aimed and at the threshold from the first fix. */
const atDoor = (extra: Record<string, unknown> = {}) => () => ({
  found: true, bearingDeg: 0, distanceM: 1.2, confidence: 0.9, source: 'gemini-frame', ...extra,
})

describe('through: proposed by vision or by stillness, taken back by "Noch draußen"', () => {
  it('standing still STILL_MS at the threshold proposes through, said once', async () => {
    const r = rig(atDoor())
    r.heading(100)
    await r.tick()
    await r.tick()
    expect(r.views.at(-1)!.phase).toBe('threshold')
    for (let ms = 0; ms < STILL_MS - 500; ms += 100) await r.tick()
    expect(r.views.at(-1)!.phase).toBe('threshold')
    for (let i = 0; i < 10; i++) await r.tick()
    expect(r.views.at(-1)!.phase).toBe('through')
    expect(r.views.at(-1)!.beaconPitch).toBeUndefined()
    expect(r.views.at(-1)!.relBearingDeg).toBeNull()
    expect(r.views.at(-1)!.distanceM).toBeNull()
    expect(r.spoken().filter((x) => x.includes(throughLine('de')))).toHaveLength(1)
  })

  it('a step resets the stillness clock', async () => {
    const r = rig(atDoor())
    r.heading(100)
    await r.tick()
    await r.tick()
    for (let ms = 0; ms < STILL_MS - 1000; ms += 100) await r.tick()
    r.step()
    for (let ms = 0; ms < STILL_MS - 1000; ms += 100) await r.tick()
    expect(r.views.at(-1)!.phase).toBe('threshold')
  })

  it('stillOutside takes it back and restarts the clock, so it is not re-proposed at once', async () => {
    const r = rig(atDoor())
    r.heading(100)
    await r.tick()
    for (let ms = 0; ms <= STILL_MS + 500; ms += 100) await r.tick()
    expect(r.views.at(-1)!.phase).toBe('through')
    r.session.stillOutside()
    expect(r.views.at(-1)!.phase).toBe('threshold')
    for (let ms = 0; ms < STILL_MS - 500; ms += 100) await r.tick()
    expect(r.views.at(-1)!.phase).toBe('threshold')
    for (let i = 0; i < 10; i++) await r.tick()
    expect(r.views.at(-1)!.phase).toBe('through')
  })

  it('vision inside:true at confidence >= 0.6 proposes through at once', async () => {
    const r = rig(atDoor({ inside: true, confidence: INSIDE_MIN_CONFIDENCE }))
    r.heading(100)
    await r.tick()
    await r.tick()
    expect(r.views.at(-1)!.phase).toBe('through')
    expect(r.views.at(-1)!.instruction).toContain(throughLine('de'))
  })

  it('inside:true with no door in view (entrance behind) still counts', async () => {
    let n = 0
    const r = rig(() => (n++ === 0 ? atDoor()() : { found: false, inside: true, confidence: 0.9 }))
    r.heading(100)
    for (let i = 0; i < 20; i++) await r.tick()
    expect(r.views.at(-1)!.phase).toBe('through')
  })

  it('inside:false or low confidence never proposes through', async () => {
    for (const extra of [{ inside: false }, { inside: true, confidence: 0.55 }, { inside: 'true' }]) {
      const r = rig(atDoor(extra))
      r.heading(100)
      for (let i = 0; i < 20; i++) await r.tick() // 2 s: under STILL_MS
      expect(r.views.at(-1)!.phase).toBe('threshold')
    }
  })

  it('inside:true on a fix the guard rejects is ignored', async () => {
    // First fix anchors at -20; the second jumps 80 deg with the phone still: untrusted.
    let n = 0
    const r = rig(() => (n++ === 0
      ? { found: true, bearingDeg: -20, distanceM: 8, confidence: 0.9, source: 'gemini-frame' }
      : { found: true, bearingDeg: 60, distanceM: 8, confidence: 0.9, inside: true, source: 'gemini-frame' }))
    r.heading(100)
    for (let i = 0; i < 17; i++) await r.tick()
    expect(n).toBe(2)
    expect(r.views.at(-1)!.phase).not.toBe('through')
  })
})

describe('vision lost at the door (rule 2: no map anchor, no dead reckoning)', () => {
  /** Door 1.2 m straight ahead on the first reply, then vision never sees it again. */
  const lostAtDoor = () => {
    let n = 0
    return () => (n++ === 0 ? atDoor()() : { found: false, confidence: 0.1 })
  }

  it('once at the threshold, losing vision never demotes to walking or falls back to the map', async () => {
    const r = rig(lostAtDoor())
    r.heading(100)
    await r.tick()
    await r.tick()
    expect(r.views.at(-1)!.phase).toBe('threshold')
    const from = r.views.length
    // 30 s at the door, shuffling a step every 2 s so stillness never completes.
    for (let i = 0; i < 300; i++) {
      if (i % 20 === 0) r.step()
      await r.tick()
    }
    const after = r.views.slice(from)
    expect(after.every((v) => v.phase === 'threshold')).toBe(true)
    expect(after.some((v) => v.source === 'osm-fallback')).toBe(false)
    expect(r.spoken().some((x) => x.includes(fallbackLine('de')))).toBe(false)
  })

  it('standing still at the door proposes through even after the anchor went stale', async () => {
    const r = rig(lostAtDoor())
    r.heading(100)
    await r.tick()
    await r.tick()
    // Shuffle at the door past MAX_AGE_MS, so the only anchor is stale.
    for (let i = 0; i < 100; i++) {
      if (i % 10 === 0) r.step()
      await r.tick()
    }
    expect(r.views.at(-1)!.phase).toBe('threshold')
    for (let ms = 0; ms <= STILL_MS + 500; ms += 100) await r.tick()
    expect(r.views.at(-1)!.phase).toBe('through')
  })

  it('a map-bearing-only session never reaches threshold or through by walking or standing', async () => {
    const r = rig(() => ({ found: false, confidence: 0.1 }))
    r.heading(120) // facing the surveyed approachBearing
    for (let i = 0; i < 16 * FALLBACK_AFTER; i++) await r.tick()
    expect(r.views.at(-1)!.source).toBe('osm-fallback')
    for (let i = 0; i < 30; i++) { r.step(); await r.tick() } // ~20 m of dead reckoning
    for (let ms = 0; ms <= STILL_MS * 2; ms += 100) await r.tick()
    expect(r.views.some((v) => v.phase === 'threshold' || v.phase === 'through')).toBe(false)
  })

  it('a map anchor is re-minted when it ages out: the beacon does not drop every 8 s', async () => {
    const r = rig(() => ({ found: false, confidence: 0.1 }))
    r.heading(100)
    for (let i = 0; i < 16 * FALLBACK_AFTER; i++) await r.tick()
    expect(r.views.at(-1)!.source).toBe('osm-fallback')
    const from = r.views.length
    for (let i = 0; i < 300; i++) await r.tick() // 30 s
    expect(r.views.slice(from).every((v) => v.beaconPitch !== undefined)).toBe(true)
  })
})

describe('band speech does not chatter on compass jitter', () => {
  it('±3° jitter on a band edge speaks at most 2 band lines in 5 s, while the beacon keeps moving', async () => {
    const BANDS = ['straight', 'slight-left', 'slight-right', 'left', 'right', 'sharp-left', 'sharp-right', 'turn-around'] as const
    const bandLines = new Set(BANDS.map((b) => bandText(b, 'de')))
    const r = rig(door(108, 8, () => 0)) // door 8° right of 100: the straight/slight-right edge
    let seed = 7
    const jitter = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 6 - 3
    r.heading(100)
    await r.tick()
    await r.tick()
    const from = r.views.length
    for (let i = 0; i < 50; i++) { r.heading(100 + jitter()); await r.tick() }
    const said = r.views.slice(from).map((v) => v.instruction).filter((x, i, a) => i === 0 || x !== a[i - 1])
    expect(said.filter((x) => bandLines.has(x)).length).toBeLessThanOrEqual(2)
    expect(new Set(r.views.slice(from).map((v) => v.beaconPitch)).size).toBeGreaterThan(1)
  })
})

describe('no compass', () => {
  it('says so once, 3 s in, instead of staying silent after the safety line', async () => {
    const r = rig(() => ({ found: false }))
    for (let i = 0; i < 25; i++) await r.tick()
    expect(r.spoken()).toEqual([safetyLine('de')])
    for (let i = 0; i < 100; i++) await r.tick()
    expect(r.spoken()).toEqual([safetyLine('de'), noCompassLine('de')])
    expect(r.calls).toHaveLength(0) // still no heading, so still no request
  })
})

describe('parseDoorFix', () => {
  it('only a found, confident, numeric fix counts', () => {
    expect(parseDoorFix(null)).toBeNull()
    expect(parseDoorFix({ found: false, bearingDeg: null })).toBeNull()
    expect(parseDoorFix({ found: true, bearingDeg: 5, distanceM: 4, confidence: 0.3 })).toBeNull()
    expect(parseDoorFix({ found: true, bearingDeg: 5, distanceM: 4, confidence: 0.8, source: 'osm-fallback' })!.source).toBe('gemini-frame')
  })
  it('inside counts only as an explicit true at confidence >= 0.6', () => {
    expect(saysInside({ inside: true, confidence: 0.6 })).toBe(true)
    expect(saysInside({ found: false, inside: true, confidence: 0.9 })).toBe(true)
    expect(saysInside({ inside: true, confidence: 0.59 })).toBe(false)
    expect(saysInside({ inside: false, confidence: 0.9 })).toBe(false)
    expect(saysInside({ inside: 'true', confidence: 0.9 })).toBe(false)
    expect(saysInside({ confidence: 0.9 })).toBe(false)
    expect(saysInside(null)).toBe(false)
  })
})

describe('engine(): real by default, demo only on request', () => {
  it('picks the adapter from the query string', () => {
    expect(engine('')).not.toBe(startDemoApproach)
    expect(engine('?approach=demo')).toBe(startDemoApproach)
  })
  it('the engine and step counter never read GPS', () => {
    for (const f of ['../src/ui/approachEngine.ts', '../src/ui/stepCounter.ts']) {
      expect(readFileSync(resolve(__dirname, f), 'utf8')).not.toMatch(/navigator\.geolocation\s*\./)
    }
  })
  it('the engine holds no wording or pitch curve of its own: all of it is core/instruct.ts', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/approachEngine.ts'), 'utf8')
    expect(src).not.toMatch(/function\s+(thresholdLine|metresLine|throughLine|noDirectionLine|pitchFor)\b/)
    expect(src).not.toMatch(/PITCH_(AWAY|ON|MIN|MAX)_HZ\s*=/)
    expect(src).not.toMatch(/['`"](Die Tür|Du müsstest|Ich sehe|The door|You should)|Meter['`]|metres?['`]/)
  })
})

describe('StepDetector', () => {
  const walk = (seconds: number, hz: number, amp: number, stepHz = 2) => {
    const d = new StepDetector()
    for (let i = 0; i < seconds * hz; i++) {
      const t = (i * 1000) / hz
      d.push(0.3, 0.2, 9.81 + amp * Math.sin((2 * Math.PI * stepHz * t) / 1000), t)
    }
    return d.steps
  }
  it('counts a steady walk at 2 steps per second', () => {
    expect(walk(5, 50, 3)).toBeGreaterThanOrEqual(9)
    expect(walk(5, 50, 3)).toBeLessThanOrEqual(10)
    expect(walk(5, 60, 2.5)).toBeGreaterThanOrEqual(9)
  })
  it('standing still, hand tremor is not a step', () => {
    expect(walk(5, 50, 0.4)).toBe(0)
  })
  it('two peaks inside MIN_STEP_MS count once', () => {
    const d = new StepDetector()
    d.push(0, 0, 9.81, 0)
    let t = 0
    for (const z of [9.81, 13, 13, 9.0, 8.5, 13, 13]) d.push(0, 0, z, (t += MIN_STEP_MS / 8))
    expect(d.steps).toBe(1)
  })
  it('ignores garbage samples', () => {
    const d = new StepDetector()
    expect(d.push(NaN, 0, 9.81, 0)).toBe(false)
    expect(d.steps).toBe(0)
  })
})
