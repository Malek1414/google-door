import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { destination } from '../src/core/geo'
import {
  MAX_PHOTO_BYTES,
  deleteSurveyEntrance,
  loadBusiness,
  loadSurvey,
  makeSurveyEntrance,
  mergeSurvey,
  saveBusiness,
  saveSurveyEntrance,
  surveyTier,
  visibilityScore,
  type BusinessProfile,
  type SurveyEntrance,
} from '../src/core/survey'
import type { Entrance } from '../src/core/types'

const HBF = { lat: 52.5272097, lon: 13.3711667 }

function osm(over: Partial<Entrance> = {}): Entrance {
  return {
    id: 'node/1',
    buildingId: 'way/1',
    lat: HBF.lat,
    lon: HBF.lon,
    name: 'Eingang',
    kind: 'main',
    level: 0,
    stepFree: null,
    tier: 0,
    confidence: 'unknown',
    door: null,
    automatic: false,
    approachBearing: 90,
    description: null,
    warnings: [],
    source: 'osm',
    ...over,
  }
}

describe('surveyTier', () => {
  it('is tier 1 only for valid coords and an explicit verdict', () => {
    expect(surveyTier({ ...HBF, stepFree: true })).toBe(1)
    expect(surveyTier({ ...HBF, stepFree: false })).toBe(1)
    expect(surveyTier({ ...HBF, stepFree: null })).toBe(0)
    expect(surveyTier({ lat: NaN, lon: 13, stepFree: true })).toBe(0)
    expect(surveyTier({ lat: 95, lon: 13, stepFree: true })).toBe(0)
  })
  it('makeSurveyEntrance never coerces null to false', () => {
    const e = makeSurveyEntrance({ ...HBF, stepFree: null, by: 'community' })
    expect(e.stepFree).toBeNull()
    expect(e.tier).toBe(0)
    expect(e.id.startsWith('survey/')).toBe(true)
    expect(e.source).toBe('survey')
    expect(e.confidence).toBe('surveyed')
  })
})

describe('mergeSurvey', () => {
  it('appends survey entries far from any OSM entrance', () => {
    const far = destination(HBF, 0, 50)
    const s = makeSurveyEntrance({ ...far, stepFree: true, by: 'community' })
    const out = mergeSurvey([osm()], [s])
    expect(out).toHaveLength(2)
    expect(out[1].id).toBe(s.id)
    expect(out[0].source).toBe('osm')
  })
  it('replaces the verdict of an OSM entrance within 3 m, keeping its id and coords', () => {
    const near = destination(HBF, 45, 2)
    const s = makeSurveyEntrance({ ...near, stepFree: true, door: 'sliding', automatic: true, by: 'business' })
    const input = [osm()]
    const out = mergeSurvey(input, [s])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('node/1')
    expect(out[0].lat).toBe(HBF.lat)
    expect(out[0].stepFree).toBe(true)
    expect(out[0].tier).toBe(1)
    expect(out[0].source).toBe('survey')
    expect(out[0].confidence).toBe('surveyed')
    expect(out[0].door).toBe('sliding')
    expect(input[0].stepFree).toBeNull() // pure
  })
  it('does not replace at 4 m', () => {
    const s = makeSurveyEntrance({ ...destination(HBF, 45, 4), stepFree: false, by: 'community' })
    expect(mergeSurvey([osm()], [s])).toHaveLength(2)
  })
  it('an unknown survey verdict never overwrites a known OSM verdict', () => {
    const s = makeSurveyEntrance({ ...destination(HBF, 0, 1), stepFree: null, by: 'community' })
    const out = mergeSurvey([osm({ stepFree: false, tier: 1, confidence: 'surveyed' })], [s])
    expect(out[0].stepFree).toBe(false)
    expect(out[0].source).toBe('osm')
    expect(out[1].tier).toBe(0)
  })
  it('re-derives tier from stored data instead of trusting it', () => {
    const s = { ...makeSurveyEntrance({ lat: 200, lon: 13, stepFree: true, by: 'community' }), tier: 1 as const }
    expect(mergeSurvey([], [s])[0].tier).toBe(0)
  })
})

