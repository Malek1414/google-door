// Writes pipeline/approach_bank.json: every approach clip the app will look up, keyed
// exactly as core/instruct.ts names it. pipeline/synth_speech.py reads it, so the
// synthesised files and the app can never drift apart again.
//   cd web && npx vite-node scripts/clip-bank.ts
import { writeFileSync } from 'node:fs'
import { approachClipBank } from '../src/core/instruct'

const out: Record<string, Record<string, string>> = {}
for (const lang of ['de', 'en']) {
  out[lang] = {}
  for (const { key, text } of approachClipBank(lang)) out[lang][key] = text
}
writeFileSync(new URL('../../pipeline/approach_bank.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log(`${Object.keys(out.de).length} de + ${Object.keys(out.en).length} en clips -> pipeline/approach_bank.json`)
