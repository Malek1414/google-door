import { describe, expect, it } from 'vitest'
import { liveViewMode } from '../src/core/nav'
import { arrivalPrompt, placeEntrance } from '../src/ui/LiveView'
import { guidanceFor } from '../src/core/target'
import type { Entrance } from '../src/core/types'

const door = (over: Partial<Entrance>): Entrance => ({
  ...placeEntrance({ lat: 52.5, lon: 13.4, name: 'x' }),
  id: 'd1', tier: 1, stepFree: true, source: 'osm', ...over,
})
const blind = { stepFreeRequired: false, channels: ['speech' as const] }
const wheel = { stepFreeRequired: true, channels: ['visual' as const] }

describe('liveViewMode', () => {
  it('a guidable door gets the door Live View', () => {
    expect(liveViewMode(door({}), blind)).toBe('door')
  })
  it('a place, a tier-0 door, or a door the profile cannot use gets the place Live View', () => {
    expect(liveViewMode(null, blind)).toBe('place')
    expect(liveViewMode(door({ tier: 0 }), blind)).toBe('place')
    expect(liveViewMode(door({ stepFree: false }), wheel)).toBe('place')
  })
})

describe('place Live View', () => {
  const p = placeEntrance({ lat: 52.5, lon: 13.4, name: "McDonald's" })
  it('arrival never asks the door question (no Ja button), whatever the profile', () => {
    expect(arrivalPrompt(p, blind, true).mode).toBeNull()
    expect(arrivalPrompt(p, wheel, true).mode).toBeNull()
  })
  it('carries no warnings and can never mint an arrow target', () => {
    expect(p.warnings).toEqual([])
    expect(guidanceFor(p, blind).kind).toBe('text')
  })
})
