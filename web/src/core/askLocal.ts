// Voice questions answered from the door data alone. Pure: no DOM, no network.
//
// Works with no Gemini at all. Only facts we hold are said; anything we do not hold
// becomes "Das wissen wir für diesen Eingang noch nicht." A blind user cannot check
// an invented "ja, stufenlos", so unknown stays unknown (stepFree null is never false).

import type { Entrance } from './types'

export interface AskCtx {
  entrance: Pick<Entrance, 'name' | 'stepFree' | 'door' | 'automatic' | 'warnings' | 'level' | 'approachBearing' | 'description'>
  /** The distinguishable name shown on screen. */
  name: string
  distanceM: number | null
  /** Door relative to where the phone points, -180..180; null without a compass. */
  relDeg: number | null
  /** Other entrances of the same building; null when we do not know. */
  others: { name: string; stepFree: boolean | null }[] | null
  /** The instruction line as shown ("Geradeaus · 8 m"), if any. */
  instruction?: string | null
  /** The route note, only if it is shown. */
  routeNote?: string | null
}

export type AskResult = { kind: 'local'; text: string } | { kind: 'remote'; withFrame: boolean }

export const UNKNOWN = 'Das wissen wir für diesen Eingang noch nicht.'
export const REMOTE_FAILED = 'Das kann ich gerade nicht beantworten. Frag mich nach Stufen, Tür oder Entfernung.'

const DOOR: Record<string, string> = {
  no: 'Es gibt keine Tür, nur einen offenen Durchgang.',
  hinged: 'Es ist eine Drehflügeltür.',
  sliding: 'Es ist eine Schiebetür.',
  revolving: 'Es ist eine Drehtür. Mit Rollstuhl, Rollator oder Blindenhund ist sie oft nicht nutzbar.',
  yes: 'Es gibt eine Tür, die Art kennen wir nicht.',
}
const WARN: Record<string, string> = {
  revolving: 'Achtung, Drehtür.',
  heavy: 'Achtung, schwere Tür.',
  steps: 'Achtung, Stufen an diesem Eingang.',
  'level-mismatch': 'Achtung, der Eingang liegt nicht auf Straßenhöhe.',
}

