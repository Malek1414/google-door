import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  approachClipBank, bandText, clipKeyFor, fallbackLine, metresLine, noDirectionLine,
  safetyLine, thresholdLine, throughLine, unsureLine,
} from '../src/core/instruct'
import { ClipPlayer, missingClipKeys, splitInstruction, type ClipDeps } from '../src/ui/clips'

describe('splitInstruction: every line gets its clip key', () => {
  for (const lang of ['de', 'en']) {
    it(`${lang}: each fixed line maps to clipKeyFor`, () => {
      const cases: [string, Parameters<typeof clipKeyFor>[0]][] = [
        [safetyLine(lang), { kind: 'safety' }],
        [thresholdLine(lang), { kind: 'threshold' }],
        [throughLine(lang), { kind: 'through' }],
        [noDirectionLine(lang), { kind: 'noDirection' }],
        [fallbackLine(lang), { kind: 'fallback' }],
        [unsureLine(lang), { kind: 'unsure' }],
        [bandText('slight-left', lang), { kind: 'band', band: 'slight-left' }],
        [bandText('left', lang), { kind: 'band', band: 'left' }],
      ]
      for (const [text, line] of cases) expect(splitInstruction(text, lang)).toEqual([{ text, key: clipKeyFor(line) }])
    })
    it(`${lang}: metres 1..10 map to m_n, "1" never matches inside "10"`, () => {
      for (let m = 1; m <= 10; m++) expect(splitInstruction(metresLine(m, lang), lang)).toEqual([{ text: metresLine(m, lang), key: `m_${m}` }])
    })
  }
  it('a joined engine instruction splits in order', () => {
    const joined = [fallbackLine('de'), bandText('left', 'de'), metresLine(5, 'de')].join(' ')
    expect(splitInstruction(joined, 'de')).toEqual([
      { text: fallbackLine('de'), key: 'approach_fallback' },
      { text: bandText('left', 'de'), key: 'turn_left' },
      { text: metresLine(5, 'de'), key: 'm_5' },
    ])
  })
  it('threshold plus surveyed door type splits into two clips', () => {
    const joined = `${thresholdLine('de')} Automatische Schiebetür.`
    expect(splitInstruction(joined, 'de')).toEqual([
      { text: thresholdLine('de'), key: 'approach_threshold' },
      { text: 'Automatische Schiebetür.', key: 'door_sliding_auto' },
    ])
  })
  it('longest band wins ("Leicht links" is not "Links")', () => {
    expect(splitInstruction(bandText('slight-left', 'de'), 'de')[0].key).toBe('band_slight_left')
  })
  it('unknown text keeps its place with key null (spoken live)', () => {
    expect(splitInstruction(`${metresLine(42, 'de')} ${unsureLine('de')}`, 'de')).toEqual([
      { text: metresLine(42, 'de'), key: null },
      { text: unsureLine('de'), key: 'approach_unsure' },
    ])
  })
  it('bank keys agree with clipKeyFor', () => {
    const keys = approachClipBank('de').map((b) => b.key)
    expect(keys).toContain(clipKeyFor({ kind: 'noDirection' }))
    expect(keys).toContain(clipKeyFor({ kind: 'metres', m: 10 }))
  })
})

