// Manual accessibility questionnaire for business owners ("Barrierefreiheit bearbeiten").
// Pure question model, validation, progress and the mapping onto a survey entrance,
// plus a guarded localStorage store. Nothing here touches the DOM.
//
// Storage: device only, like core/survey and core/businessDetails. There is no backend
// for writes. Key doorway.accessAnswers = { [businessId]: { [entranceId | 'place']: answers } }.
//
// Safety (CONTRACT, core/survey): owner answers are a survey entry with by 'business'. The
// tier is never set here, surveyTier() derives it. stepFree becomes true ONLY from an explicit
// "Ja" to the step-free question with nothing in the other answers contradicting it; any
// contradiction gives null. "Weiß nicht" is null and stays null, never false.

import { surveyTier, type SurveyEntrance } from './survey'

export const ACCESS_ANSWERS_KEY = 'doorway.accessAnswers'
/** Answers saved before the business has an entrance. */
export const PLACE_KEY = 'place'
export const MAX_NOTE = 500
/** DIN 18040: a threshold above 2 cm is a barrier, not step-free. */
export const MAX_STEPFREE_THRESHOLD_CM = 2

export type YN = boolean | null
export const SURFACES = ['glatt', 'pflaster', 'kopfstein', 'kies', 'teppich'] as const
export type Surface = (typeof SURFACES)[number]
export const OPENINGS = ['innen', 'aussen', 'schiebe'] as const
export type Opening = (typeof OPENINGS)[number]

export interface AccessAnswers {
  // Eingang
  stepFree: YN
  stepCount: number | null
  stepHeightCm: number | null
  ramp: YN
  rampSlopePct: number | null
  handrail: YN
  thresholdCm: number | null
  bell: YN
  bellHeightCm: number | null
  parking: YN
  // Tür
  doorWidthCm: number | null
  automatic: YN
  doorButton: YN
  revolving: YN
  heavyDoor: YN
  opening: Opening | null
  // Weg und Boden
  surface: Surface | null
  slope: YN
  pathWidthCm: number | null
  obstacles: YN
  // Innen
  elevator: YN
  elevatorDoorCm: number | null
  corridorCm: number | null
  counterCm: number | null
  seating: YN
  // WC
  toilet: YN
  grabBars: YN
  turningSpace: YN
  // Sehen
  contrast: YN
  tactileGuidance: YN
  braille: YN
  lighting: YN
  // Hören
  hearingLoop: YN
  visualAlarm: YN
  // Freitext
  note: string
}

export type AnswerKey = keyof AccessAnswers

type Base = { key: AnswerKey; label: string; when?: (a: AccessAnswers) => boolean }
export type Question =
  | (Base & { kind: 'yn' })
  | (Base & { kind: 'num'; unit: string; unitLong: string; min: number; max: number; int: boolean })
  | (Base & { kind: 'choice'; choices: readonly { v: string; label: string }[] })
  | (Base & { kind: 'text'; placeholder: string })

export interface Section {
  id: string
  title: string
  questions: Question[]
}

const cm = { unit: 'cm', unitLong: 'Zentimeter' }
const yn = (key: AnswerKey, label: string, when?: Base['when']): Question => ({ key, label, kind: 'yn', when })
const num = (key: AnswerKey, label: string, min: number, max: number, u = cm, int = true, when?: Base['when']): Question => ({
  key, label, kind: 'num', min, max, int, when, ...u,
})

