// Wheelchair verdict: the client for server/approach.py `door_check` and the card rows.
//
// One frame in, one verdict out. Anything the model is unsure of renders "unklar",
// never a guess: a wrong "no step" sends someone to a door they cannot enter.

import { apiBase } from '../config'

/** server/approach.py OPENS. */
export type Opens = 'automatic' | 'push' | 'pull' | 'revolving' | 'none' | 'unknown'
const OPENS: readonly Opens[] = ['automatic', 'push', 'pull', 'revolving', 'none', 'unknown']

/** The real /api/door-check response. */
export interface DoorCheckResult {
  step: boolean | null
  widthCm: number | null
  opens: Opens
  note: string
  confidence: number
  /** Client-side only: false when the request never produced a verdict (404/503/network/timeout). */
  reachable: boolean
}

export const UNKNOWN_RESULT: DoorCheckResult = {
  step: null, widthCm: null, opens: 'unknown', note: '', confidence: 0, reachable: false,
}

/** Below this the verdict is not something a wheelchair user should act on. Mirrors the server. */
export const MIN_CONFIDENCE = 0.5
const TIMEOUT_MS = 15000

/** Normalises any body into a result. Unknown shapes and fields become null/unknown. */
export function parseDoorCheckResult(raw: unknown): DoorCheckResult {
  if (typeof raw !== 'object' || raw === null) return UNKNOWN_RESULT
  const o = raw as Record<string, unknown>
  const w = o.widthCm
  const c = o.confidence
  return {
    step: typeof o.step === 'boolean' ? o.step : null,
    widthCm: typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : null,
    opens: OPENS.includes(o.opens as Opens) ? (o.opens as Opens) : 'unknown',
    note: typeof o.note === 'string' ? o.note.trim().slice(0, 120) : '',
    confidence: typeof c === 'number' && Number.isFinite(c) ? c : 0,
    reachable: true,
  }
}

/** POST one frame (FrameReq: {frame, headingDeg}). Never throws; every failure is all-unknown. */
export async function checkDoor(frameB64: string | null, headingDeg = 0): Promise<DoorCheckResult> {
  if (!frameB64) return UNKNOWN_RESULT
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`${apiBase()}/api/door-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame: frameB64, headingDeg }),
      signal: ctl.signal,
    })
    if (!r.ok) return UNKNOWN_RESULT
    return parseDoorCheckResult(await r.json())
  } catch {
    return UNKNOWN_RESULT
  } finally {
    clearTimeout(timer)
  }
}

/** Exactly one request per screen: waits for the frame, then asks once. No retry. */
export async function runDoorCheckOnce(
  frame: Promise<string | null>,
  check: (f: string | null) => Promise<DoorCheckResult> = checkDoor,
): Promise<DoorCheckResult> {
  return check(await frame)
}

const L = {
  de: {
    step: 'Stufe', width: 'Breite', opens: 'Öffnet', unclear: 'unklar', yes: 'ja', no: 'nein',
    widthCm: (cm: number) => `ca. ${cm} cm`,
    open: { automatic: 'automatisch', push: 'drücken', pull: 'ziehen', revolving: 'Drehtür', none: 'keine Tür' },
  },
  en: {
    step: 'Step', width: 'Width', opens: 'Opens', unclear: 'unclear', yes: 'yes', no: 'no',
    widthCm: (cm: number) => `about ${cm} cm`,
    open: { automatic: 'automatic', push: 'push', pull: 'pull', revolving: 'revolving door', none: 'no door' },
  },
}

export interface VerdictRow {
  label: string
  value: string
  unclear: boolean
}

export function unclearWord(lang: string): string {
  return (lang === 'de' ? L.de : L.en).unclear
}

/** Stufe / Breite / Öffnet. Null, unknown or low confidence: "unklar" for that row. */
export function verdictRows(r: DoorCheckResult, lang: string): VerdictRow[] {
  const s = lang === 'de' ? L.de : L.en
  const sure = r.confidence >= MIN_CONFIDENCE
  const row = (label: string, value: string | null): VerdictRow =>
    sure && value !== null ? { label, value, unclear: false } : { label, value: s.unclear, unclear: true }
  // Round to 5 cm: the model estimates from a picture, the card must not look like a tape measure.
  const width = r.widthCm === null ? null : s.widthCm(Math.round(r.widthCm / 5) * 5)
  return [
    row(s.step, r.step === null ? null : r.step ? s.yes : s.no),
    row(s.width, width),
    row(s.opens, r.opens === 'unknown' ? null : s.open[r.opens]),
  ]
}

/** The model's short note, only when there is one and the verdict is confident. */
export function verdictNote(r: DoorCheckResult): string {
  return r.confidence >= MIN_CONFIDENCE ? r.note : ''
}
