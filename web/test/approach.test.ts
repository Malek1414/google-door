import { describe, expect, it } from 'vitest'
import { Approach, AIMED_DEG, LOST_AIM_DEG, THRESHOLD_M, STILL_MS } from '../src/core/approach'
import { MAX_AGE_MS, type Anchor } from '../src/core/anchor'

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  bearingDeg: -40, headingDeg: 100, distanceM: 9, steps: 0, ts: 1000, source: 'gemini-live', ...over,
})

describe('Approach', () => {
  it('starts by orienting — you cannot walk before you are aimed', () => {
    const a = new Approach()
    a.setAnchor(anchor())
    expect(a.tick({ headingDeg: 100, steps: 0, nowMs: 1000 }).phase).toBe('orienting')
  })

  it('asks for a fix rather than guessing when it has none', () => {
    const st = new Approach().tick({ headingDeg: 0, steps: 0, nowMs: 0 })
    expect(st.projection).toBeNull()
    expect(st.needsFix).toBe(true)
  })

  it('moves to walking once the user is aimed', () => {
    const a = new Approach()
    a.setAnchor(anchor())
    // turn left 40 deg to face the door
    expect(a.tick({ headingDeg: 60, steps: 0, nowMs: 1200 }).phase).toBe('walking')
  })

  it('does not bounce back to orienting when the user sways', () => {
    const a = new Approach()
    a.setAnchor(anchor())
    a.tick({ headingDeg: 60, steps: 0, nowMs: 1200 })        // walking
    const sway = a.tick({ headingDeg: 60 + AIMED_DEG + 10, steps: 2, nowMs: 1600 })
    expect(sway.phase).toBe('walking')
  })

  it('re-orients only when properly off course', () => {
    const a = new Approach()
    a.setAnchor(anchor())
    a.tick({ headingDeg: 60, steps: 0, nowMs: 1200 })
    const lost = a.tick({ headingDeg: 60 + LOST_AIM_DEG + 10, steps: 2, nowMs: 1600 })
    expect(lost.phase).toBe('orienting')
  })

  it('reaches the threshold as the distance closes', () => {
    const a = new Approach()
    a.setAnchor(anchor({ bearingDeg: 0, distanceM: 9 }))
    a.tick({ headingDeg: 100, steps: 0, nowMs: 1100 })
    const near = a.tick({ headingDeg: 100, steps: 13, nowMs: 3000 }) // ~8.8 m walked
    expect(near.projection!.distanceM).toBeLessThanOrEqual(THRESHOLD_M)
    expect(near.phase).toBe('threshold')
  })

  it('vision proposes "through", the user can take it back', () => {
    const a = new Approach()
    a.setAnchor(anchor({ bearingDeg: 0, distanceM: 1 }))
    a.tick({ headingDeg: 100, steps: 0, nowMs: 1100 })
    a.visionSaysInside()
    expect(a.tick({ headingDeg: 100, steps: 1, nowMs: 1400 }).phase).toBe('through')
    a.stillOutside()
    expect(a.tick({ headingDeg: 100, steps: 1, nowMs: 1600 }).phase).not.toBe('through')
  })

  it('reports a lost fix once, then stops guiding from it', () => {
    const a = new Approach()
    a.setAnchor(anchor())
    a.tick({ headingDeg: 100, steps: 0, nowMs: 1100 })
    const first = a.tick({ headingDeg: 100, steps: 0, nowMs: 1000 + MAX_AGE_MS + 50 })
    expect(first.lostFix).toBe(true)
    expect(first.needsFix).toBe(true)
    const second = a.tick({ headingDeg: 100, steps: 0, nowMs: 1000 + MAX_AGE_MS + 200 })
    expect(second.lostFix).toBe(false) // announced once, not repeatedly
  })

  it('stays silent about distance while the user is standing still orienting', () => {
    const a = new Approach()
    a.setAnchor(anchor())
    expect(a.tick({ headingDeg: 100, steps: 0, nowMs: 1100 }).speakDistanceM).toBeNull()
  })

  it('announces each distance step once', () => {
    const a = new Approach()
    a.setAnchor(anchor({ bearingDeg: 0, distanceM: 12 }))
    const said: number[] = []
    for (let step = 0; step <= 18; step++) {
      const st = a.tick({ headingDeg: 100, steps: step, nowMs: 1100 + step * 200 })
      if (st.speakDistanceM !== null) said.push(st.speakDistanceM)
    }
    expect(said).toEqual([...new Set(said)])          // no repeats
    expect(said).toEqual([...said].sort((x, y) => y - x)) // counting down
  })

  it('names the source so a fallback is never passed off as a sighting', () => {
    const a = new Approach()
    a.setAnchor(anchor({ source: 'osm-fallback' }))
    expect(a.tick({ headingDeg: 100, steps: 0, nowMs: 1100 }).projection!.source).toBe('osm-fallback')
  })
})