export const SECTIONS: Section[] = [
  {
    id: 'eingang',
    title: 'Eingang',
    questions: [
      yn('stepFree', 'Kommt man ohne Stufen hinein?'),
      num('stepCount', 'Anzahl Stufen', 0, 50, { unit: 'Stufen', unitLong: 'Stufen' }, true, (a) => a.stepFree !== true),
      num('stepHeightCm', 'Stufenhöhe', 1, 40, cm, false, (a) => a.stepFree !== true && a.stepCount !== 0),
      yn('ramp', 'Gibt es eine Rampe?'),
      num('rampSlopePct', 'Rampensteigung', 0, 30, { unit: '%', unitLong: 'Prozent' }, false, (a) => a.ramp !== false),
      yn('handrail', 'Gibt es einen Handlauf?'),
      num('thresholdCm', 'Schwelle an der Tür', 0, 20, cm, false),
      yn('bell', 'Gibt es eine Klingel oder Sprechanlage?'),
      num('bellHeightCm', 'Höhe der Klingel', 30, 250, cm, true, (a) => a.bell !== false),
      yn('parking', 'Gibt es einen Parkplatz für Menschen mit Behinderung?'),
    ],
  },
  {
    id: 'tuer',
    title: 'Tür',
    questions: [
      num('doorWidthCm', 'Türbreite', 40, 400),
      yn('automatic', 'Öffnet die Tür automatisch?'),
      yn('doorButton', 'Gibt es einen Türöffner-Taster?'),
      yn('revolving', 'Ist es eine Drehtür?'),
      yn('heavyDoor', 'Ist die Tür schwer zu öffnen?'),
      {
        key: 'opening', kind: 'choice', label: 'Wie öffnet die Tür?',
        choices: [{ v: 'innen', label: 'Nach innen' }, { v: 'aussen', label: 'Nach außen' }, { v: 'schiebe', label: 'Schiebetür' }],
      },
    ],
  },
  {
    id: 'weg',
    title: 'Weg und Boden',
    questions: [
      {
        key: 'surface', kind: 'choice', label: 'Bodenbelag auf dem Weg zur Tür',
        choices: [
          { v: 'glatt', label: 'Glatt' }, { v: 'pflaster', label: 'Pflaster' }, { v: 'kopfstein', label: 'Kopfsteinpflaster' },
          { v: 'kies', label: 'Kies' }, { v: 'teppich', label: 'Teppich' },
        ],
      },
      yn('slope', 'Hat der Weg ein spürbares Gefälle?'),
      num('pathWidthCm', 'Wegbreite', 50, 1000),
      yn('obstacles', 'Gibt es Hindernisse auf dem Weg?'),
    ],
  },
  {
    id: 'innen',
    title: 'Innen',
    questions: [
      yn('elevator', 'Gibt es einen Aufzug?'),
      num('elevatorDoorCm', 'Türbreite des Aufzugs', 50, 300, cm, true, (a) => a.elevator !== false),
      num('corridorCm', 'Flurbreite', 50, 1000),
      num('counterCm', 'Tresenhöhe', 40, 150),
      yn('seating', 'Gibt es Sitzmöglichkeiten?'),
    ],
  },
  {
    id: 'wc',
    title: 'WC',
    questions: [
      yn('toilet', 'Gibt es ein barrierefreies WC?'),
      yn('grabBars', 'Gibt es Haltegriffe?', (a) => a.toilet !== false),
      yn('turningSpace', 'Ist genug Bewegungsfläche für einen Rollstuhl?', (a) => a.toilet !== false),
    ],
  },
  {
    id: 'sehen',
    title: 'Sehen',
    questions: [
      yn('contrast', 'Gibt es Kontraste oder Markierungen an Stufen und Glas?'),
      yn('tactileGuidance', 'Gibt es ein Blindenleitsystem?'),
      yn('braille', 'Gibt es Braille oder tastbare Beschriftung?'),
      yn('lighting', 'Ist die Beleuchtung gut?'),
    ],
  },
  {
    id: 'hoeren',
    title: 'Hören',
    questions: [
      yn('hearingLoop', 'Gibt es eine Induktionsschleife?'),
      yn('visualAlarm', 'Gibt es visuelle Alarmsignale?'),
    ],
  },
  {
    id: 'freitext',
    title: 'Freitext',
    questions: [{ key: 'note', kind: 'text', label: 'Was sollten Besucher noch wissen?', placeholder: 'z. B. Klingel links neben der Tür, wir helfen gern.' }],
  },
]

export const ALL_QUESTIONS: Question[] = SECTIONS.flatMap((s) => s.questions)

