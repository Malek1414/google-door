import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atDoorLine, fallbackLine, noDirectionLine, safetyLine, thresholdLine, throughLine, unsureLine } from '../src/core/instruct'
import { guideLayout, Narrator } from '../src/ui/Approach'
import { approachModeFor, type ApproachView } from '../src/ui/approachPort'
import { DEMO_SCRIPT, startDemoApproach } from '../src/ui/approachDemo'
import { lang } from '../src/strings'

const view = (o: Partial<ApproachView> = {}): ApproachView => ({
  phase: 'orienting', relBearingDeg: -20, distanceM: 7, instruction: 'Leicht links', source: 'gemini-live', unsure: false, ...o,
})

describe('approachModeFor: who sees the trigger', () => {
  it('deaf-only profiles get no button', () => {
    expect(approachModeFor({ stepFreeRequired: false, channels: ['visual'] })).toBeNull()
    expect(approachModeFor({ stepFreeRequired: false, channels: ['visual', 'haptic'] })).toBeNull()
  })
  it('speech profiles get the guidance loop', () => {
    expect(approachModeFor({ stepFreeRequired: false, channels: ['speech'] })).toBe('guide')
    expect(approachModeFor({ stepFreeRequired: false, channels: ['speech', 'visual'] })).toBe('guide')
  })
  it('step-free profiles get the one-shot verdict', () => {
    expect(approachModeFor({ stepFreeRequired: true, channels: ['visual'] })).toBe('check')
    expect(approachModeFor({ stepFreeRequired: true, channels: ['speech', 'visual'] })).toBe('check')
  })
  it('an empty channel list means all channels, as in outputFor', () => {
    expect(approachModeFor({ stepFreeRequired: false, channels: [] })).toBe('guide')
  })
  it('no profile, no button', () => {
    expect(approachModeFor(null)).toBeNull()
  })
})

describe('Narrator: when the screen speaks', () => {
  const said = (n: Narrator, vs: ApproachView[]) => vs.map((v) => n.next(v)).filter((x) => x !== null)
  it('the engine opens with the safety line; it is spoken once and interrupts nothing (iOS drops a line spoken right after cancel)', () => {
    const n = new Narrator('de')
    const out = said(n, [
      view({ instruction: safetyLine('de'), relBearingDeg: null, source: null }),
      view({ instruction: safetyLine('de'), relBearingDeg: null, source: null }),
      view({ instruction: 'Links' }),
      view({ instruction: 'Geradeaus', phase: 'walking' }),
      view({ instruction: 'Die Tür ist direkt vor dir.', phase: 'threshold' }),
    ])
    expect(out.filter((x) => x.text.includes(safetyLine('de')))).toHaveLength(1)
    expect(out[0]).toEqual({ text: safetyLine('de'), interrupt: false })
    expect(out.every((x) => !x.interrupt)).toBe(true)
  })
  it('adds nothing of its own: the fallback line comes from the engine, verbatim', () => {
    const n = new Narrator('de')
    n.next(view({ instruction: safetyLine('de') }))
    const fb = `${fallbackLine('de')} Links`
    expect(n.next(view({ instruction: fb, source: 'osm-fallback' }))).toEqual({ text: fb, interrupt: false })
    expect(n.next(view({ instruction: fb, source: 'osm-fallback' }))).toBeNull()
  })
  it('speaks an instruction only when it changes (no "links ... links ... links")', () => {
    const n = new Narrator('de')
    n.next(view())
    expect(n.next(view({ relBearingDeg: -18 }))).toBeNull()
    expect(n.next(view({ instruction: 'Geradeaus' }))).toEqual({ text: 'Geradeaus', interrupt: false })
  })
  it('a band re-said after a lost fix is spoken again, not swallowed as a duplicate', () => {
    const n = new Narrator('de')
    expect(n.next(view({ instruction: 'Links' }))?.text).toBe('Links')
    // Fix lost: no bearing, the engine keeps the old words.
    expect(n.next(view({ instruction: 'Links', relBearingDeg: null }))).toBeNull()
    // Fix back: the engine says the band again, the same word.
    expect(n.next(view({ instruction: 'Links', relBearingDeg: -30 }))?.text).toBe('Links')
    // ...but only once.
    expect(n.next(view({ instruction: 'Links', relBearingDeg: -28 }))).toBeNull()
  })
  it('the opening safety line (no bearing yet) is still said only once', () => {
    const n = new Narrator('de')
    const s0 = view({ instruction: safetyLine('de'), relBearingDeg: null, source: null })
    expect(n.next(s0)).not.toBeNull()
    expect(n.next({ ...s0, unsure: true })).toBeNull()
  })
  it('the screen holds no spoken wording of its own', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/Approach.ts'), 'utf8')
    expect(src).not.toContain('Ich führe dich nur zur Tür')
    expect(src).not.toMatch(/AP\.safety/)
  })
})

