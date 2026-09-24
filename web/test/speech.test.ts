import { describe, expect, it } from 'vitest'
import { distanceKey } from '../src/core/speech'

describe('speech clip selection', () => {
  it('snaps a distance to the nearest clip on the ladder', () => {
    expect(distanceKey(5)).toBe('dist_5')
    expect(distanceKey(31)).toBe('dist_30')
    expect(distanceKey(48)).toBe('dist_50')
    expect(distanceKey(97)).toBe('dist_100')
  })
  it('refuses to round a distance it would misstate', () => {
    expect(distanceKey(250)).toBeNull()   // nothing near 250 on the ladder
    expect(distanceKey(NaN)).toBeNull()
  })
  it('never claims a distance more than 12 m from the truth', () => {
    for (let m = 1; m <= 200; m++) {
      const k = distanceKey(m)
      if (k) expect(Math.abs(Number(k.slice(5)) - m)).toBeLessThanOrEqual(12)
    }
  })
})

describe('stopSpeech voids a pending /api/speak fallback (arrival card vs. approach)', () => {
  it('say() with a hanging fetch, then stopSpeech(): the device voice never speaks the stale line', async () => {
    const { vi } = await import('vitest')
    const { say, stopSpeech, API_SPEAK_TIMEOUT_MS } = await import('../src/core/speech')
    vi.useFakeTimers()
    const spoken: string[] = []
    const g = globalThis as Record<string, unknown>
    const saved = { window: g.window, document: g.document, speechSynthesis: g.speechSynthesis, SpeechSynthesisUtterance: g.SpeechSynthesisUtterance, fetch: g.fetch }
    const synth = { speak: vi.fn((u: { text: string }) => spoken.push(u.text)), cancel: vi.fn() }
    g.speechSynthesis = synth
    g.window = { speechSynthesis: synth }
    g.document = { documentElement: { lang: 'de' } }
    g.SpeechSynthesisUtterance = class { lang = ''; rate = 1; constructor(public text: string) {} }
    // Hangs until aborted, like /api/speak retrying a 429.
    g.fetch = vi.fn((_u: string, init: { signal?: AbortSignal }) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted')))))
    try {
      const p = say(null, 'Du bist angekommen. Ein langer Absatz.')
      stopSpeech()
      await vi.advanceTimersByTimeAsync(API_SPEAK_TIMEOUT_MS + 500)
      await p
      expect(synth.speak).not.toHaveBeenCalled()
      expect(spoken).toEqual([])
    } finally {
      vi.useRealTimers()
      Object.assign(g, saved)
    }
  })
})

describe('a failed /api/speak sends the next lines straight to the device voice (TTS quota out)', () => {
  it('after one 429, the next say() does not call /api/speak and speaks at once', async () => {
    const { vi } = await import('vitest')
    const { say, resetSpeakBackoff, API_SPEAK_BACKOFF_MS } = await import('../src/core/speech')
    vi.useFakeTimers()
    const spoken: string[] = []
    const g = globalThis as Record<string, unknown>
    const saved = { window: g.window, document: g.document, speechSynthesis: g.speechSynthesis, SpeechSynthesisUtterance: g.SpeechSynthesisUtterance, fetch: g.fetch }
    const synth = { speak: vi.fn((u: { text: string }) => spoken.push(u.text)), cancel: vi.fn() }
    g.speechSynthesis = synth
    g.window = { speechSynthesis: synth }
    g.document = { documentElement: { lang: 'de' } }
    g.SpeechSynthesisUtterance = class { lang = ''; rate = 1; constructor(public text: string) {} }
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429 }))
    g.fetch = fetchMock
    resetSpeakBackoff()
    try {
      expect(await say(null, 'Führung zu Nebeneingang.')).toBe('synth')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(await say(null, 'Angekommen.')).toBe('synth') // resolves without any timer running
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(spoken).toEqual(['Führung zu Nebeneingang.', 'Angekommen.'])
      // After the back-off the server is tried again.
      vi.setSystemTime(Date.now() + API_SPEAK_BACKOFF_MS + 1)
      await say(null, 'Links abbiegen.')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      resetSpeakBackoff()
      vi.useRealTimers()
      Object.assign(g, saved)
    }
  })
})
