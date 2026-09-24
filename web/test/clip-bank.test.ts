import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { approachClipBank } from '../src/core/instruct'

// pipeline/synth_speech.py synthesises exactly what this file lists. If a line in
// core/instruct.ts changes, regenerate it: cd web && npx vite-node scripts/clip-bank.ts
describe('pipeline/approach_bank.json', () => {
  const bank = JSON.parse(readFileSync(new URL('../../pipeline/approach_bank.json', import.meta.url), 'utf8'))
  for (const lang of ['de', 'en']) {
    it(`matches approachClipBank('${lang}') key for key`, () => {
      expect(bank[lang]).toEqual(Object.fromEntries(approachClipBank(lang).map((c) => [c.key, c.text])))
    })
  }
})
