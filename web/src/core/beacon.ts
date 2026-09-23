// Pure. distance + relative bearing -> audio parameters, plus the cue grammar
// (visual pulse, haptics, early speech). No Web Audio here; see src/audio.ts.

export interface BeaconState {
  pulseHz: number
  panLR: number
  volume: number
  pitchHz: number
}

export const FAR_M = 60
export const NEAR_M = 2
export const PULSE_FAR_HZ = 0.7
export const PULSE_NEAR_HZ = 8
export const PITCH_OFF_HZ = 440
export const PITCH_ON_HZ = 660
export const ON_BEARING_DEG = 15
export const VOLUME_FAR = 0.25
export const VOLUME_NEAR = 0.6 // secondary channel: modest range on purpose

/** Arrival radius, how far before it the spoken line fires, and the "near the entrance" line. */
export const ARRIVE_M = 3
export const SPEAK_EARLY_M = 2.5
export const APPROACH_M = 10

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** 0 at FAR_M or beyond, 1 at NEAR_M or closer. Unknown distance counts as far. */
function proximity(distanceM: number): number {
  if (!Number.isFinite(distanceM)) return 0
  return clamp((FAR_M - distanceM) / (FAR_M - NEAR_M), 0, 1)
}

export function beaconFor(distanceM: number, relBearingDeg: number): BeaconState {
  const p = proximity(distanceM)
  const rel = Number.isFinite(relBearingDeg) ? clamp(relBearingDeg, -180, 180) : 0
  return {
    pulseHz: PULSE_FAR_HZ + (PULSE_NEAR_HZ - PULSE_FAR_HZ) * p,
    // Full pan at 90 degrees off; anything behind stays hard to that side.
    panLR: clamp(rel / 90, -1, 1),
    volume: VOLUME_FAR + (VOLUME_NEAR - VOLUME_FAR) * p,
    pitchHz: Math.abs(rel) <= ON_BEARING_DEG ? PITCH_ON_HZ : PITCH_OFF_HZ,
  }
}

/** Visual arrow pulse: rises continuously as |relBearing| falls (1 Hz behind, 4 Hz dead ahead). */
export function arrowPulseHz(relBearingDeg: number): number {
  const a = Number.isFinite(relBearingDeg) ? Math.min(180, Math.abs(relBearingDeg)) : 180
  return 1 + 3 * (1 - a / 180)
}

export const HAPTIC_LEFT = [80, 120, 80] // two short
export const HAPTIC_RIGHT = [80, 120, 80, 120, 80] // three short
export const HAPTIC_ARRIVED = [700] // one long

/** Which vibration pattern (if any) this moment calls for. */
export function hapticFor(distanceM: number, relBearingDeg: number): number[] | null {
  if (Number.isFinite(distanceM) && distanceM <= ARRIVE_M) return HAPTIC_ARRIVED
  if (!Number.isFinite(relBearingDeg) || Math.abs(relBearingDeg) <= ON_BEARING_DEG) return null
  return relBearingDeg < 0 ? HAPTIC_LEFT : HAPTIC_RIGHT
}

/** Stereo position of a cue: left pattern hard left, right pattern hard right, arrival centred. */
export function cuePan(pattern: number[]): number {
  if (pattern === HAPTIC_LEFT) return -1
  if (pattern === HAPTIC_RIGHT) return 1
  return 0
}

/** One-off "you are near the entrance" line at 10 m, unless the arrival line already covers it. */
export function shouldAnnounceApproach(distanceM: number): boolean {
  return Number.isFinite(distanceM) && distanceM <= APPROACH_M && !shouldSpeakArrival(distanceM)
}

/** The arrival line fires 2.5 m before the arrival radius to hide speech latency. */
export function shouldSpeakArrival(distanceM: number): boolean {
  return Number.isFinite(distanceM) && distanceM <= ARRIVE_M + SPEAK_EARLY_M
}
