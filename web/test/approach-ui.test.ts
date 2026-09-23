import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AP, checkRows, Narrator } from '../src/ui/Approach'
import { approachModeFor, parseDoorCheck, UNCLEAR, type ApproachView } from '../src/ui/approachPort'
import { DEMO_SCRIPT } from '../src/ui/approachDemo'
import { groundPlane, stackTransform } from '../src/ui/ar'

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

describe('Narrator: what is said aloud', () => {
  it('speaks the safety line exactly once, at the start, before the first instruction', () => {
    const n = new Narrator()
    const all = [
      ...n.next(view()),
      ...n.next(view()),
      ...n.next(view({ instruction: 'Geradeaus', phase: 'walking' })),
      ...n.next(view({ instruction: 'Die Tür ist direkt vor dir.', phase: 'threshold' })),
    ]
    expect(all.filter((l) => l === AP.safety)).toHaveLength(1)
    expect(all[0]).toBe(AP.safety)
  })
  it('speaks an instruction only when it changes (no "links ... links ... links")', () => {
    const n = new Narrator()
    n.next(view())
    expect(n.next(view({ relBearingDeg: -18 }))).toEqual([])
    expect(n.next(view({ instruction: 'Geradeaus' }))).toEqual(['Geradeaus'])
  })
  it('names the map as the source when vision falls back, once per switch', () => {
    const n = new Narrator()
    n.next(view())
    expect(n.next(view({ source: 'osm-fallback' }))).toEqual([AP.fromMap])
    expect(n.next(view({ source: 'osm-fallback' }))).toEqual([])
    n.next(view({ source: 'gemini-frame' }))
    expect(n.next(view({ source: 'osm-fallback' }))).toEqual([AP.fromMap])
  })
  it('passes the engine words through verbatim', () => {
    const n = new Narrator()
    expect(n.next(view({ instruction: 'Ich bin mir gerade unsicher.' }))).toContain('Ich bin mir gerade unsicher.')
  })
})

describe('wheelchair verdict: unsure renders unklar', () => {
  it('garbage, 404 bodies and missing fields are all unclear', () => {
    expect(parseDoorCheck(null)).toEqual(UNCLEAR)
    expect(parseDoorCheck('nope')).toEqual(UNCLEAR)
    expect(parseDoorCheck({ detail: 'Not Found' })).toEqual(UNCLEAR)
  })
  it('low confidence makes every field unclear', () => {
    expect(parseDoorCheck({ step: false, widthCm: 90, opens: 'automatic', confidence: 0.3 })).toEqual(UNCLEAR)
  })
  it('keeps what the model is sure of and blanks the rest', () => {
    expect(parseDoorCheck({ step: 'no', widthCm: null, opens: 'magic' })).toEqual({ step: 'no', widthCm: null, opens: 'unclear' })
    expect(parseDoorCheck({ step: false, widthCm: 88, opens: 'automatic', confidence: 0.9 })).toEqual({ step: 'no', widthCm: 88, opens: 'automatic' })
  })
  it('implausible widths are unclear, never shown', () => {
    expect(parseDoorCheck({ widthCm: 5 }).widthCm).toBeNull()
    expect(parseDoorCheck({ widthCm: Number.NaN }).widthCm).toBeNull()
  })
  it('card rows say unklar for every unclear field', () => {
    expect(checkRows(UNCLEAR).map(([, v]) => v)).toEqual([AP.unclear, AP.unclear, AP.unclear])
    expect(checkRows({ step: 'no', widthCm: 88, opens: 'push' })[1][1]).toBe(AP.widthCm(90))
  })
})

describe('ground-plane chevrons', () => {
  it('without pitch the transform is the old fixed placement', () => {
    expect(stackTransform(0, 393, 760)).toBe('translate(196.5 334.4) rotate(-90.0) scale(1.350 1.35) translate(-128 -40)')
    expect(stackTransform(30, 393, 760, null)).toBe(stackTransform(30, 393, 760))
  })
  it('flattens more the more upright the phone is', () => {
    const s90 = groundPlane(90).squash
    const s60 = groundPlane(60).squash
    const s20 = groundPlane(20).squash
    expect(s90).toBeLessThan(s60)
    expect(s60).toBeLessThan(s20)
    expect(s20).toBeCloseTo(1, 5)
    expect(s90).toBeGreaterThan(0.2) // never collapses to a line
  })
  it('the pavement patch moves up the screen as the phone tilts down, within bounds', () => {
    expect(groundPlane(90).cyFrac).toBeGreaterThan(groundPlane(70).cyFrac)
    expect(groundPlane(70).cyFrac).toBeGreaterThan(groundPlane(50).cyFrac)
    for (const b of [-30, 0, 45, 90, 180]) {
      const g = groundPlane(b)
      expect(g.cyFrac).toBeGreaterThanOrEqual(0.36)
      expect(g.cyFrac).toBeLessThanOrEqual(0.64)
    }
  })
  it('only adds a vertical squash in front of the unchanged chevron transform', () => {
    const t = stackTransform(-20, 393, 760, 75)
    expect(t).toMatch(/^translate\(196\.5 [\d.]+\) scale\(1 0\.\d{3}\) rotate\(-110\.0\)/)
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
