import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fallbackLine, safetyLine } from '../src/core/instruct'
import { Narrator } from '../src/ui/Approach'
import { approachModeFor, type ApproachView } from '../src/ui/approachPort'
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

describe('Narrator: when the screen speaks', () => {
  const said = (n: Narrator, vs: ApproachView[]) => vs.map((v) => n.next(v)).filter((x) => x !== null)
  it('the engine opens with the safety line; it is spoken once, and only it interrupts', () => {
    const n = new Narrator('de')
    const out = said(n, [
      view({ instruction: safetyLine('de'), relBearingDeg: null, source: null }),
      view({ instruction: safetyLine('de'), relBearingDeg: null, source: null }),
      view({ instruction: 'Links' }),
      view({ instruction: 'Geradeaus', phase: 'walking' }),
      view({ instruction: 'Die Tür ist direkt vor dir.', phase: 'threshold' }),
    ])
    expect(out.filter((x) => x.text.includes(safetyLine('de')))).toHaveLength(1)
    expect(out[0]).toEqual({ text: safetyLine('de'), interrupt: true })
    expect(out.slice(1).every((x) => !x.interrupt)).toBe(true)
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
  it('the screen holds no spoken wording of its own', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/Approach.ts'), 'utf8')
    expect(src).not.toContain('Ich führe dich nur zur Tür')
    expect(src).not.toMatch(/AP\.safety/)
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
