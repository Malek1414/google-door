// e2e for "Barrierefreiheit bearbeiten". Usage: node e2e/business-access.mjs [baseUrl]
// Creates a business, links one entrance, opens the questionnaire, checks the German range
// error next to a field, answers a few questions, saves, and checks that the progress line,
// the stored entrance and the user's door card reflect the answers. Muted Chrome.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const SCRATCH = '/private/tmp/claude-501/-Users-samimagdouli/1d160c72-db6d-4c81-8bfc-ebf86efa9368/scratchpad'
const req = createRequire(import.meta.url)
async function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_CORE, 'playwright-core', `${SCRATCH}/shot/node_modules/playwright-core`].filter(Boolean)) {
    try { return await import(pathToFileURL(req.resolve(c)).href) } catch { /* next */ }
  }
  throw new Error('playwright-core not found. Set PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core')
}
const pw = await loadPlaywright()
const chromium = pw.chromium ?? pw.default?.chromium
const BASE = (process.argv[2] || 'https://localhost:5173/').replace(/\/?$/, '/')
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch({ executablePath: CHROME, args: ['--mute-audio', '--ignore-certificate-errors'] })
const ctx = await browser.newContext({
  locale: 'de-DE', viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
  geolocation: { latitude: 52.5249, longitude: 13.3688, accuracy: 8 }, permissions: ['geolocation'],
})
await ctx.route(/\/api\/(speak|look|door-fix|door-check)/, (r) => r.fulfill({ status: 503, body: '' }))
const p = await ctx.newPage()
const pageErrors = []
p.on('pageerror', (e) => pageErrors.push(String(e)))

let failed = 0
async function step(name, fn) {
  try {
    const note = await fn()
    console.log(`PASS ${name}${note ? `  (${note})` : ''}`)
  } catch (e) {
    failed += 1
    console.log(`FAIL ${name}  (${String(e?.message || e).split('\n')[0].slice(0, 200)})`)
    await p.screenshot({ path: join(OUT, `business-access-${name}.png`) }).catch(() => {})
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg) }
async function tap(locator) {
  await locator.first().waitFor({ state: 'visible', timeout: 10000 })
  await locator.first().tap({ timeout: 4000 }).catch(() => locator.first().evaluate((x) => x.click()))
  await p.waitForTimeout(400)
}
const chip = (question, answer) => p.locator('fieldset.ax-q', { has: p.locator('legend', { hasText: question }) }).locator('label.ax-chip', { hasText: answer })

await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
await p.waitForTimeout(4000)

await step('create-business', async () => {
  await tap(p.locator('.gm-tab', { hasText: 'Unternehmen' }))
  await p.locator('form.bz input').first().fill('Café Test')
  await tap(p.locator('button', { hasText: 'Kartenmitte' }))
  await tap(p.locator('form.bz button[type=submit]'))
  await p.locator('.bzh-access').waitFor({ state: 'visible', timeout: 10000 })
})

