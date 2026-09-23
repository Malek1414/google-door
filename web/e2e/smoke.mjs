// Smoke test for Google Doorway. Usage: node e2e/smoke.mjs [baseUrl]
// playwright-core is resolved via PLAYWRIGHT_CORE (path to the package) or normal module resolution.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const DEFAULT_PW = '/private/tmp/claude-501/-Users-samimagdouli/1d160c72-db6d-4c81-8bfc-ebf86efa9368/scratchpad/shot/node_modules/playwright-core'
async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE, 'playwright-core', DEFAULT_PW].filter(Boolean)
  for (const c of candidates) {
    try {
      const req = createRequire(import.meta.url)
      const resolved = c.startsWith('/') ? req.resolve(c) : req.resolve(c)
      return await import(pathToFileURL(resolved).href)
    } catch { /* next */ }
  }
  throw new Error('playwright-core not found. Set PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core')
}
const pw = await loadPlaywright()
const chromium = pw.chromium ?? pw.default?.chromium

const BASE = (process.argv[2] || 'https://localhost:5173/').replace(/\/?$/, '/')
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const ctx = await browser.newContext({
  locale: 'de-DE', viewport: { width: 443, height: 960 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  ignoreHTTPSErrors: true, geolocation: { latitude: 52.5249, longitude: 13.3688 }, permissions: ['geolocation', 'camera'],
})

const errors = [] // { step, kind, text }
let current = 'setup'
function watch(page) {
  page.on('pageerror', (e) => errors.push({ step: current, kind: 'pageerror', text: String(e) }))
  page.on('console', (m) => { if (m.type() === 'error') errors.push({ step: current, kind: 'console', text: m.text() }) })
}

let n = 0
const results = []
// Return to the map if a previous step navigated away (e.g. a full-screen recorder).
async function ensureMap(page) {
  if (await page.locator('.gm-tab').first().isVisible().catch(() => false)) return
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await page.locator('.gm-tab').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1500)
}
async function step(name, page, fn) {
  n += 1
  current = name
  const tag = `${String(n).padStart(2, '0')}-${name}`
  const before = errors.filter((e) => e.kind === 'pageerror').length
  let ok = false
  let note = ''
  try {
    note = (await fn()) || ''
    const pageErrs = errors.filter((e) => e.kind === 'pageerror').length - before
    if (pageErrs > 0) throw new Error(`${pageErrs} page error(s)`)
    ok = true
  } catch (e) {
    note = String(e?.message || e).split('\n')[0].slice(0, 160)
  }
  try { await page.screenshot({ path: join(OUT, `${tag}.png`) }) } catch { /* page may be gone */ }
  results.push({ tag, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${tag}${note ? `  (${note})` : ''}`)
}

const page = await ctx.newPage()
watch(page)

// 1 map loads
await step('map-loads', page, async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.locator('.gm').first().waitFor({ state: 'visible', timeout: 20000 })
  const search = page.locator('input[placeholder*="Hier suchen" i], [aria-label*="Hier suchen" i]').first()
  await search.waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(3000) // tiles
})

// 2 bottom-nav tabs
for (const label of ['Erkunden', 'Für dich', 'Beitragen', 'Unternehmen']) {
  const slug = label.toLowerCase().replace('ü', 'ue').replace(/\s+/g, '-')
  await step(`tab-${slug}`, page, async () => {
    await ensureMap(page)
    const tab = page.locator('.gm-tab', { hasText: label }).first()
    await tab.waitFor({ state: 'visible', timeout: 5000 })
    await tab.click()
    await page.waitForTimeout(1200)
    const body = page.locator('.gm-sheet-body').first()
    const txt = ((await body.innerText({ timeout: 3000 }).catch(() => '')) || '').trim()
    const kids = await body.locator('*').count().catch(() => 0)
    if (!txt && kids === 0) throw new Error('.gm-sheet-body empty')
    return `${kids} nodes`
  })
}

// back to Erkunden for the next steps
await ensureMap(page)
await page.locator('.gm-tab', { hasText: 'Erkunden' }).first().click({ timeout: 3000 }).catch(() => {})
await page.waitForTimeout(800)

// 3 toggle a chip
await step('chip-toggle', page, async () => {
  await ensureMap(page)
  const chip = page.locator('.gm-chip:visible, .gm-chips button:visible').first()
  await chip.waitFor({ state: 'visible', timeout: 5000 })
  const before = await chip.getAttribute('aria-pressed')
  await chip.click()
  await page.waitForTimeout(800)
  const after = await chip.getAttribute('aria-pressed')
  const label = ((await chip.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
  if (before !== null && before === after) throw new Error(`aria-pressed unchanged (${before}) on "${label}"`)
  await chip.click().catch(() => {}) // restore
  await page.waitForTimeout(500)
  return `"${label}" ${before} -> ${after}`
})

// 4 door card with Route pill (door rows only exist in Barrierefrei mode)
await step('door-card-route', page, async () => {
  await ensureMap(page)
  await page.locator('.gm-tab', { hasText: 'Erkunden' }).first().click({ timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(500)
  const mode = page.locator('.gm-mode-chip:visible').first()
  await mode.waitFor({ state: 'visible', timeout: 5000 })
  if ((await mode.getAttribute('aria-pressed')) !== 'true') {
    await mode.click()
    await page.waitForTimeout(1200)
  }
  if ((await mode.getAttribute('aria-pressed')) !== 'true') throw new Error('.gm-mode-chip did not switch to aria-pressed=true')
  const handle = page.locator('.gm-handle').first()
  if (await handle.isVisible().catch(() => false)) { await handle.click().catch(() => {}); await page.waitForTimeout(700) }
  const row = page.locator('.gm-row:visible').first()
  await row.waitFor({ state: 'visible', timeout: 15000 })
  const title = ((await row.innerText().catch(() => '')) || '').split('\n')[0]
  await row.click()
  await page.waitForTimeout(2500)
  const route = page.getByRole('button', { name: /route/i }).first()
  await route.waitFor({ state: 'visible', timeout: 8000 })
  return `"${title}"`
})

// 5 simulation reaches arrival
const sim = await ctx.newPage()
watch(sim)
await step('sim-arrival', sim, async () => {
  await sim.goto(`${BASE}?sim=1`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const deadline = Date.now() + 60000
  const arrived = sim.getByText(/angekommen/i).first()
  let clicks = 0
  while (Date.now() < deadline) {
    if (await arrived.isVisible().catch(() => false)) return `after ${clicks} click(s)`
    // Click through start/profile screens: primary visible button that is not "retry"/"back".
    // Prefer explicit "go on" buttons; fall back to the first primary button.
    const next = sim.locator('button:visible').filter({ hasText: /^(weiter|los|start|starten|fertig|ok|verstanden|simulation)/i }).first()
    const primary = sim.locator('button.btn:not(.btn-secondary):visible').filter({ hasNotText: /erneut|zurück|abbrechen|beenden/i }).first()
    const target = (await next.count()) ? next : primary
    if (clicks < 20 && (await target.count())) {
      await target.click({ timeout: 2000 }).then(() => { clicks += 1 }).catch(() => {})
    }
    await sim.waitForTimeout(2000)
  }
  throw new Error(`no "angekommen" within 60 s (${clicks} clicks)`)
})

// 6 business: create form -> dashboard
async function openTab(pg, label) {
  await ensureMap(pg)
  const tab = pg.locator('.gm-tab', { hasText: label }).first()
  await tab.waitFor({ state: 'visible', timeout: 5000 })
  await tab.click()
  await pg.waitForTimeout(1200)
}
await step('business-create', page, async () => {
  await openTab(page, 'Unternehmen')
  const name = page.getByLabel('Name des Unternehmens').first()
  await name.waitFor({ state: 'visible', timeout: 5000 })
  await name.fill('Testcafé')
  const take = page.getByRole('button', { name: 'Standort: Kartenmitte übernehmen' }).first()
  await take.waitFor({ state: 'visible', timeout: 5000 })
  await take.click()
  await page.waitForTimeout(500)
  await page.getByText(/Standort gesetzt/i).first().waitFor({ state: 'visible', timeout: 5000 })
  await page.getByRole('button', { name: 'Speichern' }).first().click()
  await page.waitForTimeout(1200)
  const card = page.locator('.bz-card:visible').first()
  await card.waitFor({ state: 'visible', timeout: 8000 })
  const body = ((await page.locator('.gm-sheet-body').first().innerText().catch(() => '')) || '')
  if (!/Testcafé/.test(body)) throw new Error('dashboard does not show "Testcafé"')
  if ((await page.locator('form.bz:visible').count()) > 0) throw new Error('create form still visible')
  return `${await page.locator('.bz-card:visible').count()} dashboard card(s)`
})

// 7 contribute: report entrance -> editor with "Stufenlos"
await step('contribute-report', page, async () => {
  await openTab(page, 'Beitragen')
  // Tile label has moved (Eingang melden -> Eingang hinzufügen / aktualisieren),
  // so match on the stable part rather than the exact wording.
  const tile = page.locator('.ct-tile:visible', { hasText: /Eingang (melden|hinzuf|aktualis)/i }).first()
  await tile.waitFor({ state: 'visible', timeout: 5000 })
  await tile.scrollIntoViewIfNeeded().catch(() => {})
  await tile.click()
  await page.waitForTimeout(1500)
  const form = page.locator('form.ee:visible').first()
  if (!(await form.isVisible().catch(() => false))) {
    // touch emulation sometimes swallows the first tap on the sheet; retry with a synthetic click
    await tile.dispatchEvent('click').catch(() => {})
    await page.waitForTimeout(1500)
  }
  await form.waitFor({ state: 'visible', timeout: 8000 })
  const label = form.locator('.ee-label', { hasText: /^Stufenlos/ }).first()
  await label.waitFor({ state: 'visible', timeout: 5000 })
  const inputs = await page.locator('.ee-input:visible, .ee-seg-btn:visible').count()
  if (inputs === 0) throw new Error('"Stufenlos" found but no editor inputs')
  return `${inputs} editor control(s)`
})

// 8 for you renders
await step('for-you-renders', page, async () => {
  await openTab(page, 'Für dich')
  const root = page.locator('.fy:visible').first()
  await root.waitFor({ state: 'visible', timeout: 8000 })
  const title = ((await root.locator('.gm-sheet-title').first().innerText().catch(() => '')) || '').trim()
  const kids = await root.locator('*').count()
  if (kids < 3) throw new Error(`.fy nearly empty (${kids} nodes)`)
  return `"${title}" ${kids} nodes`
})

// 9 errors
current = 'report'
console.log('\n--- console/page errors ---')
if (!errors.length) console.log('(none)')
for (const e of errors) console.log(`[${e.step}] ${e.kind}: ${e.text.slice(0, 300)}`)

const fails = results.filter((r) => !r.ok).length
console.log(`\n${results.length - fails}/${results.length} passed, screenshots in ${OUT}`)
await browser.close()
process.exit(fails)
