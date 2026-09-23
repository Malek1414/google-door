// End-to-end Live View verification: drive the real synthetic approach track through
// the real modules and assert the guidance actually behaves. Tests passing in
// isolation does not prove Live View works; this does.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { bearingDeg, haversineM, relativeBearing } from '../src/core/geo'
import { beaconFor, arrowPulseHz, ARRIVE_M, cuePan, HAPTIC_LEFT, HAPTIC_RIGHT, HAPTIC_ARRIVED } from '../src/core/beacon'
import { arrowTargetFor, nearestArrowTarget, guidanceFor } from '../src/core/target'
import type { Entrance } from '../src/core/types'

const track = JSON.parse(readFileSync('public/tracks/hbf-approach-synthetic.json', 'utf8')) as Array<{
  t: number; lat: number; lon: number; heading: number; accuracy: number
}>

// The real step-free door at Hbf, tier 1, from data/berlin-mitte.json
const DOOR: Entrance = {
  id: 'node/10795939972', buildingId: null, lat: 52.527210, lon: 13.371167,
  name: null, kind: 'secondary', level: null, stepFree: true, tier: 1,
  confidence: 'surveyed', door: null, automatic: false, approachBearing: null,
  description: null, warnings: [], source: 'osm',
} as unknown as Entrance

describe('Live View, driven by the real approach track', () => {
  const target = arrowTargetFor(DOOR, { stepFreeRequired: true })
  it('mints an arrow target for a tier-1 step-free door', () => {
    expect(target).not.toBeNull()
  })

  const frames = track.map((f) => {
    const pos = { lat: f.lat, lon: f.lon }
    const dist = haversineM(pos, DOOR)
    const toDoor = bearingDeg(pos, DOOR)
    const rel = relativeBearing(toDoor, f.heading)
    return { ...f, dist, toDoor, rel, beacon: beaconFor(dist, rel), pulse: arrowPulseHz(rel) }
  })

  it('walks the user closer: distance decreases monotonically overall', () => {
    expect(frames[0].dist).toBeGreaterThan(frames.at(-1)!.dist)
    console.log(`    start ${frames[0].dist.toFixed(1)} m -> end ${frames.at(-1)!.dist.toFixed(1)} m`)
  })

  it('actually arrives (final distance within the arrival threshold)', () => {
    expect(frames.at(-1)!.dist).toBeLessThanOrEqual(ARRIVE_M)
    console.log(`    final ${frames.at(-1)!.dist.toFixed(2)} m, ARRIVE_M=${ARRIVE_M}`)
  })

  it('beacon pulse rate rises as the door gets closer', () => {
    const far = frames[0].beacon.pulseHz
    const near = frames.at(-1)!.beacon.pulseHz
    expect(near).toBeGreaterThan(far)
    console.log(`    pulseHz ${far.toFixed(2)} -> ${near.toFixed(2)}`)
  })

  it('every frame produces finite, in-range guidance (no NaN reaches the screen)', () => {
    for (const f of frames) {
      expect(Number.isFinite(f.dist)).toBe(true)
      expect(Number.isFinite(f.toDoor)).toBe(true)
      expect(f.toDoor).toBeGreaterThanOrEqual(0)
      expect(f.toDoor).toBeLessThan(360)
      expect(f.rel).toBeGreaterThanOrEqual(-180)
      expect(f.rel).toBeLessThanOrEqual(180)
      expect(Number.isFinite(f.beacon.pulseHz)).toBe(true)
      expect(Math.abs(f.beacon.panLR)).toBeLessThanOrEqual(1)
    }
  })

  it('the track exercises real heading error, not a straight line at the door', () => {
    const worst = Math.max(...frames.map((f) => Math.abs(f.rel)))
    console.log(`    worst |rel| across the whole track = ${worst.toFixed(1)}deg`)
    // A track that never leaves the bearing would not test the arrow at all.
    expect(worst).toBeGreaterThan(30)
  })

  it('STRESS: arrow stays sane when the user faces the wrong way', () => {
    const pos = { lat: track[0].lat, lon: track[0].lon }
    const toDoor = bearingDeg(pos, DOOR)
    for (const off of [0, 45, 90, 135, 180, -45, -90, -135]) {
      const rel = relativeBearing(toDoor, (toDoor + off + 360) % 360)
      const b = beaconFor(haversineM(pos, DOOR), rel)
      expect(Number.isFinite(rel)).toBe(true)
      expect(Math.abs(rel)).toBeLessThanOrEqual(180)
      expect(Math.abs(b.panLR)).toBeLessThanOrEqual(1)
      expect(b.pitchHz).toBe(Math.abs(rel) <= 15 ? 660 : 440)
    }
  })

  it('STRESS: behind-the-user stays hard to one side, never centred', () => {
    // A door directly behind must not read as "straight ahead".
    expect(beaconFor(30, 175).panLR).toBe(1)
    expect(beaconFor(30, -175).panLR).toBe(-1)
  })

  it('stereo pan carries direction via beaconFor (left negative, right positive)', () => {
    expect(beaconFor(30, -90).panLR).toBeLessThan(0)
    expect(beaconFor(30, 90).panLR).toBeGreaterThan(0)
    expect(Math.abs(beaconFor(30, 0).panLR)).toBeLessThan(0.05)
  })

  it('cuePan maps haptic patterns to stereo sides (iOS has no Vibration API)', () => {
    expect(cuePan(HAPTIC_LEFT)).toBe(-1)
    expect(cuePan(HAPTIC_RIGHT)).toBe(1)
    expect(cuePan(HAPTIC_ARRIVED)).toBe(0)
  })

  it('FRAGILE: cuePan uses reference equality, so a copied pattern silently centres', () => {
    // Not currently triggered, but a JSON round-trip or [...HAPTIC_LEFT] would
    // return 0 (centre) instead of -1 (left) — a wrong cue, not a missing one.
    expect(cuePan([...HAPTIC_LEFT])).toBe(0)
  })

  it('SAFETY: a tier-2 door never yields an arrow, even on this track', () => {
    const t2 = { ...DOOR, tier: 2, confidence: 'reported' } as unknown as Entrance
    expect(arrowTargetFor(t2, { stepFreeRequired: true })).toBeNull()
    expect(guidanceFor(t2, { stepFreeRequired: true }).kind).toBe('text')
  })

  it('SAFETY: a wheelchair user is never routed to a non-step-free door', () => {
    const steps = { ...DOOR, stepFree: false } as unknown as Entrance
    expect(arrowTargetFor(steps, { stepFreeRequired: true })).toBeNull()
    expect(nearestArrowTarget({ lat: 52.5272, lon: 13.3711 }, [steps], { stepFreeRequired: true })).toBeNull()
  })

  it('SAFETY: unknown step-free status is not treated as usable', () => {
    const unk = { ...DOOR, stepFree: null } as unknown as Entrance
    expect(arrowTargetFor(unk, { stepFreeRequired: true })).toBeNull()
  })
})