// One owner entrance at a real door position, as the entrance editor would save it.
await step('link-entrance', async () => {
  await p.evaluate(() => {
    const b = JSON.parse(localStorage.getItem('doorway.business'))
    const e = {
      id: 'survey/e2e-door', buildingId: null, lat: 52.52495, lon: 13.36885, name: 'Haupteingang', kind: 'main', level: null,
      stepFree: null, tier: 0, confidence: 'surveyed', door: null, automatic: false, approachBearing: null, description: null,
      warnings: [], source: 'survey', createdAt: new Date().toISOString(), by: 'business', businessId: b.id,
    }
    localStorage.setItem('doorway.survey', JSON.stringify([e]))
    b.entranceIds = [e.id]
    localStorage.setItem('doorway.business', JSON.stringify(b))
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(3500)
  await tap(p.locator('.gm-tab', { hasText: 'Unternehmen' }))
  const line = await p.locator('.bzh-access-line').textContent({ timeout: 10000 })
  expect(/^0 von \d+ Angaben$/.test(line), `progress line "${line}"`)
  return line
})

await step('open-page', async () => {
  await tap(p.locator('.bzh-access'))
  await p.locator('#sheet-title', { hasText: 'Barrierefreiheit' }).waitFor({ timeout: 5000 })
  expect(await p.evaluate(() => document.activeElement?.id) === 'sheet-title', 'focus not on the heading')
  expect(await p.locator('.ax-for', { hasText: 'Haupteingang' }).count() === 1, 'entrance name missing')
  // Every radio group is a fieldset with a legend; every text field has a label.
  const unlabelled = await p.evaluate(() => [...document.querySelectorAll('.ax input:not([type=radio]), .ax textarea')].filter((i) => !i.labels?.length).length)
  expect(unlabelled === 0, `${unlabelled} fields without a label`)
  const small = await p.evaluate(() => [...document.querySelectorAll('.ax button, .ax .ax-chip-face')].filter((x) => { const r = x.getBoundingClientRect(); return r.height && r.height < 48 }).length)
  expect(small === 0, `${small} targets under 48 px`)
  await p.screenshot({ path: join(OUT, 'business-access-open.png') })
})

await step('range-error', async () => {
  await tap(chip('Kommt man ohne Stufen hinein?', 'Ja'))
  await tap(p.locator('.ax-sec-btn', { hasText: 'Tür' }))
  const width = p.getByLabel('Türbreite in Zentimeter')
  await width.fill('5')
  await tap(p.locator('.ax-btn-primary'))
  const err = p.locator(`#${await width.getAttribute('id')}-err`)
  const text = await err.textContent()
  expect(/zwischen 40 und 400 cm/.test(text), `error text "${text}"`)
  expect((await width.getAttribute('aria-invalid')) === 'true', 'aria-invalid missing')
  expect((await width.getAttribute('aria-describedby')).includes(await err.getAttribute('id')), 'error not tied to the field')
  expect(await p.evaluate(() => document.activeElement?.getAttribute('aria-invalid')) === 'true', 'focus not on the invalid field')
})

await step('answer-and-save', async () => {
  await p.getByLabel('Türbreite in Zentimeter').fill('90')
  await tap(chip('Öffnet die Tür automatisch?', 'Ja'))
  await tap(chip('Ist es eine Drehtür?', 'Nein'))
  await tap(chip('Gibt es eine Klingel oder Sprechanlage?', 'Weiß nicht'))
  await tap(p.locator('.ax-btn-primary'))
  await p.locator('.ax-btn-primary', { hasText: 'Gespeichert' }).waitFor({ timeout: 5000 })
  const st = await p.locator('.ax-status').textContent()
  expect(/Gespeichert um/.test(st), `status "${st}"`)
  const prog = await p.locator('.ax-prog-text').textContent()
  expect(/^4 von \d+ Angaben$/.test(prog), `progress "${prog}"`)
  await p.screenshot({ path: join(OUT, 'business-access-saved.png') })
  return prog
})

await step('stored-entrance', async () => {
  const e = await p.evaluate(() => JSON.parse(localStorage.getItem('doorway.survey')).find((x) => x.id === 'survey/e2e-door'))
  expect(e.stepFree === true, `stepFree ${e.stepFree}`)
  expect(e.tier === 1, `tier ${e.tier}`)
  expect(e.automatic === true && e.widthCm === 90 && e.bell === false, 'door fields not mapped')
  expect(e.by === 'business' && e.source === 'survey', 'source not owner')
  const a = await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('doorway.accessAnswers')))[0]['survey/e2e-door'])
  expect(a.bell === null, `"Weiß nicht" stored as ${a.bell}`)
})

await step('home-progress', async () => {
  await tap(p.locator('.ax-back'))
  const line = await p.locator('.bzh-access-line').textContent({ timeout: 5000 })
  expect(/^4 von \d+ Angaben$/.test(line), `home line "${line}"`)
  return line
})

await step('door-card', async () => {
  await tap(p.locator('.bzh-action-btn', { hasText: 'Vorschau' }))
  await p.waitForTimeout(1500)
  const sheet = await p.locator('.gm-sheet').innerText()
  expect(sheet.includes('Türbreite 90 cm'), 'answers not on the door card')
  expect(sheet.includes('Angaben vom Unternehmen selbst'), 'owner source missing')
  await p.screenshot({ path: join(OUT, 'business-access-door.png') })
})

await step('no-page-errors', async () => expect(pageErrors.length === 0, pageErrors.join(' | ')))

await browser.close()
console.log(failed ? `${failed} step(s) failed` : 'all passed')
process.exit(failed)