function fakeDeps(have: string[]) {
  const log: string[] = []
  const pending: (() => void)[] = []
  const wait = () => new Promise<void>((r) => pending.push(r))
  const deps: ClipDeps = {
    async playClip(key) {
      if (!have.includes(key)) return false
      log.push(`clip:${key}`)
      await wait()
      return true
    },
    async speakLive(text) {
      log.push(`live:${text}`)
      await wait()
    },
    stop() {
      log.push('stop')
    },
  }
  const finish = async () => {
    await Promise.resolve()
    pending.shift()?.()
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return { deps, log, finish }
}

describe('ClipPlayer', () => {
  it('plays the clip when it exists, falls back to live when missing', async () => {
    const { deps, log, finish } = fakeDeps(['m_5'])
    const p = new ClipPlayer(deps)
    p.playLine('5 Meter', 'm_5')
    await finish()
    p.playLine('Die Tür ist direkt vor dir.', 'approach_threshold')
    await finish()
    p.playLine('42 Meter', null)
    await finish()
    expect(log).toEqual(['clip:m_5', 'live:Die Tür ist direkt vor dir.', 'live:42 Meter'])
  })
  it('queues: the next line starts only after the previous one ends', async () => {
    const { deps, log, finish } = fakeDeps(['turn_left', 'm_5'])
    const p = new ClipPlayer(deps)
    p.playInstruction('Links 5 Meter', 'de')
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toEqual(['clip:turn_left'])
    await finish()
    expect(log).toEqual(['clip:turn_left', 'clip:m_5'])
  })
  it('the safety line interrupts: queue dropped, current cut off', async () => {
    const { deps, log, finish } = fakeDeps(['turn_left', 'm_5'])
    const p = new ClipPlayer(deps)
    p.playInstruction('Links 5 Meter', 'de')
    await Promise.resolve()
    p.playLine(safetyLine('de'), 'approach_safety', { interrupt: true })
    for (let i = 0; i < 4; i++) await finish()
    expect(log).toEqual(['clip:turn_left', 'stop', `live:${safetyLine('de')}`])
  })
  it('never throws when the clip path fails', async () => {
    const deps: ClipDeps = {
      playClip: () => Promise.reject(new Error('decode')),
      speakLive: () => Promise.reject(new Error('429')),
      stop: () => {
        throw new Error('x')
      },
    }
    const p = new ClipPlayer(deps)
    await expect(p.playLine('Links', 'turn_left', { interrupt: true })).resolves.toBeUndefined()
  })
})

describe('ClipPlayer: latest wins (approach speech ordering)', () => {
  it('a line emitted after a newer one is dropped', async () => {
    const { deps, log, finish } = fakeDeps([])
    const p = new ClipPlayer(deps)
    p.playLine('Rechts', null, { seq: 2 })
    p.playLine('Links', null, { seq: 1 }) // arrived late: older than what is playing
    for (let i = 0; i < 3; i++) await finish()
    expect(log).toEqual(['live:Rechts'])
  })
  it('a newer line replaces the parts still waiting; the sounding part finishes', async () => {
    const { deps, log, finish } = fakeDeps(['turn_left', 'm_5'])
    const p = new ClipPlayer(deps)
    p.playInstruction('Links 5 Meter', 'de')
    await Promise.resolve()
    p.playLine('Geradeaus', null)
    for (let i = 0; i < 3; i++) await finish()
    expect(log).toEqual(['clip:turn_left', 'live:Geradeaus'])
  })
  it('interrupt stops clip playback, including a clip that is still loading', async () => {
    const log: string[] = []
    let loaded: () => void = () => {}
    const deps: ClipDeps = {
      async playClip(key, live) {
        await new Promise<void>((r) => (loaded = r)) // fetch + decode
        if (!live()) return true
        log.push(`start:${key}`)
        return true
      },
      async speakLive(text) {
        log.push(`live:${text}`)
      },
      stop() {
        log.push('stop')
      },
    }
    const p = new ClipPlayer(deps)
    p.playLine('Links', 'turn_left')
    await Promise.resolve()
    p.playLine(safetyLine('de'), null, { interrupt: true })
    loaded()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(log).toEqual(['stop', `live:${safetyLine('de')}`])
  })
  it('a known-missing clip is spoken on the device synchronously (iOS unlock inside the tap)', () => {
    const log: string[] = []
    const deps: ClipDeps = {
      hasClip: () => false,
      playClip: async () => {
        log.push('clip')
        return false
      },
      speakLive: async (text) => void log.push(`live:${text}`),
      stop: () => {},
    }
    new ClipPlayer(deps).playInstruction(safetyLine('de'), 'de', { interrupt: true })
    expect(log).toEqual([`live:${safetyLine('de')}`])
  })
  it('the approach path never calls /api/speak', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/clips.ts'), 'utf8')
    expect(src).not.toMatch(/fetch\([^)]*api\/speak/)
    expect(src).not.toMatch(/import \{[^}]*\bspeak\b[^}]*\} from '\.\.\/session'/)
  })
})

