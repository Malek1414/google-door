// The voice speaks when something changes (Sami: "it plays all the time").
import { describe, expect, it } from 'vitest'
import { directionWord } from '../src/ui/LiveView'
import { Narrator } from '../src/ui/Approach'
import type { ApproachView } from '../src/ui/approachPort'
import { safetyLine, thresholdLine } from '../src/core/instruct'
import { CalmWord, LineGate, MIN_GAP_MS, WORD_HOLD_MS } from '../src/ui/voiceCalm'

/** Deterministic noise in [-1, 1]. */
const n = (i: number) => Math.sin(i * 12.9898) * Math.cos(i * 4.1414)

describe('voice calm', () => {
  it('a 60 s jittery walk (heading ±15°, drifting across a band edge) speaks at most 6 lines', () => {
    const word = new CalmWord(directionWord)
    const gate = new LineGate()
    let last = ''
    const spoken: string[] = []
    for (let i = 0; i < 600; i++) {
      const tMs = i * 100
      // Door drifts from 30° right to straight ahead over the minute, with jitter.
      const rel = 30 - (30 * i) / 600 + 15 * n(i)
      const w = word.propose(rel, tMs)
      if (w !== last && gate.allow(w, tMs)) {
        last = w
        spoken.push(w)
      }
    }
    expect(spoken.length).toBeGreaterThanOrEqual(1)
    expect(spoken.length).toBeLessThanOrEqual(6)
  })

  it('a real turn still changes the word, after WORD_HOLD_MS', () => {
    const word = new CalmWord(directionWord)
    expect(word.propose(0, 0)).toBe(directionWord(0))
    let t = 0
    let changedAt = -1
    for (; t <= 4000; t += 100) if (word.propose(-90, t) === directionWord(-90) && changedAt < 0) changedAt = t
    expect(changedAt).toBeGreaterThanOrEqual(WORD_HOLD_MS)
    expect(changedAt).toBeLessThanOrEqual(WORD_HOLD_MS + 200)
  })

  it('flicker across a boundary never changes the word', () => {
    const word = new CalmWord(directionWord)
    const first = word.propose(40, 0)
    for (let t = 100; t < 20000; t += 100) expect(word.propose(t % 200 ? 44 : 50, t)).toBe(first)
  })

  it('LineGate: minimum gap, no repeat within 20 s, urgent skips only the gap', () => {
    const g = new LineGate()
    expect(g.allow('Links', 0)).toBe(true)
    expect(g.allow('Rechts', MIN_GAP_MS - 1)).toBe(false)
    expect(g.allow('Rechts', MIN_GAP_MS)).toBe(true)
    expect(g.allow('Links', MIN_GAP_MS * 1.5)).toBe(false) // repeat inside 20 s
    expect(g.allow('Achtung', MIN_GAP_MS + 1, { urgent: true })).toBe(true)
  })

  // Merge note: Sami's variant gated the approach narrator with LineGate (10 s gap). Main
  // paces the last 10 m in the engine instead (band debounce BAND_HOLD_MS/BAND_GAP_MS,
  // QUIET_MS reminders): at walking pace 10 s is the whole approach, so a correction
  // must not wait for a gap. The narrator only dedupes.
  it('approach narrator: no 10 s gap in the last 10 m, the engine paces it', () => {
    const nar = new Narrator('de')
    const v = (instruction: string): ApproachView => ({ phase: 'walking', relBearingDeg: 0, distanceM: 5, instruction, source: 'gemini-frame', unsure: false })
    expect(nar.next(v(safetyLine('de')))).not.toBeNull()
    expect(nar.next(v('Links'))?.text).toBe('Links')
    expect(nar.next(v('Links'))).toBeNull() // same line, same seq: said once
    expect(nar.next(v(thresholdLine('de')))).not.toBeNull()
  })
})
