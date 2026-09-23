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

/** Pre-synthesised clip key, so the common phrases never wait on the network. */
export function bandClipKey(band: Band): string {
  return `band_${band.replace(/-/g, '_')}`
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
