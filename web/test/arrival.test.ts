import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { APPROACH_PIN_M, NEAR_TRIGGER_M, ARRIVAL_EXIT_S, ARRIVE_JITTER_M, arrivalPlan, arrivalPrompt, isArrived, nearTriggerShown, type TimedFix } from '../src/ui/LiveView'
import { approachModeFor } from '../src/ui/approachPort'
import type { Profile } from '../src/core/profile'
import type { Entrance } from '../src/core/types'
import { haversineM } from '../src/core/geo'
import { ARRIVE_M } from '../src/core/beacon'
import { demoWalkTrack, sampleTrack } from '../src/sim/replay'

const door = { lat: 52.52, lon: 13.405 }
const M_PER_DEG_LAT = 111_195
/** A fix `m` metres north of the door at time `t` ms. */
const north = (m: number, t: number): TimedFix => ({ lat: door.lat + m / M_PER_DEG_LAT, lon: door.lon, t })

describe('isArrived', () => {
  it('empty history is not arrived', () => {
    expect(isArrived([], door)).toBe(false)
  })
  it('one fix inside ARRIVE_M is arrived', () => {
    expect(isArrived([north(2.5, 0)], door)).toBe(true)
  })
  it('a single fix at 3.8 m is not enough', () => {
    expect(isArrived([north(3.8, 0)], door)).toBe(false)
  })
  it('two still fixes within 4 m count as arrived (GPS jitter)', () => {
    expect(isArrived([north(3.8, 0), north(3.6, 1000)], door)).toBe(true)
  })
  it('two fixes within 4 m while still walking do not count', () => {
    expect(isArrived([north(3.9, 0), north(3.1 + 0.5, 500)], door)).toBe(false) // 0.6 m/s
  })
  it('a still fix outside the jitter radius does not count', () => {
    expect(isArrived([north(ARRIVE_JITTER_M + 0.5, 0), north(3.9, 2000)], door)).toBe(false)
  })
  it('identical timestamps: only an unmoved repeat counts', () => {
    expect(isArrived([north(3.7, 5), north(3.7, 5)], door)).toBe(true)
    expect(isArrived([north(3.9, 5), north(3.5, 5)], door)).toBe(false)
  })
  it('only the last two fixes matter', () => {
    expect(isArrived([north(40, 0), north(3.8, 9000), north(3.7, 10000)], door)).toBe(true)
  })
  it('bad coordinates are not arrived', () => {
    expect(isArrived([{ lat: NaN, lon: NaN, t: 0 }], door)).toBe(false)
  })
})

describe('nearTriggerShown: "Zum Eingang führen" in the Live View panel', () => {
  it('appears from NEAR_TRIGGER_M (10 m) in, before GPS says arrived; not at the pin distance', () => {
    expect(nearTriggerShown(40, false)).toBe(false)
    expect(NEAR_TRIGGER_M).toBe(10)
    expect(nearTriggerShown(NEAR_TRIGGER_M, false)).toBe(true)
    expect(nearTriggerShown(APPROACH_PIN_M, false)).toBe(false)
    // 10 m out: GPS near buildings may never get to 3-4 m, the button must be there.
    expect(nearTriggerShown(10, false)).toBe(true)
  })
  it('does not flash on jitter at the edge (1.3x hysteresis)', () => {
    expect(nearTriggerShown(NEAR_TRIGGER_M + 2, true)).toBe(true)
    expect(nearTriggerShown(NEAR_TRIGGER_M * 1.3 + 1, true)).toBe(false)
  })
  it('an unknown distance keeps the current state', () => {
    expect(nearTriggerShown(NaN, true)).toBe(true)
    expect(nearTriggerShown(NaN, false)).toBe(false)
  })
  it('both triggers open the approach through one handler', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/LiveView.ts'), 'utf8')
    expect(src).toMatch(/nearBtn\?\.addEventListener\('click', startApproach\)/)
    expect(src).toMatch(/approachBtn\?\.addEventListener\('click', startApproach\)/)
  })
  it('after teardown a late route reply or sensor tick cannot speak over the approach', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/LiveView.ts'), 'utf8')
    expect(src).toMatch(/function teardown\(\) \{\s*if \(closed\) return\s*closed = true/)
    expect(src).toMatch(/function update\(\) \{\s*if \(closed \|\| hidden \|\| !fix\) return/)
    expect(src).toMatch(/computeRoute\(from, target\)\.then\(\(out\) => \{\s*routeBusy = false\s*if \(closed\) return/)
  })
})

describe('arrivalPlan: the arrival card does not bounce a blind user back to the map', () => {
  const blind = approachModeFor({ stepFreeRequired: false, channels: ['speech'] })
  it('speech profile: focus lands on .apr-trigger, no auto-exit, the button is named', () => {
    expect(arrivalPlan(blind)).toEqual({ focus: 'approach', exitAfterS: null, nameTrigger: true })
  })
  it('any guide question waits for the answer; without one "Hier bleiben" and the countdown stay', () => {
    expect(arrivalPlan(approachModeFor({ stepFreeRequired: true, channels: ['visual'] }))).toEqual({ focus: 'approach', exitAfterS: null, nameTrigger: true })
    expect(arrivalPlan(null)).toEqual({ focus: 'stay', exitAfterS: ARRIVAL_EXIT_S, nameTrigger: false })
  })
  it('the card focuses the approach button when the plan says so', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/LiveView.ts'), 'utf8')
    expect(src).toMatch(/plan\.focus === 'approach' && approachBtn\) approachBtn\.focus/)
  })
})

