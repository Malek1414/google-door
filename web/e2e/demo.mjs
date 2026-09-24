// The demo loop end to end. Usage: node e2e/demo.mjs [baseUrl]
//
// ?demo=1&door=… → View → short simulated walk → arrival sheet ("Du bist angekommen",
// "Sollen wir dir zeigen, wo du reinkommst?") → "Ja, zeig mir den Eingang" → scripted
// approach (ui/approachDemo.ts) → through → back at the map, View again ready.
// A second run takes "Nein, danke" and must land on the map at once.
//
// Env: PLAYWRIGHT_CORE, CHROME_PATH as in smoke.mjs; SHOTS=/dir for the arrival screenshots
// (default e2e/out). Exit code = number of failed assertions.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

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
const DOOR = 'node/10795939972' // config.ts DEFAULT_SIM_DOOR, tier 1
const OUT = process.env.SHOTS || join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(OUT, { recursive: true })
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

async function newPage(reducedMotion = 'no-preference') {
  const ctx = await browser.newContext({
    locale: 'de-DE', viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    ignoreHTTPSErrors: true, geolocation: { latitude: 52.5249, longitude: 13.3688 }, permissions: ['geolocation', 'camera'],
    reducedMotion,
  })
  // Never spend the backend's Gemini quota; the device-voice fallback is what runs.
  await ctx.route(/\/api\/(speak|look|door-fix|door-check)/, (r) => r.fulfill({ status: 503, body: '' }))
  // Count what is spoken, so "the sheet is said once" can be checked.
  await ctx.addInitScript(() => {
    window.__spoken = []
    try {
      const orig = speechSynthesis.speak.bind(speechSynthesis)
      speechSynthesis.speak = (u) => { window.__spoken.push(u.text); return orig(u) }
    } catch { /* no synth */ }
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => check('no page error', false, String(e).slice(0, 160)))
  return page
}

const phaseOf = (page) => page.locator('section.apr').first().getAttribute('data-phase').catch(() => null)

async function openAndView(page) {
  if (!page.url().includes('demo=1')) await page.goto(`${BASE}?demo=1&door=${DOOR}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const view = page.locator('button.gm-pill-view:visible').first()
  await view.waitFor({ state: 'visible', timeout: 20000 })
  await view.click()
  const t0 = Date.now()
  await page.locator('.arrival').first().waitFor({ state: 'visible', timeout: 20000 })
  return (Date.now() - t0) / 1000
}

// ── 1. the whole loop: View → arrival → Ja → approach → through → map ─────────
{
  const page = await newPage()
  let secs = 0
  try {
    secs = await openAndView(page)
    check('arrival sheet appears within 12 s of View', secs <= 12, `${secs.toFixed(1)} s`)
  } catch (e) {
    check('arrival sheet appears', false, String(e.message || e).split('\n')[0])
  }
  if (results.at(-1).ok) {
    await page.waitForTimeout(400) // rise animation
    await page.screenshot({ path: join(OUT, 'demo-arrival.png') })
    const sheet = page.locator('.arrival').first()
    const text = (await sheet.innerText()).replace(/\s+/g, ' ')
    check('title "Du bist angekommen"', /Du bist angekommen/.test(text))
    check('question line', /Sollen wir dir zeigen, wo du reinkommst\?/.test(text))
    check('role dialog, aria-modal', (await sheet.getAttribute('role')) === 'dialog' && (await sheet.getAttribute('aria-modal')) === 'true')
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
    check('focus on "Ja, zeig mir den Eingang"', focused === 'Ja, zeig mir den Eingang', focused)
    const yes = page.locator('button.arrival-yes').first()
    const box = await yes.boundingBox()
    check('primary pill is at least 56 px tall', !!box && box.height >= 56, box ? `${box.height}px` : '')
    const bg = await yes.evaluate((el) => getComputedStyle(el).backgroundColor)
    check('primary pill is Google blue', bg === 'rgb(26, 115, 232)', bg)
    check('"Nein, danke" is there', await page.locator('button.arrival-no', { hasText: 'Nein, danke' }).isVisible())
    check('no countdown while asking', (await page.locator('.arrival-count:visible').count()) === 0)
    await page.waitForTimeout(3000)
    const spoken = await page.evaluate(() => window.__spoken.filter((s) => /angekommen/i.test(s)))
    check('the sheet is spoken once', spoken.length === 1, JSON.stringify(spoken).slice(0, 160))

    await yes.click()
    let opened = false
    try {
      await page.locator('section.apr').first().waitFor({ state: 'visible', timeout: 8000 })
      opened = true
    } catch { /* reported below */ }
    check('"Ja" opens the approach screen', opened)
    if (opened) {
      await page.waitForTimeout(6000)
      await page.screenshot({ path: join(OUT, 'demo-approach.png') })
      let through = false
      const end = Date.now() + 30000
      while (Date.now() < end && !through) {
        through = (await phaseOf(page)) === 'through'
        if (!through) await page.waitForTimeout(250)
      }
      check('approach reaches "through"', through)
      if (through) await page.screenshot({ path: join(OUT, 'demo-through.png') })
      let back = false
      try {
        await page.locator('button.gm-pill-view:visible').first().waitFor({ state: 'visible', timeout: 25000 })
        back = (await page.locator('section.apr').count()) === 0
      } catch (e) {
        await page.screenshot({ path: join(OUT, 'demo-back-fail.png') })
        console.log(String(e.message || e).split('\n')[0], 'apr:', await page.locator('section.apr').count(), 'gm:', await page.locator('.gm').count())
      }
      check('back at the map with View ready', back)
      if (back) {
        // Repeatable: View again reaches the sheet a second time.
        try {
          const again = await openAndView(page)
          check('the loop runs a second time', true, `${again.toFixed(1)} s`)
          await page.locator('button.arrival-no').first().click()
          await page.locator('button.gm-pill-view:visible').first().waitFor({ state: 'visible', timeout: 10000 })
          check('"Nein, danke" goes back to the map', (await page.locator('.arrival').count()) === 0)
        } catch (e) {
          check('the loop runs a second time', false, String(e.message || e).split('\n')[0])
        }
      }
    }
  }
  await page.context().close()
}

// ── 2. reduced motion: the sheet is there at once, no rise ─────────────────────
{
  const page = await newPage('reduce')
  try {
    await openAndView(page)
    const anim = await page.locator('.arrival').first().evaluate((el) => getComputedStyle(el).animationName)
    check('reduced motion: no rise animation', anim === 'none', anim)
    await page.screenshot({ path: join(OUT, 'demo-arrival-reduced-motion.png') })
  } catch (e) {
    check('reduced motion: sheet appears', false, String(e.message || e).split('\n')[0])
  }
  await page.context().close()
}

await browser.close()
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots in ${OUT}`)
process.exit(failed)
