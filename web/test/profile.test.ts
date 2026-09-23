import { describe, expect, it } from 'vitest'
import { outputFor, parseProfile } from '../src/core/profile'

describe('outputFor (spec personas)', () => {
  it('Erden, partially blind: large visuals + speech', () => {
    const o = outputFor({ stepFreeRequired: false, channels: ['visual', 'speech'] })
    expect(o).toMatchObject({ speak: true, beacon: true, haptics: false, dimScreen: false, contrast: 'yellow-black' })
    expect(o.arrowScale).toBeGreaterThan(1)
  })
  it('blind: speech + haptic, screen can dim', () => {
    const o = outputFor({ stepFreeRequired: false, channels: ['speech', 'haptic'] })
    expect(o).toMatchObject({ speak: true, beacon: true, haptics: true, dimScreen: true })
  })
  it('deaf: visual + haptic, no audio', () => {
    const o = outputFor({ stepFreeRequired: false, channels: ['visual', 'haptic'] })
    expect(o).toMatchObject({ speak: false, beacon: false, haptics: true, dimScreen: false })
  })
  it('wheelchair: visual only', () => {
    const o = outputFor({ stepFreeRequired: true, channels: ['visual'] })
    expect(o).toMatchObject({ speak: false, beacon: false, haptics: false, dimScreen: false })
  })
  it('no channel selected never silences everything', () => {
    const o = outputFor({ stepFreeRequired: false, channels: [] })
    expect(o.speak && o.haptics && !o.dimScreen).toBe(true)
  })
})

describe('parseProfile', () => {
  it('round-trips', () => {
    const p = { stepFreeRequired: true, channels: ['speech' as const] }
    expect(parseProfile(JSON.stringify(p))).toEqual(p)
  })
  it('rejects garbage and drops unknown channels', () => {
    expect(parseProfile(null)).toBeNull()
    expect(parseProfile('{')).toBeNull()
    expect(parseProfile('{"channels":[]}')).toBeNull()
    expect(parseProfile('{"stepFreeRequired":false,"channels":["smell","speech","speech"]}')).toEqual({
      stepFreeRequired: false,
      channels: ['speech'],
    })
  })
})
