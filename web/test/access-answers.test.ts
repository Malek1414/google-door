import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALL_QUESTIONS,
  applyAnswers,
  answersFromEntrance,
  deleteAnswers,
  deriveStepFree,
  emptyAnswers,
  loadAnswers,
  normalizeAnswers,
  parseNumber,
  progress,
  saveAnswers,
  validate,
  type AccessAnswers,
} from '../src/core/accessAnswers'
import { makeSurveyEntrance, mergeSurvey, type SurveyEntrance } from '../src/core/survey'
import { guidanceFor } from '../src/core/target'

const DOOR = { lat: 52.523073, lon: 13.392169 }
const ans = (over: Partial<AccessAnswers> = {}): AccessAnswers => ({ ...emptyAnswers(), ...over })
const door = (over: Partial<SurveyEntrance> = {}): SurveyEntrance => ({
  ...makeSurveyEntrance({ ...DOOR, stepFree: null, by: 'business', businessId: 'biz/1' }),
  ...over,
})

describe('questions', () => {
  it('covers every answer key exactly once', () => {
    const keys = ALL_QUESTIONS.map((q) => q.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.sort()).toEqual(Object.keys(emptyAnswers()).sort())
  })
  it('counts only applicable, answered questions', () => {
    const empty = progress(emptyAnswers())
    expect(empty.done).toBe(0)
    // Step-free "Ja" hides step count and step height.
    const p = progress(ans({ stepFree: true, doorWidthCm: 90, note: 'Hallo' }))
    expect(p.total).toBe(empty.total - 2)
    expect(p.done).toBe(3)
  })
})

describe('parseNumber and validate', () => {
  it('parses comma decimals, empty is null, junk is NaN', () => {
    expect(parseNumber(' 7,5 ')).toBe(7.5)
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('abc')).toBeNaN()
  })
  it('flags out-of-range numbers in German', () => {
    const e = validate(ans({ doorWidthCm: 5, stepCount: 2.5, rampSlopePct: NaN }))
    expect(e.doorWidthCm).toMatch(/zwischen 40 und 400 cm/)
    expect(e.stepCount).toMatch(/ganze Zahl/)
    expect(e.rampSlopePct).toMatch(/Zahl/)
    expect(validate(ans({ doorWidthCm: 90 }))).toEqual({})
  })
  it('rejects "stufenlos Ja" with a threshold above 2 cm', () => {
    expect(validate(ans({ stepFree: true, thresholdCm: 4 })).thresholdCm).toMatch(/nicht als stufenlos/)
    expect(validate(ans({ stepFree: true, thresholdCm: 2 }))).toEqual({})
  })
})

describe('deriveStepFree (safety)', () => {
  it('"Weiß nicht" stays null, never false', () => {
    expect(deriveStepFree(emptyAnswers())).toBeNull()
    expect(deriveStepFree(ans({ ramp: true, doorWidthCm: 120, automatic: true }))).toBeNull()
  })
  it('a ramp or a wide door alone never makes a door step-free', () => {
    expect(deriveStepFree(ans({ ramp: true, stepCount: 0, thresholdCm: 0 }))).toBeNull()
  })
  it('"Ja" with contradicting answers is null, not true', () => {
    expect(deriveStepFree(ans({ stepFree: true, stepCount: 3 }))).toBeNull()
    expect(deriveStepFree(ans({ stepFree: true, stepCount: 3, ramp: false }))).toBeNull()
    expect(deriveStepFree(ans({ stepFree: true, thresholdCm: 5 }))).toBeNull()
  })
  it('"Ja" without contradictions is true, "Nein" is false', () => {
    expect(deriveStepFree(ans({ stepFree: true }))).toBe(true)
    expect(deriveStepFree(ans({ stepFree: true, stepCount: 2, ramp: true }))).toBe(true)
    expect(deriveStepFree(ans({ stepFree: false }))).toBe(false)
  })
  it('counted steps with "keine Rampe" are false even when the question was skipped', () => {
    expect(deriveStepFree(ans({ stepCount: 3, ramp: false }))).toBe(false)
    expect(deriveStepFree(ans({ stepCount: 3 }))).toBeNull()
  })
})

