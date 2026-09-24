// The last 10 metres under hostile conditions: no compass, no camera, a backend that
// answers 500 / 429 / never, a compass that flips across north, double taps and a
// screen closed mid-phase. The rule under test: a blind user is never left in silence
// for more than QUIET_MS without being told why, and nothing runs after stop().
import { describe, expect, it } from 'vitest'
import { STEP_M } from '../src/core/anchor'
import { bandFor, bandText, fallbackLine, safetyLine } from '../src/core/instruct'
import { angleDelta } from '../src/core/stability'
import type { Entrance } from '../src/core/types'
import {
  createApproachEngine,
  NO_COMPASS_MS,
  noCompassLine,
  RATE_LIMIT_BACKOFF_MS,
} from '../src/ui/approachEngine'
import { Narrator } from '../src/ui/Approach'
import type { ApproachView, CompassReading } from '../src/ui/approachPort'
import { ClipPlayer, isTransient } from '../src/ui/clips'

const DOOR: Entrance = {
  id: 'node/1', buildingId: null, lat: 52.5, lon: 13.4, name: 'Test', kind: 'main', level: 0, stepFree: true,
  tier: 3, confidence: 'surveyed', door: 'sliding', automatic: true, approachBearing: 120, description: null,
  warnings: [], source: 'osm',
}

type World = (req: { headingDeg: number }) => { status: number; body?: unknown } | Promise<never>

function rig(world: World, opts: { door?: Partial<Entrance>; frame?: () => string | null } = {}) {
  let t = 1000
  let tickFn: () => void = () => {}
  let timers = 0
  let headingCb: ((h: CompassReading) => void) | null = null
  let motionCb: ((e: DeviceMotionEvent) => void) | null = null
  const calls: number[] = []
  const views: ApproachView[] = []
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    calls.push(t)
    const r = await world(JSON.parse(String(init.body)))
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response
  }) as unknown as typeof fetch
  const session = createApproachEngine({
    fetch: fakeFetch,
    now: () => t,
    every: (_ms, fn) => {
      tickFn = fn
      timers++
      return () => {
        tickFn = () => {}
        timers--
      }
    },
    lang: 'de',
  })({
    door: { ...DOOR, ...opts.door },
    frame: opts.frame ?? (() => 'JPEG'),
    onHeading: (cb) => ((headingCb = cb), () => (headingCb = null)),
    onMotion: (cb) => ((motionCb = cb), () => (motionCb = null)),
    apiBase: 'https://api.test',
  })
  session.subscribe((v) => views.push(v))
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const narrator = new Narrator('de')
  /** Every line the screen would speak, with its time. */
  const said: { t: number; text: string }[] = []
  let seen = 0
  const collect = () => {
    for (; seen < views.length; seen++) {
      const s = narrator.next(views[seen])
      if (s) said.push({ t, text: s.text })
    }
  }
  collect()
  return {
    session, calls, views, said,
    get t() { return t },
    get timers() { return timers },
    get listening() { return headingCb !== null || motionCb !== null },
    heading(deg: number) { headingCb?.({ deg, accuracy: 5 }) },
    async run(ms: number, each?: () => void) {
      for (let k = 0; k < ms / 100; k++) {
        t += 100
        each?.()
        tickFn()
        await flush()
        collect()
      }
    },
  }
}

const door = (compassDeg: number, metres: number) => (req: { headingDeg: number }) => ({
  status: 200,
  body: { found: true, bearingDeg: angleDelta(req.headingDeg, compassDeg), distanceM: metres - 0 * STEP_M, confidence: 0.9, source: 'gemini-frame' },
})


