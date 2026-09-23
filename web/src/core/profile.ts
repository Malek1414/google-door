// Pure. Two axes (route constraint, output channels) -> output config.

export type Channel = 'speech' | 'visual' | 'haptic'

export interface Profile {
  stepFreeRequired: boolean
  channels: Channel[]
}

export interface OutputConfig {
  arrowScale: number
  contrast: 'yellow-black' | 'white-black' | 'black-white'
  speak: boolean
  beacon: boolean
  haptics: boolean
  dimScreen: boolean
}

export const PROFILE_KEY = 'doorway.profile'
const ALL: Channel[] = ['speech', 'visual', 'haptic']

export function outputFor(p: Profile): OutputConfig {
  // Never silence every channel: an empty selection means "all of them".
  const ch = new Set<Channel>(p.channels.length ? p.channels : ALL)
  const visual = ch.has('visual')
  const audio = ch.has('speech')
  return {
    arrowScale: visual ? 1.6 : 1,
    // Large visuals: bright fill on dark ground. Without visuals the screen is secondary.
    contrast: visual ? 'yellow-black' : 'white-black',
    speak: audio,
    beacon: audio,
    haptics: ch.has('haptic'),
    dimScreen: !visual,
  }
}

/** Validate a stored profile. Returns null for anything malformed. */
export function parseProfile(raw: string | null): Profile | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    if (typeof o !== 'object' || o === null || typeof o.stepFreeRequired !== 'boolean') return null
    if (!Array.isArray(o.channels)) return null
    const channels = o.channels.filter((c: unknown): c is Channel => ALL.includes(c as Channel))
    return { stepFreeRequired: o.stepFreeRequired, channels: [...new Set(channels)] as Channel[] }
  } catch {
    return null
  }
}