describe('applyAnswers -> entrance', () => {
  it('maps door fields the door card reads', () => {
    const e = applyAnswers(door(), ans({ stepFree: false, stepCount: 2, stepHeightCm: 16, revolving: true, heavyDoor: true, automatic: true, bell: true, doorWidthCm: 85, surface: 'kopfstein' }))
    expect(e.stepFree).toBe(false)
    expect(e.door).toBe('revolving')
    expect(e.automatic).toBe(true)
    expect(e.warnings).toEqual(expect.arrayContaining(['revolving', 'heavy', 'steps', 'cobblestone']))
    expect(e.description).toContain('2 Stufen, je 16 cm')
    expect(e.description).toContain('Türbreite 85 cm')
    expect((e as unknown as { widthCm: number }).widthCm).toBe(85)
    expect((e as unknown as { bell: boolean }).bell).toBe(true)
    expect(e.source).toBe('survey')
    expect(e.by).toBe('business')
  })
  it('keeps coordinates and id, and the tier comes from surveyTier', () => {
    const base = door()
    const yes = applyAnswers(base, ans({ stepFree: true }))
    expect(yes.id).toBe(base.id)
    expect([yes.lat, yes.lon]).toEqual([base.lat, base.lon])
    expect(yes.tier).toBe(1)
    const unknown = applyAnswers(base, ans({ doorWidthCm: 100, ramp: true }))
    expect(unknown.stepFree).toBeNull()
    expect(unknown.tier).toBe(0)
    expect(guidanceFor(unknown, { stepFreeRequired: true }).kind).toBe('text')
  })
  it('never makes a door without valid coordinates tier 1', () => {
    const e = applyAnswers(door({ lat: NaN }), ans({ stepFree: true }))
    expect(e.tier).toBe(0)
  })
  it('counts as the owner, and a stored tier is never trusted', () => {
    const e = applyAnswers(door({ by: 'community', tier: 1 }), ans())
    expect(e.by).toBe('business')
    expect(e.tier).toBe(0)
  })
  it('changing to "Weiß nicht" clears an earlier verdict and the automatic flag', () => {
    const before = applyAnswers(door(), ans({ stepFree: true, automatic: true }))
    const after = applyAnswers(before, ans())
    expect(after.stepFree).toBeNull()
    expect(after.automatic).toBe(false)
    expect(after.tier).toBe(0)
  })
  it('keeps warnings it does not own and drops stale ones it owns', () => {
    const e = applyAnswers(door({ warnings: ['level-mismatch', 'revolving'] }), ans({ revolving: false }))
    expect(e.warnings).toEqual(['level-mismatch'])
    expect(e.door).toBeNull()
  })
  it('an owner "Ja" never overrides an OSM "Nein" after merging', () => {
    const osm = { ...door(), id: 'node/1', source: 'osm' as const, stepFree: false, tier: 1 as const, confidence: 'surveyed' as const }
    const owner = applyAnswers(door(), ans({ stepFree: true }))
    const merged = mergeSurvey([osm], [owner])
    expect(merged[0].stepFree).toBe(false)
  })
  it('prefills from the entrance editor fields', () => {
    const a = answersFromEntrance(door({ stepFree: true, automatic: true, door: 'revolving', ...({ widthCm: 95, bell: true, ramp: true } as object) }))
    expect(a).toMatchObject({ stepFree: true, automatic: true, revolving: true, doorWidthCm: 95, bell: true, ramp: true })
    expect(a.handrail).toBeNull()
  })
})

describe('store', () => {
  let mem: Record<string, string>
  beforeEach(() => {
    mem = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in mem ? mem[k] : null),
      setItem: (k: string, v: string) => { mem[k] = v },
      removeItem: (k: string) => { delete mem[k] },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('saves per business and entrance, null survives the round trip', () => {
    expect(saveAnswers('biz/1', 'survey/a', ans({ stepFree: null, doorWidthCm: 90 }))).toBe(true)
    expect(loadAnswers('biz/1', 'survey/a')).toMatchObject({ stepFree: null, doorWidthCm: 90 })
    expect(loadAnswers('biz/1', 'survey/b')).toBeNull()
    expect(loadAnswers('biz/2', 'survey/a')).toBeNull()
    expect(deleteAnswers('biz/1')).toBe(true)
    expect(loadAnswers('biz/1', 'survey/a')).toBeNull()
  })
  it('normalizes junk from storage to "Weiß nicht"', () => {
    const a = normalizeAnswers({ stepFree: 'ja', doorWidthCm: 9999, surface: 'lava', note: 7 })
    expect(a.stepFree).toBeNull()
    expect(a.doorWidthCm).toBeNull()
    expect(a.surface).toBeNull()
    expect(a.note).toBe('')
  })
  it('survives blocked storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(loadAnswers('biz/1')).toBeNull()
    expect(saveAnswers('biz/1', 'place', ans())).toBe(false)
  })
})