describe('approach under stress: never silent without a reason', () => {
  it('no compass at all: the safety line, then "no compass" once within NO_COMPASS_MS, then silence', async () => {
    const r = rig(door(70, 8))
    await r.run(100000)
    expect(r.said[0].text).toBe(safetyLine('de'))
    const nc = r.said.filter((s) => s.text === noCompassLine('de'))
    expect(nc).toHaveLength(1)
    expect(nc[0].t - 1000).toBeLessThanOrEqual(NO_COMPASS_MS + 100)
    expect(r.said).toHaveLength(2)
    expect(r.calls).toHaveLength(0) // no heading, no frame worth sending
    expect(r.views.every((v) => v.relBearingDeg === null && v.beaconPitch === undefined)).toBe(true)
  })

  it('60 s standing still with a jittery compass: nothing after the opening lines', async () => {
    const r = rig(door(70, 8))
    let k = 0
    r.heading(100)
    await r.run(3000, () => r.heading(100 + 3 * Math.sin(k++)))
    const opening = r.said.length
    await r.run(60000, () => r.heading(100 + 3 * Math.sin(k++)))
    expect(r.said.length - opening).toBe(0)
    expect(r.said.filter((s) => s.text === safetyLine('de'))).toHaveLength(1)
  })

  it('backend 500 on every door-fix: the map fallback is said', async () => {
    const r = rig(() => ({ status: 500 }))
    r.heading(100)
    await r.run(20000)
    expect(r.said.some((s) => s.text.includes(fallbackLine('de')))).toBe(true)
  })

  it('backend that never answers (timeout): never more than one request in flight', async () => {
    const r = rig(() => new Promise<never>(() => {}))
    r.heading(100)
    await r.run(20000)
    expect(r.calls).toHaveLength(1)
  })

  it('429 backs off for RATE_LIMIT_BACKOFF_MS instead of hammering the quota', async () => {
    let n = 0
    const r = rig((req) => (n++ === 0 ? { status: 429 } : door(70, 8)(req)))
    r.heading(100)
    await r.run(8000)
    expect(r.calls.length).toBeGreaterThanOrEqual(2)
    expect(r.calls[1] - r.calls[0]).toBeGreaterThanOrEqual(RATE_LIMIT_BACKOFF_MS)
  })

  it('no camera frame ever: counts as misses, so the map bearing still takes over', async () => {
    const r = rig(door(70, 8), { frame: () => null })
    r.heading(100)
    await r.run(15000)
    expect(r.calls).toHaveLength(0)
    expect(r.said.some((s) => s.text.includes(fallbackLine('de')))).toBe(true)
    expect(r.views.at(-1)!.source).toBe('osm-fallback')
  })

  it('compass flipping across north (359 ↔ 1): the door straight ahead stays straight ahead', async () => {
    const r = rig(door(0, 6))
    let k = 0
    r.heading(359)
    await r.run(8000, () => r.heading(k++ % 2 ? 1 : 359))
    const bearings = r.views.map((v) => v.relBearingDeg).filter((b): b is number => b !== null)
    expect(bearings.length).toBeGreaterThan(0)
    for (const b of bearings) expect(Math.abs(b)).toBeLessThan(10)
    const bands = r.said.map((s) => s.text).filter((x) => /links|rechts|Umdrehen/i.test(x))
    expect(bands).toHaveLength(0)
  })
})

describe('approach teardown and double taps', () => {
  it('stop() twice is safe, releases every timer and listener, and nothing is emitted after it', async () => {
    const r = rig(door(70, 8))
    r.heading(100)
    await r.run(2000)
    expect(r.timers).toBe(1)
    const n = r.views.length
    r.session.stop()
    r.session.stop()
    expect(r.timers).toBe(0)
    expect(r.listening).toBe(false)
    r.session.stillOutside() // a late tap on "Noch draußen" after the screen closed
    await r.run(3000)
    expect(r.views.length).toBe(n)
  })

  it('a request in flight when the screen closes lands in nothing', async () => {
    let answer: (v: { status: number; body?: unknown }) => void = () => {}
    const r = rig(() => new Promise((res) => (answer = res)) as never)
    r.heading(100)
    await r.run(300)
    const n = r.views.length
    r.session.stop()
    answer(door(70, 8)({ headingDeg: 100 }))
    await r.run(500)
    expect(r.views.length).toBe(n)
  })
})

describe('Narrator: reminders', () => {
  it('a bumped seq says the same instruction again', () => {
    const n = new Narrator('de')
    const v: ApproachView = { phase: 'walking', relBearingDeg: -30, distanceM: 5, instruction: 'Links 5 Meter', source: 'gemini-frame', unsure: false }
    expect(n.next(v)).not.toBeNull()
    expect(n.next({ ...v })).toBeNull()
    expect(n.next({ ...v, seq: 1 })?.text).toBe('Links 5 Meter')
    expect(n.next({ ...v, seq: 1 })).toBeNull()
  })
})

describe('ClipPlayer: stale directions never pile up', () => {
  it('a queued band or distance is dropped when a newer view arrives; one-off lines stay', async () => {
    const played: string[] = []
    let release: () => void = () => {}
    const p = new ClipPlayer({
      playClip: async () => false,
      speakLive: (text) => {
        played.push(text)
        return new Promise<void>((r) => (release = r))
      },
      stop: () => {},
    })
    const left = bandText(bandFor(-60), 'de')
    const straight = bandText(bandFor(0), 'de')
    void p.playInstruction(safetyLine('de'), 'de') // playing now
    void p.playInstruction(`${left} 5 Meter`, 'de') // queued
    void p.playInstruction(`${fallbackLine('de')} ${straight}`, 'de') // newer: left + 5 m are stale
    for (let i = 0; i < 5; i++) {
      release()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(played).toEqual([safetyLine('de'), fallbackLine('de'), straight])
    expect(isTransient({ text: '5 Meter', key: null }, 'de')).toBe(true)
    expect(isTransient({ text: fallbackLine('de'), key: null }, 'de')).toBe(false)
  })
})
