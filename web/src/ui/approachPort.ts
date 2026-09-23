// The seam between the Approach screen (ui/Approach.ts) and the approach engine
// (core/approach.ts, owned by Malek). The screen imports ONLY from this file and renders
// ApproachView; it holds no guidance logic of its own.
//
// Types mirror docs/CONTRACT.md "Last 10 metres (v1)". DoorFix is copied verbatim.
//
// SWAP: when core/approach.ts lands, replace the one line marked "ENGINE" below with
//   import { startApproach as REAL_ENGINE } from '../core/approach'
// Nothing else changes. `?approach=demo` keeps using the scripted adapter after the swap.

import { apiBase } from '../config'
import type { Profile } from '../core/profile'
import type { Entrance } from '../core/types'
import { lang } from '../strings'
import { startDemoApproach } from './approachDemo' // TEMPORARY dev adapter, see approachDemo.ts

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
  /** POST /api/door-fix: one frame + heading -> DoorFix. */
  doorFix(frame: string, headingDeg: number | null): Promise<DoorFix>
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

// ENGINE (the one line to swap when core/approach.ts lands):
const REAL_ENGINE: StartApproach | null = null

/** The demo adapter until core lands, and always under ?approach=demo. */
export function engine(search = typeof location === 'undefined' ? '' : location.search): StartApproach {
  const demo = new URLSearchParams(search).get('approach') === 'demo'
  return REAL_ENGINE && !demo ? REAL_ENGINE : startDemoApproach
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

// ── HTTP clients ─────────────────────────────────────────────────────────────

const TIMEOUT_MS = 15000

async function postJson(path: string, body: unknown): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status })
    return await r.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Request shape follows /api/look ({frame: base64 JPEG, heading}); CONTRACT does not fix it yet. */
export async function postDoorFix(frame: string, headingDeg: number | null): Promise<DoorFix> {
  return (await postJson('/api/door-fix', { frame, heading: headingDeg })) as DoorFix
}

// ── wheelchair verdict ───────────────────────────────────────────────────────

export type Step = 'yes' | 'no' | 'unclear'
export type Opens = 'automatic' | 'push' | 'pull' | 'revolving' | 'unclear'

export interface DoorCheck {
  step: Step
  /** Clear width in cm, or null when unclear. */
  widthCm: number | null
  opens: Opens
}

export const UNCLEAR: DoorCheck = { step: 'unclear', widthCm: null, opens: 'unclear' }

const OPENS: readonly Opens[] = ['automatic', 'push', 'pull', 'revolving']

/**
 * Anything the model is unsure of becomes 'unclear', never a guess. CONTRACT names the
 * endpoint but not the response, so this accepts {step, widthCm, opens, confidence?}
 * and treats every other shape, and confidence below 0.5, as unclear.
 */
export function parseDoorCheck(raw: unknown): DoorCheck {
  if (typeof raw !== 'object' || raw === null) return UNCLEAR
  const o = raw as Record<string, unknown>
  if (typeof o.confidence === 'number' && !(o.confidence >= 0.5)) return UNCLEAR
  const step: Step = o.step === true || o.step === 'yes' ? 'yes' : o.step === false || o.step === 'no' ? 'no' : 'unclear'
  const w = o.widthCm
  const widthCm = typeof w === 'number' && Number.isFinite(w) && w >= 40 && w <= 400 ? w : null
  const opens = OPENS.includes(o.opens as Opens) ? (o.opens as Opens) : 'unclear'
  return { step, widthCm, opens }
}

/** POST /api/door-check with one frame. 404/503/network/garbage all resolve to UNCLEAR. */
export async function postDoorCheck(frame: string | null): Promise<{ check: DoorCheck; reachable: boolean }> {
  if (!frame) return { check: UNCLEAR, reachable: false }
  try {
    return { check: parseDoorCheck(await postJson('/api/door-check', { frame })), reachable: true }
  } catch {
    return { check: UNCLEAR, reachable: false }
  }
}