export function emptyAnswers(): AccessAnswers {
  const a = {} as Record<AnswerKey, unknown>
  for (const q of ALL_QUESTIONS) a[q.key] = q.kind === 'text' ? '' : null
  return a as unknown as AccessAnswers
}

/** Coerce unknown JSON into answers. Anything invalid becomes null ("Weiß nicht"). */
export function normalizeAnswers(o: unknown): AccessAnswers {
  const a = emptyAnswers() as unknown as Record<AnswerKey, unknown>
  if (!o || typeof o !== 'object') return a as unknown as AccessAnswers
  const r = o as Record<string, unknown>
  for (const q of ALL_QUESTIONS) {
    const v = r[q.key]
    if (q.kind === 'yn') a[q.key] = v === true ? true : v === false ? false : null
    else if (q.kind === 'num') a[q.key] = typeof v === 'number' && Number.isFinite(v) && v >= q.min && v <= q.max ? v : null
    else if (q.kind === 'choice') a[q.key] = typeof v === 'string' && q.choices.some((c) => c.v === v) ? v : null
    else a[q.key] = typeof v === 'string' ? v.slice(0, MAX_NOTE) : ''
  }
  return a as unknown as AccessAnswers
}

export function isApplicable(q: Question, a: AccessAnswers): boolean {
  return q.when ? q.when(a) : true
}

function answered(q: Question, a: AccessAnswers): boolean {
  const v = a[q.key]
  return q.kind === 'text' ? typeof v === 'string' && v.trim() !== '' : v !== null
}

/** "12 von 30 Angaben": answered questions among those that apply. Pure. */
export function progress(a: AccessAnswers, questions: Question[] = ALL_QUESTIONS): { done: number; total: number } {
  const live = questions.filter((q) => isApplicable(q, a))
  return { done: live.filter((q) => answered(q, a)).length, total: live.length }
}

/** Parse a typed number ("12", "7,5"). Empty is null; anything else unparsable is NaN. */
export function parseNumber(raw: string): number | null {
  const t = raw.trim().replace(',', '.')
  if (t === '') return null
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN
}

const fmt = (n: number) => String(n).replace('.', ',')

export function rangeText(q: Extract<Question, { kind: 'num' }>): string {
  return `Zwischen ${fmt(q.min)} und ${fmt(q.max)} ${q.unit}`
}

/**
 * German error text per field, empty object when valid. Only applicable questions are
 * checked. Contradictions against "stufenlos Ja" are errors, so the owner fixes them
 * instead of the app guessing.
 */
export function validate(a: AccessAnswers): Partial<Record<AnswerKey, string>> {
  const err: Partial<Record<AnswerKey, string>> = {}
  for (const q of ALL_QUESTIONS) {
    if (q.kind !== 'num' || !isApplicable(q, a)) continue
    const v = a[q.key] as number | null
    if (v === null) continue
    if (!Number.isFinite(v)) err[q.key] = `Bitte eine Zahl eingeben. ${rangeText(q)}.`
    else if (q.int && !Number.isInteger(v)) err[q.key] = `Bitte eine ganze Zahl eingeben. ${rangeText(q)}.`
    else if (v < q.min || v > q.max) err[q.key] = `Bitte einen Wert eingeben: ${rangeText(q).toLowerCase()}.`
  }
  if (a.stepFree === true && !err.thresholdCm && a.thresholdCm !== null && a.thresholdCm > MAX_STEPFREE_THRESHOLD_CM) {
    err.thresholdCm = `Eine Schwelle über ${MAX_STEPFREE_THRESHOLD_CM} cm gilt nicht als stufenlos. Prüfe bitte die Frage „Kommt man ohne Stufen hinein?“.`
  }
  if (a.note.length > MAX_NOTE) err.note = `Bitte höchstens ${MAX_NOTE} Zeichen.`
  return err
}

// ---------- mapping onto the entrance the user side reads ----------

