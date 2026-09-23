// Shared context the map screen hands to every feature panel (Unternehmen, Beitragen,
// Fuer dich, Places results, place cards). Panels render into the bottom sheet body and
// may draw on the map; they return a cleanup function that removes what they drew.

import type { LatLon } from '../core/geo'
import type { Profile } from '../core/profile'
import type { Building, Entrance } from '../core/types'

export interface FeatureCtx {
  /** The live Google map, or null when no Maps key is configured (render a list-only fallback). */
  map: google.maps.Map | null
  /** Entrances currently loaded for the viewport (contract shape, includes merged survey entries). */
  entrances: () => Entrance[]
  buildings: () => Building[]
  /** User position if known, else the map centre. */
  origin: () => LatLon
  profile: Profile
  /** Open the standard door card for an entrance (Route / Start / Teilen). */
  openDoor: (e: Entrance) => void
  /** Snap the bottom sheet. */
  setSheet: (state: 'peek' | 'half' | 'full') => void
  /** Re-fetch entrances and redraw markers, e.g. after a survey entry was saved. */
  refresh: () => void
  /** Leave the map for the walk recorder. */
  openRecorder: () => void
  /** Speak/announce through the app's live region (and speech when the profile wants it). */
  announce: (text: string) => void
}

/** A panel renders into `el` (the sheet body) and returns a cleanup function. */
export type Panel = (el: HTMLElement, ctx: FeatureCtx) => () => void
