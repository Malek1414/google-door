// SAFETY: only tier 1 may produce a directional arrow (docs/CONTRACT.md, hard rule).
// A confident arrow to a door that isn't there can walk a blind user into traffic.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { arrowTargetFor, guidanceFor, markerKind, nearestArrowTarget } from '../src/core/target'
import type { Dataset, Entrance, Tier } from '../src/core/types'

const base: Entrance = {
  id: 'node/1',
  buildingId: null,
  lat: 52.5272097,
  lon: 13.3711667,
  name: null,
  kind: 'main',
  level: 0,
  stepFree: true,
  tier: 1,
  confidence: 'surveyed',
  door: null,
  automatic: false,
  approachBearing: null,
  description: null,
  warnings: [],
  source: 'osm',
}

const profiles = [{ stepFreeRequired: true }, { stepFreeRequired: false }]
const stepFreeValues = [true, false, null] as const
const NON_ARROW_TIERS: Tier[] = [0, 2, 3]

describe('no arrow for tier 0/2/3, ever', () => {
  for (const tier of NON_ARROW_TIERS) {
    for (const stepFree of stepFreeValues) {
      for (const p of profiles) {
        it(`tier ${tier}, stepFree ${stepFree}, stepFreeRequired ${p.stepFreeRequired}`, () => {
          const e = { ...base, tier, stepFree, confidence: 'surveyed' as const, source: 'osm' as const }
          expect(arrowTargetFor(e, p)).toBeNull()
          expect(guidanceFor(e, p).kind).toBe('text')
          expect(markerKind(e)).toBe('no-marker')
        })
      }
    }
  }

  it('nearestArrowTarget skips non-tier-1 doors even when they are closer', () => {
    const near2 = { ...base, id: 'node/2', tier: 2 as Tier }
    const near3 = { ...base, id: 'node/3', tier: 3 as Tier }
    const near0 = { ...base, id: 'node/0', tier: 0 as Tier }
    const far1 = { ...base, id: 'node/9', lat: base.lat + 0.001 }
    const t = nearestArrowTarget(base, [near2, near3, near0, far1], { stepFreeRequired: false })
    expect(t?.entrance.id).toBe('node/9')
    expect(nearestArrowTarget(base, [near2, near3, near0], { stepFreeRequired: false })).toBeNull()
  })

  it('holds over every entrance in data/berlin-mitte.json', () => {
    const d: Dataset = JSON.parse(readFileSync(resolve(__dirname, '../../data/berlin-mitte.json'), 'utf8'))
    let arrows = 0
    for (const e of d.entrances) {
      for (const p of profiles) {
        const t = arrowTargetFor(e, p)
        if (e.tier !== 1) expect(t).toBeNull()
        if (t) {
          arrows++
          expect(t.entrance.tier).toBe(1)
        }
      }
    }
    expect(arrows).toBeGreaterThan(0)
  })
})

describe('stepFree null is never coerced to false (or true)', () => {
  it('step-free-required user gets a distinct "unknown" reason, not "not step-free"', () => {
    const e = { ...base, stepFree: null }
    expect(guidanceFor(e, { stepFreeRequired: true })).toEqual({ kind: 'text', reason: 'step-free-unknown' })
  })
  // DATA DISCREPANCY: pipeline/ingest_osm.py assigns tier 1 to wheelchair=no doors too
  // (CONTRACT says tier 1 = wheelchair=yes). The gate must hold regardless.
  it('tier-1 stepFree:false door under a step-free profile never gets an arrow', () => {
    const e = { ...base, tier: 1 as Tier, stepFree: false }
    expect(arrowTargetFor(e, { stepFreeRequired: true })).toBeNull()
    const d: Dataset = JSON.parse(readFileSync(resolve(__dirname, '../../data/berlin-mitte.json'), 'utf8'))
    const bad = d.entrances.filter((x) => x.tier === 1 && x.stepFree !== true)
    for (const x of bad) expect(arrowTargetFor(x, { stepFreeRequired: true })).toBeNull()
  })
  it('explicit false is reported as not step-free', () => {
    const e = { ...base, stepFree: false }
    expect(guidanceFor(e, { stepFreeRequired: true })).toEqual({ kind: 'text', reason: 'not-step-free' })
    expect(markerKind(e)).toBe('not-step-free')
  })
  it('tier 1 step-free is an arrow for everyone', () => {
    for (const p of profiles) expect(arrowTargetFor(base, p)?.entrance.id).toBe('node/1')
  })
  it('non-finite coordinates never produce an arrow', () => {
    expect(arrowTargetFor({ ...base, lat: NaN }, { stepFreeRequired: false })).toBeNull()
  })
})
