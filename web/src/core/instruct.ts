// What to say. Pure, no I/O, no speech.
//
// The bands are fixed and the wording never varies for the same band. A blind user
// learns these five phrases in one approach; rephrasing them for variety would undo
// that, so there is deliberately no variety here.
//
// Speech marks STATE CHANGES only. The continuous work of turning belongs to the
// beacon, whose pitch rises as the error falls — sub-100 ms and wordless. Words
// arrive after the turn has already overshot, which is why "links … links … links"
// makes people spin past the door.

export type Band = 'straight' | 'slight-left' | 'slight-right' | 'left' | 'right' | 'sharp-left' | 'sharp-right' | 'turn-around'

export const ON_BEARING_DEG = 8

/** Which band a relative bearing falls in. Negative is left. */
export function bandFor(relDeg: number): Band {
  if (!Number.isFinite(relDeg)) return 'straight'
  const a = Math.abs(relDeg)
  const left = relDeg < 0
  if (a <= ON_BEARING_DEG) return 'straight'
  if (a <= 25) return left ? 'slight-left' : 'slight-right'
  if (a <= 70) return left ? 'left' : 'right'
  if (a <= 135) return left ? 'sharp-left' : 'sharp-right'
  return 'turn-around'
}

const DE: Record<Band, string> = {
  straight: 'Geradeaus',
  'slight-left': 'Leicht links',
  'slight-right': 'Leicht rechts',
  left: 'Links',
  right: 'Rechts',
  'sharp-left': 'Scharf links',
  'sharp-right': 'Scharf rechts',
  'turn-around': 'Dreh dich um',
}

const EN: Record<Band, string> = {
  straight: 'Straight ahead',
  'slight-left': 'Slightly left',
  'slight-right': 'Slightly right',
  left: 'Left',
  right: 'Right',
  'sharp-left': 'Sharp left',
  'sharp-right': 'Sharp right',
  'turn-around': 'Turn around',
}

export function bandText(band: Band, lang = 'de'): string {
  return (lang.startsWith('de') ? DE : EN)[band]
}

/**
 * Pre-synthesised clip key, so the common phrases never wait on the network.
 *
 * Three bands reuse clips the Live View bank already has, because the German wording
 * is identical. That is not a micro-optimisation: Gemini TTS is capped at 100 requests
 * PER DAY on this tier, so every clip that does not need generating is one left for
 * the demo.
 */
const REUSED: Partial<Record<Band, string>> = {
  straight: 'straight',   // "Geradeaus."
  left: 'turn_left',      // "Links."
  right: 'turn_right',    // "Rechts."
}

export function bandClipKey(band: Band): string {
  return REUSED[band] ?? `band_${band.replace(/-/g, '_')}`
}

/** Metres, spoken only at these steps so the voice is not a running commentary. */
const DISTANCE_STEPS = [1, 2, 3, 5, 8, 10]

/**
 * Should the distance be spoken now?
 *
 * Takes the LOWEST step already announced rather than the previous distance. Comparing
 * against the previous reading looks equivalent but is not: drifting back and forth
 * across a boundary would re-announce it every crossing, and standing near one would
 * chatter. A step is announced once per approach and never again.
 *
 * Returns the step to announce, or null.
 */
export function shouldSpeakDistance(lowestSpoken: number | null, nowM: number): number | null {
  if (!Number.isFinite(nowM)) return null
  // Smallest step first. Largest-first looks equivalent but announces a STALE step
  // when the user has crossed several at once: at 2.4 m it would say "eight metres".
  // The nearest step at or above the current distance is the only honest one.
  for (const step of [...DISTANCE_STEPS].sort((a, b) => a - b)) {
    if (nowM <= step && (lowestSpoken === null || step < lowestSpoken)) return step
  }
  return null
}

/** Said once, at the start, before anything else. Not negotiable — see CONTRACT. */
export function safetyLine(lang = 'de'): string {
  return lang.startsWith('de')
    ? 'Ich führe dich nur zur Tür. Achte weiter selbst auf deine Umgebung.'
    : "I'll guide you to the door only. Keep paying attention to your surroundings."
}

/** Shown and spoken when vision failed and the bearing came from the map instead. */
export function fallbackLine(lang = 'de'): string {
  return lang.startsWith('de')
    ? 'Ich sehe den Eingang nicht. Laut Karte liegt er in dieser Richtung.'
    : "I can't see the entrance. According to the map it's in this direction."
}

