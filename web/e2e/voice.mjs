// Vorlesen and Fragen, in the door card and in Live View. Usage: node e2e/voice.mjs [baseUrl]
//
// Checks both buttons exist, are at least 56 px tall with the right labels, and that the
// text fallback (no SpeechRecognition) answers "Ist der Eingang stufenlos?" locally,
// without calling /api/ask. Muted browser; /api/ask and friends are stubbed to 503.
// Env: PLAYWRIGHT_CORE, CHROME_PATH as in smoke.mjs. Exit code = number of failed checks.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const DEFAULT_PW = '/private/tmp/claude-501/-Users-samimagdouli/1d160c72-db6d-4c81-8bfc-ebf86efa9368/scratchpad/shot/node_modules/playwright-core'
async function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_CORE, 'playwright-core', DEFAULT_PW].filter(Boolean)) {
    try {
      return await import(pathToFileURL(createRequire(import.meta.url).resolve(c)).href)
    } catch { /* next */ }
  }
  throw new Error('playwright-core not found. Set PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core')
}
const pw = await loadPlaywright()
const chromium = pw.chromium ?? pw.default?.chromium
const BASE = (process.argv[2] || 'https://localhost:5173/').replace(/\/?$/, '/')
const DOOR = 'node/10795939972'
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const results = []
function check(name, ok, note = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `  (${note})` : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--mute-audio', '--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const ctx = await browser.newContext({
  locale: 'de-DE', viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  ignoreHTTPSErrors: true, geolocation: { latitude: 52.5249, longitude: 13.3688 }, permissions: ['geolocation', 'camera'],
})
let askCalls = 0
await ctx.route(/\/api\/(speak|look|door-fix|door-check|ask)/, (r) => {
  if (r.request().url().includes('/api/ask')) askCalls++
  return r.fulfill({ status: 503, body: '' })
})
// No speech recognition: Fragen must open the text field.
await ctx.addInitScript(() => {
  try { delete window.SpeechRecognition } catch { /* */ }
  try { delete window.webkitSpeechRecognition } catch { /* */ }
})
const page = await ctx.newPage()
page.on('pageerror', (e) => check('no page error', false, String(e).slice(0, 160)))

async function buttons(scope, where) {
  const read = page.locator(`${scope} button.va-read:visible`).first()
  const ask = page.locator(`${scope} button.va-ask:visible`).first()
  for (const [b, label, text] of [[read, 'Alles auf dem Bildschirm vorlesen', 'Vorlesen'], [ask, 'Eine Frage stellen', 'Fragen']]) {
    const ok = (await b.count()) === 1
    const box = ok ? await b.boundingBox() : null
    check(`${where}: "${text}" is at least 56 px`, !!box && box.height >= 56 && box.width >= 56, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'missing')
    const al = ok ? (await b.getAttribute('aria-label')) ?? '' : ''
    const tx = ok ? (await b.innerText()).trim() : ''
    check(`${where}: "${text}" label and text`, al.startsWith(label) && tx.endsWith(text), `${al} | ${tx}`)
  }
}

try {
  await page.goto(`${BASE}?demo=1&door=${DOOR}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const view = page.locator('button.gm-pill-view:visible').first()
  await view.waitFor({ state: 'visible', timeout: 20000 })
  await buttons('.gm-voice', 'door card')
  const firstAction = await page.locator('.gm-actions button').first().getAttribute('class')
  check('door card: blue View pill stays first', /gm-pill-view/.test(firstAction ?? ''), firstAction ?? '')
  check('door card: no eye button', (await page.locator('.ar-look').count()) === 0)

  await page.locator('.gm-voice button.va-ask').first().click()
  const input = page.locator('.gm-voice input.va-input')
  check('no recognition: "Frage eintippen" opens', await input.isVisible())
  await input.fill('Ist der Eingang stufenlos?')
  await page.locator('.gm-voice button.va-send').first().click()
  await page.waitForTimeout(300)
  const out = (await page.locator('.gm-voice .va-out').innerText()).replace(/\s+/g, ' ')
  check('question is shown', /Frage: Ist der Eingang stufenlos\?/.test(out), out.slice(0, 120))
  check('answer is local and about step-free access', /Antwort: (Ja, der Eingang ist stufenlos|Nein, der Eingang ist nicht stufenlos|Ob der Eingang stufenlos ist, wissen wir noch nicht)/.test(out), out.slice(0, 160))
  check('no /api/ask call for a local answer', askCalls === 0, String(askCalls))

  await input.fill('Hat das Café heute offen?')
  await page.locator('.gm-voice button.va-send').first().click()
  await page.waitForTimeout(1500)
  const out2 = (await page.locator('.gm-voice .va-out').innerText()).replace(/\s+/g, ' ')
  check('server down: the fixed fallback line', /Das kann ich gerade nicht beantworten/.test(out2), out2.slice(0, 160))

  await view.click()
  await page.locator('section.ar').first().waitFor({ state: 'visible', timeout: 15000 })
  await buttons('section.ar .ar-dest', 'Live View')
  check('Live View: eye button is gone', (await page.locator('section.ar .ar-look').count()) === 0)
} catch (e) {
  check('flow ran', false, String(e.message || e).split('\n')[0])
}

await browser.close()
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed)
