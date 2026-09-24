// The seam between the Approach screen (ui/Approach.ts) and the approach engine
// (core/approach.ts, owned by Malek). The screen imports ONLY from this file and renders
// ApproachView; it holds no guidance logic of its own.
//
// Types mirror docs/CONTRACT.md "Last 10 metres (v1)". DoorFix is copied verbatim.
//
// The engine is ui/approachEngine.ts (Malek's core composed with the sensors and the
// /api/door-fix loop). `?approach=demo` swaps in the scripted adapter for screenshots.
// The wheelchair verdict lives in ui/doorCheck.ts.

import type { Profile } from '../core/profile'
import type { Entrance } from '../core/types'
import { lang } from '../strings'
import { startDemoApproach } from './approachDemo' // TEMPORARY dev adapter, see approachDemo.ts
import { startApproach } from './approachEngine'

// ── contract types ───────────────────────────────────────────────────────────

export type DoorKind = 'sliding' | 'hinged' | 'revolving' | 'opening' | 'unknown'
export type DoorFixSource = 'gemini-live' | 'gemini-frame' | 'osm-fallback'

/** What vision returns. Verbatim from CONTRACT.md. */
export interface DoorFix {
  found: boolean
  /** RELATIVE TO THE CAMERA CENTRE, negative left. Not a compass bearing. */
  bearingDeg: number
  distanceM: number
  confidence: number
  kind: DoorKind
  note: string
  ts: number
  source: DoorFixSource
}

export type Phase = 'orienting' | 'walking' | 'threshold' | 'through'

/** Everything the screen draws and says. Produced by the engine, never computed here. */
export interface ApproachView {
  phase: Phase
  /** Door relative to where the phone points, degrees, negative left. null: no door known. */
  relBearingDeg: number | null
  /** Metres to the door. null: unknown. */
  distanceM: number | null
  /** The exact words (core/instruct.ts). Shown, spoken and announced verbatim. */
  instruction: string
  /** Where the current direction comes from. null: no fix yet. */
  source: DoorFixSource | null
  /** The stability guard has tripped (sticky for the rest of the approach). */
  unsure: boolean
  /** Beacon pitch in Hz. undefined: beacon silent. The engine owns the curve. */
  beaconPitch?: number
}

// ── what the screen hands the engine ────────────────────────────────────────

export interface CompassReading {
  deg: number
  accuracy: number | null
}

/** Effects the engine needs, injected so core/ stays testable without a phone. No GPS. */
export interface ApproachIO {
  /** The door picked on the map (surveyed coordinate, approach bearing, door type). */
  door: Entrance
  /** Base64 JPEG of the current camera frame, or null when there is no picture yet. */
  frame(): string | null
  /** Compass only (never GPS course). Returns unsubscribe. */
  onHeading(cb: (h: CompassReading) => void): () => void
  /** Raw device motion for step detection. Returns unsubscribe. */
  onMotion(cb: (e: DeviceMotionEvent) => void): () => void
  /** Base URL for /api/live-token and friends. */
  apiBase: string
}

export interface ApproachSession {
  /** Called on every view change (and once with the initial view). Returns unsubscribe. */
  subscribe(cb: (v: ApproachView) => void): () => void
  /** The "Noch draußen" button: vision said inside, the user says not yet. */
  stillOutside(): void
  /** Screen closed. Stop timers, streams and listeners. */
  stop(): void
}

export type StartApproach = (io: ApproachIO) => ApproachSession

/** The real engine by default; the scripted adapter only under ?approach=demo. */
export function engine(search = typeof location === 'undefined' ? '' : location.search): StartApproach {
  return new URLSearchParams(search).get('approach') === 'demo' ? startDemoApproach : startApproach
}

// ── who gets which screen ────────────────────────────────────────────────────

export type ApproachMode = 'guide' | 'check'

/** Label of the arrival-card button. Same button for both modes. */
export const APPROACH_TRIGGER = lang === 'de' ? 'Zum Eingang führen' : 'Guide me to the entrance'

/**
 * Which screen the arrival-card button opens, or null for no button. Step-free profiles
 * get the one-shot verdict (they can see the door), speech profiles the guidance loop,
 * deaf-only profiles nothing. An empty channel list means "all channels", as in
 * core/profile.ts outputFor, so it counts as speech.
 */
export function approachModeFor(p: Profile | null | undefined): ApproachMode | null {
  if (!p) return null
  if (p.stepFreeRequired) return 'check'
  if (p.channels.length === 0 || p.channels.includes('speech')) return 'guide'
  return null
}
