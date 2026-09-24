// Live View's door recogniser: in the last ~25 m to a surveyed demo door, asks
// /api/door-fix about the camera picture and keeps the answer the way the approach
// engine does. The same parse (approachEngine.parseDoorFix), Malek's StabilityGuard
// (core/stability.ts) as the judge, and core/anchor.ts to carry a fix forward with the
// compass and to say when it has gone stale. No new trust rules of its own.

import { project, type Anchor } from '../core/anchor'
import { StabilityGuard } from '../core/stability'
import { parseDoorFix, RATE_LIMIT_BACKOFF_MS, TIMEOUT_MS } from './approachEngine'

/** Live View asks for the door only this close (metres by GPS/route). */
export const SPOT_WITHIN_M = 25
/** One request at a time, at most this often. */
export const SPOT_EVERY_MS = 1500

/** Pure. Does this door get camera recognition in Live View? Surveyed demo doors only
 *  (they carry a description and a reference photo on the server), tier 1 only. */
export function spotsDoor(door: { id: string; tier: number }, distM: number): boolean {
  return door.tier === 1 && door.id.startsWith('demo/') && Number.isFinite(distM) && distM <= SPOT_WITHIN_M
}

export interface Spotted {
  relBearingDeg: number
  distanceM: number
  confidence: number
  source: 'gemini-frame' | 'gemini-live'
}

export interface SpotterDeps {
  fetch: typeof fetch
  now: () => number
  apiBase: string
  doorId: string
}

export class DoorSpotter {
  private guard = new StabilityGuard()
  private anchor: (Anchor & { confidence: number }) | null = null
  private inFlight: AbortController | null = null
  private sentAt = -Infinity
  private notBefore = -Infinity
  private stopped = false

  constructor(private readonly deps: SpotterDeps) {}

  /** Call on every update; sends a frame when one is due. */
  tick(frame: () => string | null, headingDeg: number): void {
    const now = this.deps.now()
    if (this.stopped || !Number.isFinite(headingDeg)) return
    if (this.inFlight) {
      if (now - this.sentAt < TIMEOUT_MS) return
      this.inFlight.abort() // too slow: a late answer describes a picture long gone
      this.inFlight = null
    }
    if (now < this.notBefore || now - this.sentAt < SPOT_EVERY_MS) return
    const f = frame()
    this.sentAt = now
    if (!f) return
    const ctl = new AbortController()
    this.inFlight = ctl
    const at = { heading: headingDeg, ts: now }
    void this.deps
      .fetch(`${this.deps.apiBase}/api/door-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frame: f, headingDeg, doorId: this.deps.doorId }),
        signal: ctl.signal,
      })
      .then(async (r) => {
        if (r.status === 429) this.notBefore = this.deps.now() + RATE_LIMIT_BACKOFF_MS
        return r.ok ? ((await r.json()) as unknown) : null
      })
      .catch(() => null)
      .then((raw) => {
        if (this.inFlight !== ctl || this.stopped) return
        this.inFlight = null
        const fix = parseDoorFix(raw)
        if (!fix) return
        const verdict = this.guard.push({ bearingDeg: fix.bearingDeg, headingDeg: at.heading, confidence: fix.confidence, distanceM: fix.distanceM })
        if (!verdict.trusted) return
        this.anchor = { bearingDeg: fix.bearingDeg, distanceM: fix.distanceM, headingDeg: at.heading, steps: 0, ts: at.ts, source: fix.source, confidence: fix.confidence }
      })
  }

  /** The door now, from the last trusted fix carried by the compass; null when there is
   *  none or it is stale (core/anchor MAX_AGE_MS). */
  current(headingDeg: number): Spotted | null {
    const a = this.anchor
    if (!a || !Number.isFinite(headingDeg)) return null
    const p = project(a, headingDeg, 0, this.deps.now())
    if (!p.fresh || p.source === 'osm-fallback') return null
    return { relBearingDeg: p.relBearingDeg, distanceM: p.distanceM, confidence: a.confidence, source: p.source }
  }

  stop(): void {
    this.stopped = true
    this.inFlight?.abort()
    this.inFlight = null
  }
}
