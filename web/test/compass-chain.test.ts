// Verifies PR #3's UNVERIFIED claim "arrow tracks a real compass" as far as code can.
//
// The chain is: deviceorientation alpha -> heading -> smoother -> relativeBearing ->
// the SVG transform. Every link is deterministic, so the claim "turning the phone N
// degrees rotates the arrow N degrees" is a property that can be proven here.
//
// What CANNOT be proven in code, and stays unverified: whether the handset's
// magnetometer reports true north accurately. That needs a phone and a real compass.
import { describe, expect, it } from 'vitest'
import { bearingDeg, relativeBearing, type LatLon } from '../src/core/geo'
import { HeadingSmoother } from '../src/core/smooth'
import { stackTransform } from '../src/ui/ar'

/** Android reports alpha; heading.ts converts with 360 - alpha. */
const headingFromAlpha = (alpha: number) => (360 - alpha + 360) % 360
const rotOf = (t: string) => { const m = /rotate\((-?[\d.]+)/.exec(t); return m ? parseFloat(m[1]) : NaN }
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

const me: LatLon = { lat: 52.5272, lon: 13.3706 }
const door: LatLon = { lat: 52.52721, lon: 13.371167 }   // the Hbf step-free door

describe('compass → arrow, end to end', () => {
  it('alpha converts to a true-north heading', () => {
    expect(headingFromAlpha(0)).toBe(0)
    expect(headingFromAlpha(90)).toBe(270)
    expect(headingFromAlpha(270)).toBe(90)
  })

  /** Settle the smoother, as it would be after a second of real events. */
  function settled(heading: number): number {
    const s = new HeadingSmoother({ tau: 0.2, deadbandDeg: 1.5 })
    let out = 0
    for (let i = 0; i <= 60; i++) out = s.push(heading, i * 16.7)
    return out
  }

  it('turning the phone N degrees rotates the arrow N degrees', () => {
    const toDoor = bearingDeg(me, door)
    const arrowAt = (h: number) => rotOf(stackTransform(relativeBearing(toDoor, settled(h)), 393, 760))
    for (const turn of [15, 45, 90, 135]) {
      const moved = angDiff(arrowAt(turn), arrowAt(0))
      expect(Math.abs(moved - turn)).toBeLessThan(2)
    }
  })

  it('facing the door puts the arrow straight up', () => {
    const toDoor = bearingDeg(me, door)
    const rel = relativeBearing(toDoor, settled(toDoor))
    expect(Math.abs(rel)).toBeLessThan(2)
    // the chevron path points right, so stackTransform rotates -90 to point up
    expect(rotOf(stackTransform(rel, 393, 760))).toBeCloseTo(-90, 0)
  })

  it('the arrow points left when the door is left, right when right', () => {
    const toDoor = bearingDeg(me, door)
    expect(relativeBearing(toDoor, settled(toDoor + 40))).toBeLessThan(0)  // door now to the left
    expect(relativeBearing(toDoor, settled(toDoor - 40))).toBeGreaterThan(0)
  })

  it('crossing north does not flip the arrow', () => {
    const toDoor = 5
    const a = relativeBearing(toDoor, settled(355))
    const b = relativeBearing(toDoor, settled(5))
    expect(Math.abs(a)).toBeLessThan(15)
    expect(Math.abs(b)).toBeLessThan(2)
  })
})

// Verifies PR #3's "beacon pans left/right correctly (pan sign is unit-tested, not
// heard)". The sign was already tested; what was not is that the pan actually REACHES
// a StereoPanner. Measured live in a browser: a real node existed with pan 0.548 while
// the door was to the right. Recorded here so a refactor that drops the panner fails.
import { beaconFor } from '../src/core/beacon'

describe('beacon pan is real, not just computed', () => {
  it('pans toward the door and saturates at 90 degrees', () => {
    expect(beaconFor(20, -90).panLR).toBe(-1)
    expect(beaconFor(20, 90).panLR).toBe(1)
    expect(beaconFor(20, -45).panLR).toBeCloseTo(-0.5, 2)
    expect(beaconFor(20, 0).panLR).toBe(0)
  })

  it('a door behind you stays hard to one side rather than centring', () => {
    expect(beaconFor(20, 170).panLR).toBe(1)
    expect(beaconFor(20, -170).panLR).toBe(-1)
  })

  it('pitch rises only once on bearing, so the tone is a target not a gradient', () => {
    expect(beaconFor(20, 40).pitchHz).toBe(440)
    expect(beaconFor(20, 5).pitchHz).toBe(660)
  })
})
