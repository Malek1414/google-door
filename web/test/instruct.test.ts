import { describe, expect, it } from 'vitest'
import { bandFor, bandText, bandClipKey, shouldSpeakDistance, ON_BEARING_DEG } from '../src/core/instruct'

describe('bands', () => {
  it('maps each range to its band', () => {
    expect(bandFor(0)).toBe('straight')
    expect(bandFor(-8)).toBe('straight')
    expect(bandFor(-15)).toBe('slight-left')
    expect(bandFor(15)).toBe('slight-right')
    expect(bandFor(-50)).toBe('left')
    expect(bandFor(50)).toBe('right')
    expect(bandFor(-100)).toBe('sharp-left')
    expect(bandFor(100)).toBe('sharp-right')
    expect(bandFor(170)).toBe('turn-around')
    expect(bandFor(-170)).toBe('turn-around')
  })

  it('is exact at the boundaries, so the wording does not flicker there', () => {
    expect(bandFor(ON_BEARING_DEG)).toBe('straight')
    expect(bandFor(ON_BEARING_DEG + 0.1)).toBe('slight-right')
    expect(bandFor(25)).toBe('slight-right')
    expect(bandFor(25.1)).toBe('right')
    expect(bandFor(70)).toBe('right')
    expect(bandFor(70.1)).toBe('sharp-right')
    expect(bandFor(135)).toBe('sharp-right')
    expect(bandFor(135.1)).toBe('turn-around')
  })

  it('treats NaN as straight rather than emitting a turn', () => {
    expect(bandFor(NaN)).toBe('straight')
  })

  it('has one fixed phrase per band in both languages', () => {
    const bands = ['straight','slight-left','slight-right','left','right','sharp-left','sharp-right','turn-around'] as const
    for (const b of bands) {
      expect(bandText(b, 'de')).toBeTruthy()
      expect(bandText(b, 'en')).toBeTruthy()
      expect(bandClipKey(b)).toMatch(/^[a-z_]+$/)
    }
    expect(new Set(bands.map((b) => bandText(b, 'de'))).size).toBe(bands.length)
    // every band resolves to a distinct clip
    expect(new Set(bands.map(bandClipKey)).size).toBe(bands.length)
  })

  it('reuses the Live View clips where the German is identical', () => {
    // TTS is capped at 100 requests a day; these three need no generating at all.
    expect(bandClipKey('straight')).toBe('straight')
    expect(bandClipKey('left')).toBe('turn_left')
    expect(bandClipKey('right')).toBe('turn_right')
    expect(bandClipKey('slight-left')).toBe('band_slight_left')
    expect(bandClipKey('turn-around')).toBe('band_turn_around')
  })
})

describe('distance announcements', () => {
  // The argument is the LOWEST step already announced, not the previous distance.
  it('announces each step once as it is crossed', () => {
    expect(shouldSpeakDistance(null, 9.5)).toBe(10)
    expect(shouldSpeakDistance(10, 7.8)).toBe(8)
    expect(shouldSpeakDistance(8, 4.9)).toBe(5)
    expect(shouldSpeakDistance(5, 2.5)).toBe(3)
  })
  it('stays quiet while walking within a step', () => {
    expect(shouldSpeakDistance(10, 9.1)).toBeNull()
    expect(shouldSpeakDistance(5, 3.9)).toBeNull()
  })
  it('does not chatter when drifting back and forth over a boundary', () => {
    expect(shouldSpeakDistance(10, 7.8)).toBe(8)   // crossed 8, announced
    expect(shouldSpeakDistance(8, 8.4)).toBeNull() // drifted back out
    expect(shouldSpeakDistance(8, 7.9)).toBeNull() // back under 8 — already said
  })
  it('announces the first reading', () => {
    expect(shouldSpeakDistance(null, 9)).toBe(10)
  })
  it('skips steps when the user moves fast', () => {
    expect(shouldSpeakDistance(10, 2.4)).toBe(3)
  })
  it('ignores NaN', () => {
    expect(shouldSpeakDistance(5, NaN)).toBeNull()
  })
})