describe('arrivalPrompt: "Sollen wir dir zeigen, wo du reinkommst?"', () => {
  const PROFILES: Record<string, Profile | null> = {
    blind: { stepFreeRequired: false, channels: ['speech'] },
    lowVision: { stepFreeRequired: false, channels: ['speech', 'visual'] },
    wheelchair: { stepFreeRequired: true, channels: ['visual'] },
    deafOnly: { stepFreeRequired: false, channels: ['visual', 'haptic'] },
    allChannels: { stepFreeRequired: false, channels: [] },
    none: null,
  }
  for (const [label, p] of Object.entries(PROFILES)) {
    it(`tier-1 door asks the question for ${label}`, () => {
      expect(arrivalPrompt({ tier: 1 }, p, true).mode).not.toBeNull()
    })
    it(`tiers 0, 2 and 3 never offer the guide button for ${label}`, () => {
      for (const tier of [0, 2, 3] as const) expect(arrivalPrompt({ tier }, p, true).mode).toBeNull()
    })
  }
  it('Ja opens the profile\'s own screen: check for step-free, guide otherwise', () => {
    expect(arrivalPrompt({ tier: 1 }, PROFILES.wheelchair, true).mode).toBe('check')
    expect(arrivalPrompt({ tier: 1 }, PROFILES.blind, true).mode).toBe('guide')
    expect(arrivalPrompt({ tier: 1 }, PROFILES.deafOnly, true).mode).toBe('guide')
  })
  it('no approach screen wired: no button', () => {
    expect(arrivalPrompt({ tier: 1 }, PROFILES.blind, false).mode).toBeNull()
  })
  it('never coerces stepFree null: the door is read, not changed', () => {
    const door = Object.freeze({ tier: 1, stepFree: null }) as unknown as Pick<Entrance, 'tier'> & { stepFree: null }
    arrivalPrompt(door, PROFILES.wheelchair, true)
    expect(door.stepFree).toBeNull()
  })
  it('the sheet asks the question, drops the countdown, and says it once', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/LiveView.ts'), 'utf8')
    expect(src).toMatch(/promptMode = arrivalPrompt\(e, opts\.profile, !!opts\.onApproach\)\.mode/)
    expect(src).toMatch(/if \(!spokeSheet && voiceOn\(\)\) speak\(/)
    expect(src).toMatch(/role: 'dialog', 'aria-modal': 'true'/)
  })
})

describe('demoWalkTrack: the ?demo=1 walk is short', () => {
  const door = { lat: 52.5251, lon: 13.3694, approachBearing: 120 }
  it('starts outside the arrival radius and reaches the door within 8 s', () => {
    const track = demoWalkTrack(door)
    expect(haversineM(track[0], door)).toBeGreaterThan(ARRIVE_M)
    const firstIn = [...Array(100).keys()].map((i) => i / 10).find((s) => haversineM(sampleTrack(track, s), door) <= ARRIVE_M)
    expect(firstIn).toBeDefined()
    expect(firstIn!).toBeLessThan(8)
  })
  it('walks toward the door along its approach bearing', () => {
    const track = demoWalkTrack(door)
    expect(track.every((p) => p.heading === 120)).toBe(true)
    expect(haversineM(track.at(-1)!, door)).toBeLessThan(0.1)
  })
  it('works for a door without an approach bearing', () => {
    expect(haversineM(demoWalkTrack({ ...door, approachBearing: null })[0], door)).toBeGreaterThan(ARRIVE_M)
  })
})
