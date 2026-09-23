// Pure + storage. Barrierefrei-Modus: 'standard' behaves like plain Google Maps,
// 'access' turns on accessibility chips, door markers and the audio beacon.

import { parseProfile, PROFILE_KEY, type Profile } from './profile'

export type Mode = 'standard' | 'access'

export const MODE_KEY = 'doorway.mode'

/** Chip ids per mode. Standard mirrors Google Maps categories; access filters doors. */
export type StandardChip = 'restaurants' | 'coffee' | 'shopping' | 'hotels' | 'transit' | 'parking'
export type AccessChip = 'stepFree' | 'withSteps' | 'automatic' | 'noRevolving'
export type ChipId = StandardChip | AccessChip

const STANDARD_CHIPS: readonly StandardChip[] = ['restaurants', 'coffee', 'shopping', 'hotels', 'transit', 'parking']
const ACCESS_CHIPS: readonly AccessChip[] = ['stepFree', 'withSteps', 'automatic', 'noRevolving']

const DEFAULT_CHANNELS = ['speech', 'visual']

type Store = Pick<Storage, 'getItem' | 'setItem'>

function defaultStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function parseMode(raw: string | null): Mode | null {
  return raw === 'standard' || raw === 'access' ? raw : null
}

/** A profile that asks for more than the onboarding default implies the user needs access mode. */
export function modeForProfile(p: Profile | null): Mode {
  if (!p) return 'standard'
  if (p.stepFreeRequired) return 'access'
  const ch = [...p.channels].sort()
  const isDefault = ch.length === DEFAULT_CHANNELS.length && ch.every((c, i) => c === DEFAULT_CHANNELS[i])
  return ch.length > 0 && !isDefault ? 'access' : 'standard'
}

export function loadMode(store: Store | null = defaultStore()): Mode {
  if (!store) return 'standard'
  try {
    const saved = parseMode(store.getItem(MODE_KEY))
    if (saved) return saved
    return modeForProfile(parseProfile(store.getItem(PROFILE_KEY)))
  } catch {
    return 'standard'
  }
}

export function saveMode(m: Mode, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(MODE_KEY, m)
  } catch {
    /* private mode or blocked storage: the switch still works for this session */
  }
}

export function chipsFor(mode: Mode): ChipId[] {
  return mode === 'access' ? [...ACCESS_CHIPS] : [...STANDARD_CHIPS]
}

/** Door markers on the map only in access mode; place cards show doors in both. */
export function showDoorMarkers(mode: Mode): boolean {
  return mode === 'access'
}
