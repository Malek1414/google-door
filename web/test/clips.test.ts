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
    p.playLine('Die Tür ist direkt vor dir.', 'approach_threshold')
    p.playLine('42 Meter', null)
    for (let i = 0; i < 4; i++) await finish()
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

describe('missingClipKeys', () => {
  it('lists bank keys without a file; reused Live View clips count as present', () => {
    const missing = missingClipKeys('de', { clips: { straight: { file: '', text: '' }, turn_left: { file: '', text: '' }, turn_right: { file: '', text: '' } } })
    expect(missing).toContain('approach_safety')
    expect(missing).toContain('m_10')
    expect(missing).not.toContain('turn_left')
  })
})