/** Said once when Live streaming has been abandoned for the rest of the approach. */
export function unsureLine(lang = 'de'): string {
  return lang.startsWith('de') ? 'Ich bin mir gerade unsicher.' : "I'm not certain right now."
}


// ── lines that were living in the UI ────────────────────────────────────────
// approachEngine.ts had the threshold phrase, the metres wording and the beacon
// pitch curve inline. Wording and the sound of guidance are guidance, so they
// belong here with the bands, not in a screen.

/** Spoken when the door is within reach. Matches CONTRACT § Phases. */
export function thresholdLine(lang = 'de'): string {
  return lang.startsWith('de') ? 'Die Tür ist direkt vor dir.' : 'The door is right in front of you.'
}

/** Spoken when vision fails AND the door has no surveyed bearing either — so there
 *  is genuinely nothing to point at. Saying "according to the map" would be a lie.
 *  Rule 2 says never dead-reckon; it does not say fall silent, and silence is
 *  indistinguishable from a crash to someone who cannot see the screen. */
export function noDirectionLine(lang = 'de'): string {
  return lang.startsWith('de')
    ? 'Ich sehe den Eingang nicht und habe keine Richtung dafür. Schwenke die Kamera langsam.'
    : "I can't see the entrance and have no direction for it. Pan the camera slowly."
}

/** Spoken when the user should be inside. Vision proposes; the user can take it back. */
export function throughLine(lang = 'de'): string {
  return lang.startsWith('de') ? 'Du müsstest jetzt drin sein.' : 'You should be inside now.'
}

export function metresLine(m: number, lang = 'de'): string {
  const n = Math.max(0, Math.round(m))
  if (lang.startsWith('de')) return n === 1 ? 'Ein Meter' : `${n} Meter`
  return n === 1 ? 'One metre' : `${n} metres`
}

/**
 * Beacon pitch for a bearing error: the sound the user actually steers by.
 *
 * Squared so the change is sharpest near centre — a linear curve feels vague exactly
 * where precision matters, because the last few degrees produce almost no audible
 * change and people stop turning too early.
 */
/**
 * Every spoken line in the approach, as a stable clip key. (Q9)
 *
 * The screen plays a pre-synthesised clip when one exists and only falls through to
 * /api/speak when it does not. That matters because the TTS tier allows 100 requests
 * a day and a single approach speaks a dozen lines: without this the demo runs out of
 * voice partway through the walk it is meant to show.
 *
 * Keys are the contract with the synthesis pipeline. Do not rename one without
 * regenerating the bank; a missing clip is silent-but-safe (it falls back to the API),
 * a renamed one is a clip that never plays again.
 */
export type ApproachLine =
  | { kind: 'band'; band: Band }
  | { kind: 'metres'; m: number }
  | { kind: 'safety' | 'fallback' | 'unsure' | 'threshold' | 'through' | 'noDirection' }

export function clipKeyFor(line: ApproachLine): string | null {
  switch (line.kind) {
    case 'band':
      return bandClipKey(line.band)
    case 'metres': {
      const n = Math.max(0, Math.round(line.m))
      // Only the bank that exists: 1..10 m. Anything further is spoken live, and by
      // then the user is not yet in the part of the walk that has to be flawless.
      return n >= 1 && n <= 10 ? `m_${n}` : null
    }
    default:
      return `approach_${line.kind}`
  }
}

/** The whole bank, for the synthesis pipeline to iterate. Keys and their German text. */
export function approachClipBank(lang = 'de'): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [
    { key: 'approach_safety', text: safetyLine(lang) },
    { key: 'approach_fallback', text: fallbackLine(lang) },
    { key: 'approach_unsure', text: unsureLine(lang) },
    { key: 'approach_threshold', text: thresholdLine(lang) },
    { key: 'approach_through', text: throughLine(lang) },
    { key: 'approach_noDirection', text: noDirectionLine(lang) },
  ]
  for (let n = 1; n <= 10; n++) out.push({ key: `m_${n}`, text: metresLine(n, lang) })
  return out
}

export const PITCH_MIN_HZ = 330
export const PITCH_MAX_HZ = 740

export function pitchFor(relDeg: number): number {
  if (!Number.isFinite(relDeg)) return PITCH_MIN_HZ
  const a = Math.min(180, Math.abs(relDeg))
  const closeness = 1 - a / 180
  return PITCH_MIN_HZ + (PITCH_MAX_HZ - PITCH_MIN_HZ) * closeness * closeness
}