describe('missingClipKeys', () => {
  it('lists bank keys without a file; reused Live View clips count as present', () => {
    const missing = missingClipKeys('de', { clips: { straight: { file: '', text: '' }, turn_left: { file: '', text: '' }, turn_right: { file: '', text: '' } } })
    expect(missing).toContain('approach_safety')
    expect(missing).toContain('m_10')
    expect(missing).not.toContain('turn_left')
  })
})

describe('door check voice (wheelchair): device voice at once, never /api/speak', () => {
  it('the aim prompt goes to speechSynthesis synchronously, with no fetch', async () => {
    const { vi } = await import('vitest')
    const g = globalThis as Record<string, unknown>
    const saved = { window: g.window, speechSynthesis: g.speechSynthesis, SpeechSynthesisUtterance: g.SpeechSynthesisUtterance, fetch: g.fetch }
    const spoken: string[] = []
    const synth = { speaking: false, pending: false, speak: vi.fn((u: { text: string }) => spoken.push(u.text)), cancel: vi.fn() }
    const fetchSpy = vi.fn(() => new Promise(() => {}))
    g.speechSynthesis = synth
    g.window = { setTimeout: () => 0 }
    g.SpeechSynthesisUtterance = class { lang = ''; rate = 1; onend: unknown; onerror: unknown; constructor(public text: string) {} }
    g.fetch = fetchSpy
    try {
      const { playLine, stopLines } = await import('../src/ui/clips')
      playLine('Richte das Handy auf die Tür.', null, { lang: 'de' })
      expect(spoken).toEqual(['Richte das Handy auf die Tür.'])
      expect(synth.cancel).not.toHaveBeenCalled() // first prompt: nothing to cut, primer survives
      expect(fetchSpy).not.toHaveBeenCalled()
      stopLines('de')
    } finally {
      Object.assign(g, saved)
    }
  })
  it('DoorCheckScreen speaks through the clip player and stops it on exit', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/Approach.ts'), 'utf8')
    const check = src.slice(src.indexOf('function DoorCheckScreen'))
    expect(check).toMatch(/playLine\(text, null, \{ interrupt, lang \}\)/)
    expect(check).not.toMatch(/\bspeak\(/)
    expect(check).toMatch(/function teardown\(\) \{[\s\S]*?stopLines\(lang\)/)
  })
})

describe('playClip on a suspended AudioContext (iOS after a call or Siri)', () => {
  it('falls back to the device voice and resumes the context instead of starting a silent clip', async () => {
    const { vi } = await import('vitest')
    const { bandClipKey } = await import('../src/core/instruct')
    const { session } = await import('../src/session')
    const g = globalThis as Record<string, unknown>
    const saved = { window: g.window, speechSynthesis: g.speechSynthesis, SpeechSynthesisUtterance: g.SpeechSynthesisUtterance, fetch: g.fetch }
    const savedAudio = session.audio
    const spoken: string[] = []
    const started = vi.fn()
    const synth = { speaking: false, pending: false, speak: vi.fn((u: { text: string }) => spoken.push(u.text)), cancel: vi.fn() }
    const key = bandClipKey('left')
    const text = bandText('left', 'de')
    g.speechSynthesis = synth
    g.window = { setTimeout: () => 0 }
    g.SpeechSynthesisUtterance = class { lang = ''; rate = 1; onend: unknown; onerror: unknown; constructor(public text: string) {} }
    g.fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ clips: { [key]: { file: 'audio/de/left.wav', text } } }),
      arrayBuffer: async () => new ArrayBuffer(8),
      url,
    }))
    const ctx = {
      state: 'suspended',
      resume: vi.fn(() => Promise.resolve()),
      destination: {},
      decodeAudioData: async () => ({ duration: 0.05 }),
      createBufferSource: () => ({ connect() {}, stop() {}, start: started, onended: null as null | (() => void), buffer: null }),
    }
    session.audio = ctx as unknown as AudioContext
    try {
      const { playLine, stopLines } = await import('../src/ui/clips')
      playLine(text, key, { lang: 'de-AT' })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(started).not.toHaveBeenCalled()
      expect(spoken).toEqual([text])
      expect(ctx.resume).toHaveBeenCalled()
      stopLines('de-AT')
    } finally {
      session.audio = savedAudio
      Object.assign(g, saved)
    }
  })
})