describe('reaching "through" — the gap PR #5 found', () => {
  // core had visionSaysInside() but nothing could call it honestly, and the spec's
  // "the threshold phase ends when the user stops" was never implemented, so the
  // phase was unreachable with the real engine.
  const at = (over: Partial<Anchor> = {}): Anchor => ({
    bearingDeg: 0, headingDeg: 100, distanceM: 1.2, steps: 10, ts: 1000, source: 'gemini-live', ...over,
  })

  /** Ticks at 200 ms until `through`, or gives up. Asserting on behaviour rather than
   *  hardcoded timestamps: the stillness clock starts on the second tick, because the
   *  first establishes the step baseline. */
  function tickUntilThrough(a: Approach, steps = 10, limitMs = 15000): number | null {
    let t = 1100
    while (t < 1100 + limitMs) {
      if (a.tick({ headingDeg: 100, steps, nowMs: t }).phase === 'through') return t - 1100
      t += 200
    }
    return null
  }

  it('lands in threshold on the first tick when already aimed and close', () => {
    const a = new Approach()
    a.setAnchor(at())
    expect(a.tick({ headingDeg: 100, steps: 10, nowMs: 1100 }).phase).toBe('threshold')
  })

  it('standing still at the threshold proposes through, after about STILL_MS', () => {
    const a = new Approach()
    a.setAnchor(at())
    const elapsed = tickUntilThrough(a)
    expect(elapsed).not.toBeNull()
    expect(elapsed!).toBeGreaterThanOrEqual(STILL_MS)
    expect(elapsed!).toBeLessThan(STILL_MS + 1500)
  })

  it('a pause while still walking does not propose it', () => {
    const a = new Approach()
    a.setAnchor(at({ distanceM: 6 }))
    a.tick({ headingDeg: 100, steps: 10, nowMs: 1100 })          // walking
    const st = a.tick({ headingDeg: 100, steps: 10, nowMs: 1100 + STILL_MS + 500 })
    expect(st.phase).toBe('walking')  // stillness only counts at the threshold
  })

  it('taking a step resets the stillness clock', () => {
    const a = new Approach()
    a.setAnchor(at())
    a.tick({ headingDeg: 100, steps: 10, nowMs: 1100 })
    a.tick({ headingDeg: 100, steps: 10, nowMs: 1100 + STILL_MS - 200 })
    a.tick({ headingDeg: 100, steps: 11, nowMs: 1100 + STILL_MS - 100 })  // moved
    expect(a.tick({ headingDeg: 100, steps: 11, nowMs: 1100 + STILL_MS + 300 }).phase).toBe('threshold')
  })

  it('"Noch draußen" takes it back and does not immediately re-propose', () => {
    const a = new Approach()
    a.setAnchor(at())
    const first = tickUntilThrough(a)
    expect(first).not.toBeNull()
    a.stillOutside()
    let t = 1100 + first! + 200
    // it must hold at threshold for at least another full still period
    for (let i = 0; i < Math.floor(STILL_MS / 200); i++) {
      expect(a.tick({ headingDeg: 100, steps: 10, nowMs: t }).phase).toBe('threshold')
      t += 200
    }
  })

  it('vision can still propose it directly, and immediately', () => {
    const a = new Approach()
    a.setAnchor(at())
    a.tick({ headingDeg: 100, steps: 10, nowMs: 1100 })
    a.visionSaysInside()
    expect(a.tick({ headingDeg: 100, steps: 10, nowMs: 1200 }).phase).toBe('through')
  })
})