/**
 * Pure. The step-free verdict from the answers.
 *  - "Nein" is false.
 *  - "Weiß nicht" stays null, except that counted steps with "keine Rampe" are false.
 *  - "Ja" is true only when nothing contradicts it (steps without a ramp, a threshold
 *    above 2 cm). A contradiction is null, never true.
 */
export function deriveStepFree(a: AccessAnswers): boolean | null {
  const hasSteps = a.stepCount !== null && a.stepCount > 0
  if (a.stepFree === false) return false
  if (a.stepFree === null) return hasSteps && a.ramp === false ? false : null
  if (hasSteps && a.ramp !== true) return null
  if (a.thresholdCm !== null && a.thresholdCm > MAX_STEPFREE_THRESHOLD_CM) return null
  return true
}

/** Warnings this questionnaire owns. Others (from OSM or the editor) are kept. */
const MANAGED_WARNINGS = ['revolving', 'heavy', 'steps', 'threshold', 'cobblestone', 'gravel']

export function deriveWarnings(a: AccessAnswers, stepFree: boolean | null): string[] {
  const w: string[] = []
  if (a.revolving === true) w.push('revolving')
  if (a.heavyDoor === true) w.push('heavy')
  const hasSteps = a.stepCount !== null && a.stepCount > 0
  if (stepFree === false || (hasSteps && a.ramp !== true)) w.push('steps')
  if (a.thresholdCm !== null && a.thresholdCm > MAX_STEPFREE_THRESHOLD_CM) w.push('threshold')
  if (a.surface === 'kopfstein') w.push('cobblestone')
  if (a.surface === 'kies') w.push('gravel')
  return w
}

const SURFACE_LABEL: Record<Surface, string> = { glatt: 'glatt', pflaster: 'Pflaster', kopfstein: 'Kopfsteinpflaster', kies: 'Kies', teppich: 'Teppich' }

/** Short German summary for the door card ("Hinweise"). Only answered facts. Pure. */
export function describeAnswers(a: AccessAnswers): string | null {
  const p: string[] = []
  const has = (v: YN, yes: string, no?: string) => {
    if (v === true) p.push(yes)
    else if (v === false && no) p.push(no)
  }
  if (a.stepCount !== null && a.stepCount > 0 && a.stepFree !== true) {
    p.push(`${a.stepCount} ${a.stepCount === 1 ? 'Stufe' : 'Stufen'}${a.stepHeightCm !== null ? `, je ${fmt(a.stepHeightCm)} cm` : ''}`)
  }
  if (a.ramp === true) p.push(`Rampe${a.rampSlopePct !== null ? ` mit ${fmt(a.rampSlopePct)} % Steigung` : ''}`)
  has(a.handrail, 'Handlauf')
  if (a.thresholdCm !== null) p.push(a.thresholdCm === 0 ? 'keine Schwelle' : `Schwelle ${fmt(a.thresholdCm)} cm`)
  if (a.doorWidthCm !== null) p.push(`Türbreite ${fmt(a.doorWidthCm)} cm`)
  has(a.doorButton, 'Türöffner-Taster')
  if (a.opening === 'innen') p.push('Tür öffnet nach innen')
  if (a.opening === 'aussen') p.push('Tür öffnet nach außen')
  if (a.bell === true) p.push(`Klingel${a.bellHeightCm !== null ? ` in ${fmt(a.bellHeightCm)} cm Höhe` : ''}`)
  has(a.parking, 'Behindertenparkplatz')
  if (a.surface) p.push(`Boden: ${SURFACE_LABEL[a.surface]}`)
  has(a.elevator, `Aufzug${a.elevatorDoorCm !== null ? ` (Tür ${fmt(a.elevatorDoorCm)} cm)` : ''}`, 'kein Aufzug')
  has(a.toilet, 'barrierefreies WC', 'kein barrierefreies WC')
  has(a.tactileGuidance, 'Blindenleitsystem')
  has(a.hearingLoop, 'Induktionsschleife')
  const note = a.note.trim()
  if (!p.length && !note) return null
  const facts = p.length ? `Laut Inhaber: ${p.join(', ')}.` : ''
  return [facts, note].filter(Boolean).join(' ').slice(0, 600)
}

