// Local store for entrances that businesses and contributors enter on the device.
// There is no backend for writes, so everything lives in localStorage. Every storage
// access is wrapped in try/catch: private mode, blocked storage or a full quota must
// never break the map.
//
// Safety (CONTRACT): a survey entry is tier 1 ONLY with valid coords AND an explicit
// stepFree verdict (true or false). Unknown stays null and tier 0. Never coerce null to false.

import { haversineM } from './geo'
import type { DoorType, Entrance, EntranceKind, Tier } from './types'

export const SURVEY_KEY = 'doorway.survey'
export const BUSINESS_KEY = 'doorway.business'
/** Max length of the photo data URL (about 300 kB). Larger photos are rejected. */
export const MAX_PHOTO_BYTES = 300 * 1024
/** A survey entry this close to an OSM entrance is treated as the same door. */
export const MERGE_RADIUS_M = 3

export interface SurveyEntrance extends Entrance {
  source: 'survey'
  confidence: 'surveyed'
  photo?: string
  note?: string
  createdAt: string
  by: 'business' | 'community'
  placeId?: string
  businessId?: string
}

export interface BusinessTask {
  id: string
  label: string
  done: boolean
}

export interface BusinessProfile {
  id: string
  name: string
  placeId?: string
  lat: number
  lon: number
  address?: string
  accessibility: boolean
  entranceIds: string[]
  tasks: BusinessTask[]
}

/** Task id that marks "route recorded" for the visibility score. */
export const ROUTE_TASK_ID = 'route'

// ---------- pure helpers ----------

export function validLatLon(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  )
}