export function normalise(q: string): string {
  return q
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const has = (q: string, words: string[]) => words.some((w) => (w.includes(' ') ? q.includes(w) : new RegExp(`\\b${w}`).test(q)))

export function metresText(m: number): string {
  if (m < 3) return 'Du bist fast da, weniger als 3 Meter.'
  const r = m < 20 ? Math.round(m) : Math.round(m / 5) * 5
  return `Noch etwa ${r} Meter.`
}

export function directionText(rel: number): string {
  const a = Math.abs(rel)
  const side = rel > 0 ? 'rechts' : 'links'
  if (a < 20) return 'Die Tür liegt geradeaus vor dir.'
  if (a < 60) return `Die Tür liegt leicht ${side} vor dir.`
  if (a < 135) return `Die Tür liegt ${side} von dir.`
  return 'Die Tür liegt hinter dir.'
}

export function stepFreeText(v: boolean | null): string {
  if (v === true) return 'Ja, der Eingang ist stufenlos.'
  if (v === false) return 'Nein, der Eingang ist nicht stufenlos.'
  return 'Ob der Eingang stufenlos ist, wissen wir noch nicht.'
}

function doorText(c: AskCtx): string {
  const e = c.entrance
  if (!e.door) return e.automatic ? 'Die Tür öffnet automatisch.' : UNKNOWN
  return `${DOOR[e.door] ?? DOOR.yes}${e.automatic ? ' Sie öffnet automatisch.' : ''}`
}

function whereText(c: AskCtx): string {
  const parts: string[] = []
  if (c.relDeg !== null) parts.push(directionText(c.relDeg))
  else if (c.instruction) parts.push(`Die Anzeige sagt: ${c.instruction}.`)
  if (c.distanceM !== null && Number.isFinite(c.distanceM)) parts.push(metresText(c.distanceM))
  return parts.length ? parts.join(' ') : UNKNOWN
}

/** Answer from the data, or say the question needs the server (and whether it wants the camera). */
export function askLocal(question: string, c: AskCtx): AskResult {
  const q = normalise(question)
  const e = c.entrance
  if (!q) return { kind: 'local', text: UNKNOWN }

  // Surroundings: only the camera can say, and only the server can look.
  if (has(q, ['was sehe ich', 'was ist vor mir', 'siehst du', 'umgebung', 'beschreib', 'what do i see', 'in front of me', 'what is around', 'describe'])) {
    return { kind: 'remote', withFrame: true }
  }
  if (has(q, ['anderer eingang', 'anderen eingang', 'andere eingaenge', 'anderen eingaengen', 'noch ein eingang', 'noch einen eingang', 'zweiten eingang', 'anderen zugang', 'weiteren eingang', 'weitere eingaenge', 'other entrance', 'another entrance', 'other door', 'another door'])) {
    if (c.others === null) return { kind: 'local', text: UNKNOWN }
    if (c.others.length === 0) return { kind: 'local', text: 'Wir kennen keinen anderen Eingang an diesem Gebäude.' }
    const free = c.others.filter((o) => o.stepFree === true)
    const n = c.others.length
    const head = n === 1 ? 'Es gibt noch einen Eingang' : `Es gibt noch ${n} Eingänge`
    const tail = free.length ? ` Stufenlos: ${free.slice(0, 2).map((o) => o.name).join(', ')}.` : ''
    return { kind: 'local', text: `${head}: ${c.others.slice(0, 3).map((o) => o.name).join(', ')}.${tail}` }
  }
  if (has(q, ['stufenlos', 'stufe', 'treppe', 'barrierefrei', 'rollstuhl', 'rampe', 'schwelle', 'step', 'stairs', 'wheelchair', 'ramp', 'accessible'])) {
    let text = stepFreeText(e.stepFree)
    if (e.stepFree !== false && e.warnings.includes('steps' as never)) text += ` ${WARN.steps}`
    return { kind: 'local', text }
  }
  if (has(q, ['breit', 'schmal', 'wide', 'width', 'narrow'])) return { kind: 'local', text: UNKNOWN }
  if (has(q, ['klingel', 'klingeln', 'bell', 'intercom', 'gegensprech'])) return { kind: 'local', text: UNKNOWN }
  if (has(q, ['automatisch', 'automatic', 'oeffnet sich', 'selbst auf', 'knopf', 'taster', 'button'])) {
    if (e.automatic) return { kind: 'local', text: 'Ja, die Tür öffnet automatisch.' }
    return { kind: 'local', text: UNKNOWN }
  }
  if (has(q, ['schwer', 'heavy'])) {
    if (e.warnings.includes('heavy' as never)) return { kind: 'local', text: 'Ja, die Tür ist als schwer gemeldet.' }
    return { kind: 'local', text: UNKNOWN }
  }
  if (has(q, ['ebene', 'stockwerk', 'etage', 'strassenhoehe', 'level', 'floor'])) {
    if (e.warnings.includes('level-mismatch' as never)) return { kind: 'local', text: WARN['level-mismatch'].replace('Achtung, der', 'Der') }
    if (e.level !== null) return { kind: 'local', text: `Der Eingang liegt auf Ebene ${e.level}.` }
    return { kind: 'local', text: UNKNOWN }
  }
  if (has(q, ['wie heisst', 'name', 'heisst der', 'called', 'what is it'])) {
    return { kind: 'local', text: c.name ? `Der Eingang heißt ${c.name}.` : UNKNOWN }
  }
  if (has(q, ['wie weit', 'entfernung', 'wie lange', 'meter', 'how far', 'distance', 'wie viele schritte'])) {
    if (c.distanceM === null || !Number.isFinite(c.distanceM)) return { kind: 'local', text: UNKNOWN }
    return { kind: 'local', text: metresText(c.distanceM) }
  }
  if (has(q, ['richtung', 'links', 'rechts', 'geradeaus', 'wohin', 'direction', 'which way', 'left', 'right'])) {
    if (c.relDeg !== null) return { kind: 'local', text: directionText(c.relDeg) }
    if (c.instruction) return { kind: 'local', text: `Die Anzeige sagt: ${c.instruction}.` }
    return { kind: 'local', text: UNKNOWN }
  }
  if (has(q, ['wo ist', 'wo finde', 'where'])) return { kind: 'local', text: whereText(c) }
  if (has(q, ['drehtuer', 'revolving'])) {
    if (e.door === 'revolving' || e.warnings.includes('revolving' as never)) return { kind: 'local', text: DOOR.revolving }
    if (e.door) return { kind: 'local', text: 'Nein, eine Drehtür ist hier nicht eingetragen.' }
    return { kind: 'local', text: UNKNOWN }
  }
  if (has(q, ['tuer', 'door'])) return { kind: 'local', text: doorText(c) }
  if (has(q, ['achtung', 'warnung', 'gefahr', 'hindernis', 'warning', 'danger'])) {
    const w = e.warnings.map((x) => WARN[x] ?? '').filter(Boolean)
    return { kind: 'local', text: w.length ? w.join(' ') : 'Für diesen Eingang sind keine Warnungen eingetragen.' }
  }
  return { kind: 'remote', withFrame: false }
}

/** Everything on the screen, in reading order, as one spoken text. */
export function readAloudText(c: AskCtx, opts: { live: boolean }): string {
  const e = c.entrance
  const parts: string[] = []
  if (opts.live && c.instruction) parts.push(`${c.instruction.replace(/ · /g, ', ')}.`)
  parts.push(`Ziel: ${c.name}.`)
  if (c.distanceM !== null && Number.isFinite(c.distanceM)) parts.push(metresText(c.distanceM))
  if (e.door) parts.push(`${DOOR[e.door] ?? DOOR.yes}${e.automatic ? ' Sie öffnet automatisch.' : ''}`)
  else if (e.automatic) parts.push('Die Tür öffnet automatisch.')
  parts.push(e.stepFree === true ? 'Stufenlos.' : e.stepFree === false ? 'Nicht stufenlos.' : 'Stufenlos: unbekannt.')
  for (const w of e.warnings) if (WARN[w]) parts.push(WARN[w])
  if (c.routeNote) parts.push(c.routeNote.trim().replace(/([^.!?])$/, '$1.'))
  return parts.join(' ')
}
