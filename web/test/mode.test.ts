import { describe, expect, it } from 'vitest'
import { chipsFor, loadMode, MODE_KEY, modeForProfile, parseMode, saveMode, showDoorMarkers } from '../src/core/mode'
import { PROFILE_KEY } from '../src/core/profile'

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

describe('mode', () => {
  it('parseMode accepts only known values', () => {
    expect(parseMode('access')).toBe('access')
    expect(parseMode('standard')).toBe('standard')
    expect(parseMode('x')).toBeNull()
    expect(parseMode(null)).toBeNull()
  })
  it('defaults to standard without profile or storage', () => {
    expect(loadMode(mem())).toBe('standard')
    expect(loadMode(null)).toBe('standard')
  })
  it('defaults to access for a step-free profile', () => {
    expect(loadMode(mem({ [PROFILE_KEY]: JSON.stringify({ stepFreeRequired: true, channels: [] }) }))).toBe('access')
  })
  it('default channels stay standard, other channels switch to access', () => {
    expect(modeForProfile({ stepFreeRequired: false, channels: ['visual', 'speech'] })).toBe('standard')
    expect(modeForProfile({ stepFreeRequired: false, channels: [] })).toBe('standard')
    expect(modeForProfile({ stepFreeRequired: false, channels: ['speech', 'haptic'] })).toBe('access')
    expect(modeForProfile({ stepFreeRequired: false, channels: ['visual'] })).toBe('access')
  })
  it('a saved mode wins over the profile', () => {
    const s = mem({ [PROFILE_KEY]: JSON.stringify({ stepFreeRequired: true, channels: [] }) })
    saveMode('standard', s)
    expect(s.m.get(MODE_KEY)).toBe('standard')
    expect(loadMode(s)).toBe('standard')
  })
  it('ignores garbage and throwing storage', () => {
    expect(loadMode(mem({ [MODE_KEY]: 'nope', [PROFILE_KEY]: '{bad' }))).toBe('standard')
    const boom = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') } }
    expect(loadMode(boom)).toBe('standard')
    expect(() => saveMode('access', boom)).not.toThrow()
  })
  it('chips and door markers follow the mode', () => {
    expect(chipsFor('access')).toEqual(['stepFree', 'withSteps', 'automatic', 'noRevolving'])
    expect(chipsFor('standard')).toContain('restaurants')
    expect(chipsFor('standard')).not.toContain('stepFree')
    expect(showDoorMarkers('access')).toBe(true)
    expect(showDoorMarkers('standard')).toBe(false)
  })
})