/** Prefill from what the entrance already says (editor fields, extras). Pure. */
export function answersFromEntrance(e: SurveyEntrance, base: AccessAnswers = emptyAnswers()): AccessAnswers {
  const x = e as SurveyEntrance & { ramp?: unknown; bell?: unknown; tactile?: unknown; widthCm?: unknown }
  const a = { ...base }
  if (e.stepFree === true || e.stepFree === false) a.stepFree = e.stepFree
  if (x.ramp === true) a.ramp = true
  if (x.bell === true) a.bell = true
  if (x.tactile === true) a.tactileGuidance = true
  if (e.automatic === true) a.automatic = true
  if (e.door === 'revolving') a.revolving = true
  if (e.door === 'sliding' && a.opening === null) a.opening = 'schiebe'
  if (typeof x.widthCm === 'number' && x.widthCm >= 40 && x.widthCm <= 400) a.doorWidthCm = x.widthCm
  if ((e.warnings as string[]).includes('heavy')) a.heavyDoor = true
  return a
}

/**
 * Pure. The entrance with the owner's answers applied. Coordinates, id and kind are the
 * entrance's own (the pin the owner placed on the door). Source 'survey', by 'business',
 * tier re-derived by surveyTier(). The raw answers are not copied onto the entrance.
 */
export function applyAnswers(e: SurveyEntrance, a: AccessAnswers): SurveyEntrance {
  const stepFree = deriveStepFree(a)
  let door = e.door
  if (a.revolving === true) door = 'revolving'
  else if (a.opening === 'schiebe') door = 'sliding'
  else if (a.opening === 'innen' || a.opening === 'aussen') door = 'hinged'
  else if (a.revolving === false && door === 'revolving') door = null
  const kept = (e.warnings as string[]).filter((w) => !MANAGED_WARNINGS.includes(w))
  const out = {
    ...e,
    stepFree,
    door,
    automatic: a.automatic === true,
    warnings: [...new Set([...kept, ...deriveWarnings(a, stepFree)])],
    description: describeAnswers(a),
    note: a.note.trim() || undefined,
    source: 'survey' as const,
    confidence: 'surveyed' as const,
    by: 'business' as const,
    // Extras the entrance editor and "Gesammelte Daten" already read.
    ramp: a.ramp === true,
    bell: a.bell === true,
    tactile: a.tactileGuidance === true,
    widthCm: a.doorWidthCm ?? undefined,
  } as SurveyEntrance
  out.tier = surveyTier(out)
  return out
}

// ---------- storage ----------

type Store = Record<string, Record<string, unknown>>

function readAll(): Store {
  try {
    const raw = localStorage.getItem(ACCESS_ANSWERS_KEY)
    const o = raw ? JSON.parse(raw) : null
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Store) : {}
  } catch {
    return {}
  }
}

export function loadAnswers(businessId: string, entranceId: string = PLACE_KEY): AccessAnswers | null {
  const b = readAll()[businessId]
  if (!b || typeof b !== 'object' || !Object.prototype.hasOwnProperty.call(b, entranceId)) return null
  return normalizeAnswers(b[entranceId])
}

/** Returns false when storage is blocked or full. */
export function saveAnswers(businessId: string, entranceId: string, a: AccessAnswers): boolean {
  try {
    const all = readAll()
    const b = all[businessId] && typeof all[businessId] === 'object' ? all[businessId] : {}
    b[entranceId] = { ...normalizeAnswers(a), updatedAt: new Date().toISOString() }
    all[businessId] = b
    localStorage.setItem(ACCESS_ANSWERS_KEY, JSON.stringify(all))
    return true
  } catch {
    return false
  }
}

export function deleteAnswers(businessId: string): boolean {
  try {
    const all = readAll()
    if (!(businessId in all)) return true
    delete all[businessId]
    localStorage.setItem(ACCESS_ANSWERS_KEY, JSON.stringify(all))
    return true
  } catch {
    return false
  }
}
