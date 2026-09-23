import { describe, expect, it } from 'vitest'
import { project, needsReanchor, STEP_M, MAX_AGE_MS, type Anchor } from '../src/core/anchor'

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  bearingDeg: -20, headingDeg: 100, distanceM: 8, steps: 0, ts: 1000, source: 'gemini-live', ...over,
})

describe('project', () => {
  it('holds the bearing when nothing moved', () => {
    const p = project(anchor(), 100, 0, 1000)
    expect(p.relBearingDeg).toBeCloseTo(-20, 5)
    expect(p.distanceM).toBeCloseTo(8, 5)
  })

  it('turning the phone right moves the door further left', () => {
    // the door has not moved; the camera has
    const p = project(anchor(), 115, 0, 1500)
    expect(p.relBearingDeg).toBeCloseTo(-35, 5)
  })

  it('turning toward the door brings it to centre', () => {
    const p = project(anchor(), 80, 0, 1500)
    expect(Math.abs(p.relBearingDeg)).toBeLessThan(1)
  })

  it('walking toward the door closes the distance', () => {
    const p = project(anchor({ bearingDeg: 0 }), 100, 5, 2000)
    expect(p.distanceM).toBeCloseTo(8 - 5 * STEP_M, 3)
  })

  it('walking sideways past a door does not count as progress', () => {
    // door is 90 degrees off: every step is lateral
    const p = project(anchor({ bearingDeg: 90 }), 100, 6, 2000)
    expect(p.distanceM).toBeCloseTo(8, 2)
  })

  it('never reports a negative distance', () => {
    const p = project(anchor({ bearingDeg: 0, distanceM: 1 }), 100, 40, 3000)
    expect(p.distanceM).toBe(0)
  })

  it('goes stale rather than lying', () => {
    expect(project(anchor(), 100, 0, 1000 + MAX_AGE_MS - 1).fresh).toBe(true)
    expect(project(anchor(), 100, 0, 1000 + MAX_AGE_MS + 1).fresh).toBe(false)
  })

  it('carries the source through so the UI can name it', () => {
    expect(project(anchor({ source: 'osm-fallback' }), 100, 0, 1200).source).toBe('osm-fallback')
  })

  it('crosses the compass seam without flipping', () => {
    const p = project(anchor({ bearingDeg: 10, headingDeg: 355 }), 5, 0, 1200)
    expect(p.relBearingDeg).toBeCloseTo(0, 5)
  })
})

describe('needsReanchor', () => {
  it('asks again after a big turn', () => {
    expect(needsReanchor(anchor(), 100, 0, 1200)).toBe(false)
    expect(needsReanchor(anchor(), 130, 0, 1200)).toBe(true)
  })
  it('asks again after walking a few metres', () => {
    expect(needsReanchor(anchor(), 100, 2, 1200)).toBe(false)
    expect(needsReanchor(anchor(), 100, 8, 1200)).toBe(true)
  })
  it('asks again when the anchor is simply old', () => {
    expect(needsReanchor(anchor(), 100, 0, 1000 + MAX_AGE_MS + 10)).toBe(true)
  })
})