describe('visibilityScore', () => {
  const base: BusinessProfile = {
    id: 'biz/1',
    name: 'Cafe',
    lat: HBF.lat,
    lon: HBF.lon,
    accessibility: false,
    entranceIds: [],
    tasks: [{ id: 'route', label: 'Route aufnehmen', done: false }],
  }
  it('is 0 for an empty profile', () => {
    expect(visibilityScore(base, [])).toBe(0)
  })
  it('adds up to 100 with every item done', () => {
    const es = [0, 1, 2, 3].map((i) =>
      makeSurveyEntrance({
        ...destination(HBF, i * 90, 10),
        stepFree: true,
        door: 'hinged',
        photo: 'data:image/jpeg;base64,AAAA',
        by: 'business',
        businessId: 'biz/1',
      }),
    )
    const b = { ...base, accessibility: true, tasks: [{ id: 'route', label: 'Route', done: true }] }
    expect(visibilityScore(b, es)).toBe(100)
  })
  it('caps entrances at 3 and ignores entrances without verdict or not linked', () => {
    const verdict = makeSurveyEntrance({ ...HBF, stepFree: false, by: 'business', businessId: 'biz/1' })
    const unknown = makeSurveyEntrance({ ...HBF, stepFree: null, by: 'business', businessId: 'biz/1' })
    const other = makeSurveyEntrance({ ...HBF, stepFree: true, by: 'business', businessId: 'biz/2' })
    expect(visibilityScore({ ...base, accessibility: true }, [verdict, unknown, other])).toBe(35)
    const viaIds = { ...base, entranceIds: [other.id] }
    expect(visibilityScore(viaIds, [other])).toBe(15)
  })
})

describe('storage', () => {
  let mem: Record<string, string>
  beforeEach(() => {
    mem = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in mem ? mem[k] : null),
      setItem: (k: string, v: string) => {
        mem[k] = v
      },
      removeItem: (k: string) => {
        delete mem[k]
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('saves, loads and deletes survey entries', () => {
    const e = makeSurveyEntrance({ ...HBF, stepFree: true, by: 'community' })
    expect(saveSurveyEntrance(e)).toBe(true)
    expect(loadSurvey().map((x) => x.id)).toEqual([e.id])
    expect(deleteSurveyEntrance(e.id)).toBe(true)
    expect(loadSurvey()).toEqual([])
  })
  it('rejects oversize photos', () => {
    const e = makeSurveyEntrance({ ...HBF, stepFree: true, by: 'community', photo: 'x'.repeat(MAX_PHOTO_BYTES + 1) })
    expect(saveSurveyEntrance(e)).toBe(false)
  })
  it('survives corrupt JSON and throwing storage', () => {
    mem['doorway.survey'] = '{nope'
    expect(loadSurvey()).toEqual([])
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(loadSurvey()).toEqual([])
    expect(loadBusiness()).toBeNull()
    expect(saveSurveyEntrance(makeSurveyEntrance({ ...HBF, stepFree: true, by: 'community' }))).toBe(false)
  })
  it('round-trips the business profile', () => {
    const b: BusinessProfile = {
      id: 'biz/1',
      name: 'Cafe',
      lat: 52.5,
      lon: 13.4,
      accessibility: true,
      entranceIds: ['survey/a'],
      tasks: [{ id: 'route', label: 'Route', done: true }],
    }
    expect(saveBusiness(b)).toBe(true)
    expect(loadBusiness()).toMatchObject(b)
  })
})

describe('community reports are text until confirmed', () => {
  it('never makes a community entry guidable', async () => {
    const { surveyTier } = await import('../src/core/survey')
    expect(surveyTier({ lat: 52.5, lon: 13.4, stepFree: true, by: 'community' })).toBe(0)
    expect(surveyTier({ lat: 52.5, lon: 13.4, stepFree: true, by: 'business' })).toBe(1)
  })

  it('treats a stored entry without a valid author as a community report', () => {
    const forged = { ...makeSurveyEntrance({ ...HBF, stepFree: true, by: 'business' }), by: undefined, tier: 1 }
    const raw = JSON.stringify([forged])
    vi.stubGlobal('localStorage', { getItem: () => raw, setItem: () => {}, removeItem: () => {} })
    const [loaded] = loadSurvey()
    vi.unstubAllGlobals()
    expect(loaded.by).toBe('community')
    expect(loaded.tier).toBe(0)
    const [merged] = mergeSurvey([], [forged as unknown as SurveyEntrance])
    expect(merged.tier).toBe(0)
  })
})

describe('visibility with accessibility answers', () => {
  it('answering questions raises the score, old calls unchanged', async () => {
    const { visibilityScore } = await import('../src/core/survey')
    const b = { id: 'b1', name: 'x', lat: 52.5, lon: 13.4, accessibility: false, entranceIds: [], tasks: [] }
    expect(visibilityScore(b, [])).toBe(0)
    expect(visibilityScore(b, [], 1)).toBe(30)
    expect(visibilityScore({ ...b, accessibility: true }, [], 0.5)).toBe(29)
  })
})
