// Pure. The ONLY place that decides whether an entrance may move an arrow.
//
// CONTRACT hard rule: only tier 1 may produce a directional arrow. Tiers 0, 2 and 3
// are text. LiveView accepts nothing but an ArrowTarget, and an ArrowTarget can only
// be minted by arrowTargetFor(). test/safety.test.ts pins this down.

import { haversineM, type LatLon } from './geo'
import type { Entrance } from './types'
import type { Profile } from './profile'

declare const brand: unique symbol
export interface ArrowTarget extends LatLon {
  readonly [brand]: 'tier1'
  entrance: Entrance
}

export type Guidance =
  | { kind: 'arrow'; target: ArrowTarget }
  | { kind: 'text'; reason: 'not-tier1' | 'not-step-free' | 'step-free-unknown' | 'bad-coords' }

export function guidanceFor(e: Entrance, p: Pick<Profile, 'stepFreeRequired'>): Guidance {
  if (e.tier !== 1) return { kind: 'text', reason: 'not-tier1' }
  if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon)) return { kind: 'text', reason: 'bad-coords' }
  if (p.stepFreeRequired) {
    // Strict equality: null (unknown) is NOT false, and it is not true either.
    if (e.stepFree === false) return { kind: 'text', reason: 'not-step-free' }
    if (e.stepFree !== true) return { kind: 'text', reason: 'step-free-unknown' }
  }
  return { kind: 'arrow', target: { lat: e.lat, lon: e.lon, entrance: e } as ArrowTarget }
}

export function arrowTargetFor(e: Entrance, p: Pick<Profile, 'stepFreeRequired'>): ArrowTarget | null {
  const g = guidanceFor(e, p)
  return g.kind === 'arrow' ? g.target : null
}

/** Nearest entrance that may carry an arrow for this profile, or null. */
export function nearestArrowTarget(
  from: LatLon,
  entrances: Entrance[],
  p: Pick<Profile, 'stepFreeRequired'>,
): ArrowTarget | null {
  let best: ArrowTarget | null = null
  let bestD = Infinity
  for (const e of entrances) {
    const t = arrowTargetFor(e, p)
    if (!t) continue
    const d = haversineM(from, t)
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return best
}

/** Entrances that get a map marker. Tier 0 and 3 never do; tier 2 is drawn at the building. */
export function markerKind(e: Entrance): 'step-free' | 'not-step-free' | 'no-marker' {
  if (e.tier !== 1) return 'no-marker'
  if (e.stepFree === true) return 'step-free'
  if (e.stepFree === false) return 'not-step-free'
  return 'no-marker' // tier 1 with unknown step-free status should not exist; do not guess a shape
}