describe('boundaries', () => {
  const src = (f: string) => readFileSync(resolve(__dirname, '../src/ui', f), 'utf8')
  it('the Approach screen never touches GPS', () => {
    expect(src('Approach.ts')).not.toContain('navigator.geolocation')
    expect(src('approachPort.ts')).not.toContain('navigator.geolocation')
  })
  it('no custom double-tap handler on the trigger', () => {
    expect(src('LiveView.ts')).not.toMatch(/dblclick|doubletap|double-tap'/i)
    expect(src('Approach.ts')).not.toMatch(/dblclick|doubletap/i)
  })
  it('the demo script covers every phase', () => {
    expect(new Set(DEMO_SCRIPT.map((v) => v.phase))).toEqual(new Set(['orienting', 'walking', 'threshold', 'through']))
  })
})

describe('guide screen: through, no direction, safety line', () => {
  it('"Noch draußen" exists only in through', () => {
    for (const phase of ['orienting', 'walking', 'threshold'] as const) expect(guideLayout(view({ phase })).outsideButton).toBe(false)
    expect(guideLayout(view({ phase: 'through', relBearingDeg: null, instruction: throughLine('de') })).outsideButton).toBe(true)
  })
  it('the metres are shown once: the words under the big distance drop a repeat of it', () => {
    expect(guideLayout(view({ distanceM: 5, instruction: '5 Meter' }), 'de').instruction).toBe('')
    expect(guideLayout(view({ distanceM: 5, instruction: 'Leicht links 5 Meter' }), 'de').instruction).toBe('Leicht links')
    expect(guideLayout(view({ distanceM: 1, instruction: 'Die Tür ist direkt vor dir.' }), 'de').instruction).toBe('Die Tür ist direkt vor dir.')
    expect(guideLayout(view({ distanceM: null, instruction: 'Geradeaus' }), 'de').instruction).toBe('Geradeaus')
    // The spoken metres lag the live distance: a stale "5 Meter" under a big "3 Meter" is dropped too.
    expect(guideLayout(view({ distanceM: 3, instruction: 'Leicht links 5 Meter' }), 'de').instruction).toBe('Leicht links')
    expect(guideLayout(view({ distanceM: 3, instruction: '5 Meter' }), 'de').instruction).toBe('')
    expect(guideLayout(view({ distanceM: 3, instruction: 'Geradeaus Ein Meter.' }), 'de').instruction).toBe('Geradeaus')
    expect(guideLayout(view({ distanceM: 3, instruction: 'Slightly left 8 metres' }), 'en').instruction).toBe('Slightly left')
  })
  it('no direction after the start: no arrow, the engine line is the text', () => {
    const v = view({ relBearingDeg: null, source: null, distanceM: null, instruction: noDirectionLine('de') })
    const lay = guideLayout(v, 'de')
    expect(lay.arrow).toBe(false)
    expect(lay.noDirection).toBe(true)
    expect(lay.distance).toBe('')
    expect(guideLayout(view()).arrow).toBe(true)
  })
  it('the safety line stays on screen once the engine moves on', () => {
    expect(guideLayout(view({ instruction: safetyLine('de') }), 'de').safety).toBe(false)
    expect(guideLayout(view(), 'de').safety).toBe(true)
  })
  it('after stillOutside the next threshold line is spoken again', () => {
    const n = new Narrator('de')
    expect(n.next(view({ phase: 'threshold', instruction: thresholdLine('de') }))).not.toBeNull()
    n.next(view({ phase: 'through', instruction: throughLine('de') }))
    n.reset()
    expect(n.next(view({ phase: 'through', instruction: throughLine('de') }))?.text).toBe(throughLine('de'))
  })
  it('the screen builds no wording or pitch of its own', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/Approach.ts'), 'utf8')
    expect(src).not.toMatch(/pitchFor|Math\.pow|\*\s*closeness|Die Tür ist|Du müsstest|t\.metres/)
  })
})

describe('demo adapter: through, stillOutside, no direction', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('the stage script is the happy path: no failure lines, no metres at the door, ends in through', () => {
    const failures = [noDirectionLine(lang), fallbackLine(lang), unsureLine(lang)]
    expect(DEMO_SCRIPT.some((v) => failures.some((f) => v.instruction.includes(f)))).toBe(false)
    expect(DEMO_SCRIPT.find((v) => v.phase === 'threshold')?.instruction).toBe(thresholdLine(lang))
    expect(DEMO_SCRIPT.at(-1)?.phase).toBe('through')
  })
  it('stillOutside returns to threshold, then through is proposed again', () => {
    const run = startDemoApproach({} as never)
    const seen: ApproachView[] = []
    run.subscribe((v) => seen.push(v))
    vi.advanceTimersByTime(2500 * DEMO_SCRIPT.length)
    expect(seen.at(-1)?.phase).toBe('through')
    run.stillOutside()
    expect(seen.at(-1)?.phase).toBe('threshold')
    vi.advanceTimersByTime(4000)
    expect(seen.at(-1)?.phase).toBe('through')
    // Proposed by standing still, as in the engine: "an der Tür", not "drin".
    expect(seen.at(-1)?.instruction).toBe(throughLine(lang))
    run.stop()
  })
})