/** Tier 1 only with valid coords AND an explicit verdict. Anything else is tier 0. */
export function surveyTier(e: { lat: number; lon: number; stepFree: boolean | null }): Tier {
  if (!validLatLon(e.lat, e.lon)) return 0
  return e.stepFree === true || e.stepFree === false ? 1 : 0
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    /* fall through */
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

export interface SurveyInput {
  lat: number
  lon: number
  stepFree: boolean | null
  by: 'business' | 'community'
  name?: string | null
  kind?: EntranceKind
  level?: number | null
  door?: DoorType | null
  automatic?: boolean
  approachBearing?: number | null
  description?: string | null
  warnings?: string[]
  photo?: string
  note?: string
  placeId?: string
  businessId?: string
  buildingId?: string | null
}

/** Build a contract-shaped survey entry. Tier and confidence are derived here, never passed in. */
export function makeSurveyEntrance(input: SurveyInput, now: Date = new Date()): SurveyEntrance {
  const stepFree = input.stepFree === true ? true : input.stepFree === false ? false : null
  const e: SurveyEntrance = {
    id: `survey/${newId()}`,
    buildingId: input.buildingId ?? null,
    lat: input.lat,
    lon: input.lon,
    name: input.name ?? null,
    kind: input.kind ?? 'yes',
    level: input.level ?? null,
    stepFree,
    tier: 0,
    confidence: 'surveyed',
    door: input.door ?? null,
    automatic: input.automatic ?? false,
    approachBearing: input.approachBearing ?? null,
    description: input.description ?? null,
    warnings: input.warnings ?? (input.door === 'revolving' ? ['revolving'] : []),
    source: 'survey',
    createdAt: now.toISOString(),
    by: input.by,
  }
  e.tier = surveyTier(e)
  if (input.photo !== undefined) e.photo = input.photo
  if (input.note !== undefined) e.note = input.note
  if (input.placeId !== undefined) e.placeId = input.placeId
  if (input.businessId !== undefined) e.businessId = input.businessId
  return e
}

/**
 * Pure. Survey entries are appended. A survey entry with an explicit verdict within
 * MERGE_RADIUS_M of a non-survey entrance replaces that entrance's verdict fields
 * (OSM id and coords are kept, source becomes 'survey') instead of being appended.
 * Survey entries without a verdict never overwrite anything.
 */
export function mergeSurvey(entrances: Entrance[], survey: SurveyEntrance[]): Entrance[] {
  const out = entrances.map((e) => ({ ...e }))
  for (const raw of survey) {
    // Re-derive the tier: stored data is untrusted.
    const s: SurveyEntrance = { ...raw, tier: surveyTier(raw) }
    let bestIdx = -1
    let bestD = Infinity
    if (s.tier === 1) {
      for (let i = 0; i < entrances.length; i++) {
        const e = entrances[i]
        if (e.source === 'survey' || !validLatLon(e.lat, e.lon)) continue
        const d = haversineM(s, e)
        if (d <= MERGE_RADIUS_M && d < bestD) {
          bestD = d
          bestIdx = i
        }
      }
    }
    if (bestIdx >= 0) {
      const target = out[bestIdx]
      out[bestIdx] = {
        ...target,
        stepFree: s.stepFree,
        tier: surveyTier({ lat: target.lat, lon: target.lon, stepFree: s.stepFree }),
        confidence: 'surveyed',
        door: s.door ?? target.door,
        automatic: s.automatic,
        warnings: [...s.warnings],
        description: s.description ?? target.description,
        source: 'survey',
      }
    } else {
      out.push(s)
    }
  }
  return out
}

/**
 * Pure, 0..100. Weights:
 *  - accessibility box ticked:                       20
 *  - each linked entrance with a verdict (max 3):    15 each, up to 45
 *  - any linked entrance with a known door type:     10
 *  - any linked entrance with a photo:               10
 *  - task 'route' (route recorded) done:             15
 * An entrance is linked if its id is in b.entranceIds or its businessId is b.id.
 */
export function visibilityScore(b: BusinessProfile, entrances: SurveyEntrance[]): number {
  const linked = entrances.filter((e) => b.entranceIds.includes(e.id) || e.businessId === b.id)
  let score = 0
  if (b.accessibility) score += 20
  const withVerdict = linked.filter((e) => e.stepFree === true || e.stepFree === false).length
  score += Math.min(3, withVerdict) * 15
  if (linked.some((e) => e.door != null)) score += 10
  if (linked.some((e) => typeof e.photo === 'string' && e.photo.length > 0)) score += 10
  if (b.tasks.some((t) => t.id === ROUTE_TASK_ID && t.done)) score += 15
  return Math.max(0, Math.min(100, score))
}

// ---------- storage ----------

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    const s = storage()
    if (!s) return false
    s.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function isSurveyEntrance(x: unknown): x is SurveyEntrance {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.id === 'string' && o.id.startsWith('survey/') && typeof o.lat === 'number' && typeof o.lon === 'number'
}

export function loadSurvey(): SurveyEntrance[] {
  const data = readJson(SURVEY_KEY)
  if (!Array.isArray(data)) return []
  return data.filter(isSurveyEntrance).map((e) => ({
    ...e,
    source: 'survey' as const,
    confidence: 'surveyed' as const,
    stepFree: e.stepFree === true ? true : e.stepFree === false ? false : null,
    tier: surveyTier(e),
    warnings: Array.isArray(e.warnings) ? e.warnings : [],
  }))
}

/** Insert or replace by id. Returns false if the photo is too large or storage fails. */
export function saveSurveyEntrance(e: SurveyEntrance): boolean {
  if (e.photo !== undefined && e.photo.length > MAX_PHOTO_BYTES) return false
  const clean: SurveyEntrance = { ...e, tier: surveyTier(e), source: 'survey', confidence: 'surveyed' }
  const list = loadSurvey().filter((x) => x.id !== clean.id)
  list.push(clean)
  return writeJson(SURVEY_KEY, list)
}

export function deleteSurveyEntrance(id: string): boolean {
  const list = loadSurvey()
  const next = list.filter((x) => x.id !== id)
  if (next.length === list.length) return false
  return writeJson(SURVEY_KEY, next)
}

export function loadBusiness(): BusinessProfile | null {
  const o = readJson(BUSINESS_KEY) as Partial<BusinessProfile> | null
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || typeof o.name !== 'string') return null
  return {
    id: o.id,
    name: o.name,
    placeId: typeof o.placeId === 'string' ? o.placeId : undefined,
    lat: typeof o.lat === 'number' ? o.lat : NaN,
    lon: typeof o.lon === 'number' ? o.lon : NaN,
    address: typeof o.address === 'string' ? o.address : undefined,
    accessibility: o.accessibility === true,
    entranceIds: Array.isArray(o.entranceIds) ? o.entranceIds.filter((x): x is string => typeof x === 'string') : [],
    tasks: Array.isArray(o.tasks)
      ? o.tasks.filter((t): t is BusinessTask => !!t && typeof t.id === 'string').map((t) => ({
          id: t.id,
          label: String(t.label ?? ''),
          done: t.done === true,
        }))
      : [],
  }
}

export function saveBusiness(b: BusinessProfile): boolean {
  return writeJson(BUSINESS_KEY, b)
}
