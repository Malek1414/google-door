// The four modules composed exactly as the Approach screen will use them.
//
// The unit tests prove each module alone. This proves they fit together, and doubles
// as the worked example for whoever builds the screen: if your code does not look
// roughly like `tick()` below, check the brief.
import { describe, expect, it } from 'vitest'
import { Approach, type Phase } from '../src/core/approach'
import { StabilityGuard } from '../src/core/stability'
import { bandFor, bandText, shouldSpeakDistance, safetyLine, fallbackLine } from '../src/core/instruct'
import { needsReanchor, STEP_M, type Anchor } from '../src/core/anchor'

/** What a screen would hold. */
function makeSession() {
  const approach = new Approach()
  const guard = new StabilityGuard()
  const spoken: string[] = []
  let anchor: Anchor | null = null

  return {
    spoken,
    start() {
      spoken.push(safetyLine('de')) // said once, before anything else
    },
    /** A fix arrives from /api/door-fix or the Live stream. */
    onFix(f: { bearingDeg: number; distanceM: number; confidence: number }, headingDeg: number, steps: number, nowMs: number) {
      const verdict = guard.push({ bearingDeg: f.bearingDeg, headingDeg, confidence: f.confidence })
      if (!verdict.trusted) return verdict
      anchor = { ...f, headingDeg, steps, ts: nowMs, source: 'gemini-live' }
      approach.setAnchor(anchor)
      return verdict
    },
    /** 60 Hz. Everything the screen renders comes from here. */
    tick(headingDeg: number, steps: number, nowMs: number) {
      const st = approach.tick({ headingDeg, steps, nowMs })
      if (st.projection) {
        if (st.projection.source === 'osm-fallback') spoken.push(fallbackLine('de'))
        const band = bandText(st.band, 'de')
        if (spoken[spoken.length - 1] !== band) spoken.push(band)
        if (st.speakDistanceM !== null) spoken.push(`${st.speakDistanceM} Meter`)
      }
      return st
    },
    approach,
    guard,
    needsFix: (headingDeg: number, steps: number, nowMs: number) =>
      anchor ? needsReanchor(anchor, headingDeg, steps, nowMs) : true,
  }
}

describe('a whole approach, module by module', () => {
  it('orients, walks, reaches the threshold and finishes', () => {
    const s = makeSession()
    s.start()
    let t = 1000

    // door is 40 deg to the left, 9 m away; user faces 100 deg
    s.onFix({ bearingDeg: -40, distanceM: 9, confidence: 0.9 }, 100, 0, t)
    const phases: Phase[] = []

    // turn left toward it
    for (let h = 100; h >= 60; h -= 10) { t += 200; phases.push(s.tick(h, 0, t).phase) }
    expect(phases).toContain('orienting')
    expect(phases.at(-1)).toBe('walking')

    // walk it in
    for (let step = 1; step <= 14; step++) { t += 400; phases.push(s.tick(60, step, t).phase) }
    expect(phases.at(-1)).toBe('threshold')

    // vision says inside
    s.approach.visionSaysInside()
    t += 300
    expect(s.tick(60, 14, t).phase).toBe('through')

    // the safety line is said once, first, and never repeated
    expect(s.spoken[0]).toBe(safetyLine('de'))
    expect(s.spoken.filter((x) => x === safetyLine('de'))).toHaveLength(1)
  })

  it('says each distance once and counts down', () => {
    const s = makeSession()
    let t = 1000
    s.onFix({ bearingDeg: 0, distanceM: 11, confidence: 0.9 }, 100, 0, t)
    for (let step = 0; step <= 18; step++) { t += 300; s.tick(100, step, t) }
    const metres = s.spoken.filter((x) => x.endsWith('Meter')).map((x) => parseInt(x))
    expect(metres).toEqual([...new Set(metres)])
    expect(metres).toEqual([...metres].sort((a, b) => b - a))
  })

  it('never repeats the same instruction twice in a row', () => {
    const s = makeSession()
    let t = 1000
    s.onFix({ bearingDeg: -30, distanceM: 8, confidence: 0.9 }, 100, 0, t)
    for (let i = 0; i < 20; i++) { t += 150; s.tick(100, 0, t) }
    for (let i = 1; i < s.spoken.length; i++) expect(s.spoken[i]).not.toBe(s.spoken[i - 1])
  })

  it('a hallucinating stream stops being trusted and drops to on-demand', () => {
    const s = makeSession()
    let t = 1000
    s.onFix({ bearingDeg: -20, distanceM: 8, confidence: 0.9 }, 100, 0, t)
    t += 300
    const a = s.onFix({ bearingDeg: 35, distanceM: 8, confidence: 0.9 }, 100, 0, t) // door jumped, phone did not
    expect(a.unstable).toBe(true)
    t += 300
    const b = s.onFix({ bearingDeg: -35, distanceM: 8, confidence: 0.9 }, 100, 0, t)
    expect(b.mode).toBe('ondemand')
    expect(s.guard.hasFallenBack).toBe(true)
  })

  it('an untrusted fix never becomes the anchor', () => {
    const s = makeSession()
    let t = 1000
    s.onFix({ bearingDeg: -20, distanceM: 8, confidence: 0.9 }, 100, 0, t)
    const before = s.tick(100, 0, t + 100).projection!.relBearingDeg
    t += 300
    s.onFix({ bearingDeg: 60, distanceM: 8, confidence: 0.9 }, 100, 0, t) // unstable, rejected
    const after = s.tick(100, 0, t + 100).projection!.relBearingDeg
    expect(after).toBeCloseTo(before, 1)
  })

  it('asks for a new fix after the user turns or walks far enough', () => {
    const s = makeSession()
    s.onFix({ bearingDeg: 0, distanceM: 9, confidence: 0.9 }, 100, 0, 1000)
    expect(s.needsFix(100, 0, 1200)).toBe(false)
    expect(s.needsFix(140, 0, 1200)).toBe(true)
    expect(s.needsFix(100, Math.ceil(4 / STEP_M), 1200)).toBe(true)
  })

  it('an osm fallback is announced as one, not passed off as a sighting', () => {
    const s = makeSession()
    s.approach.setAnchor({ bearingDeg: 20, headingDeg: 100, distanceM: 7, steps: 0, ts: 1000, source: 'osm-fallback' })
    s.tick(100, 0, 1100)
    expect(s.spoken).toContain(fallbackLine('de'))
  })

  it('bands and their words stay in step', () => {
    for (const [deg, word] of [[0,'Geradeaus'],[-15,'Leicht links'],[50,'Rechts'],[-100,'Scharf links'],[170,'Dreh dich um']] as const) {
      expect(bandText(bandFor(deg), 'de')).toBe(word)
    }
  })

  it('distance is silent while orienting — the number is not changing', () => {
    const s = makeSession()
    s.onFix({ bearingDeg: -50, distanceM: 9, confidence: 0.9 }, 100, 0, 1000)
    s.tick(100, 0, 1100)
    expect(s.spoken.filter((x) => x.endsWith('Meter'))).toHaveLength(0)
    expect(shouldSpeakDistance(null, 9)).toBe(10) // would have spoken, had it been walking
  })
})
