// Walking navigation screen (ui/NavMode.ts) on its own. Usage: node e2e/navmode.mjs [baseUrl]
//
// Loads the app (for the Maps key and script), imports NavMode through Vite, opens it with
// a fake two-step route and walks Chrome's overridden geolocation along it. Checks the
// banner, the step change, the ETA bar, recenter after a pan, off-route, arrival and that
// close() leaves no DOM behind. Muted Chrome. Env: NAVMODE_OUT (screenshots dir),
// PLAYWRIGHT_CORE, CHROME_PATH. Exit code = number of FAILs.
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
const OUT = process.env.NAVMODE_OUT || join(dirname(fileURLToPath(import.meta.url)), 'out', 'navmode')
mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Rosenthaler Platz: 120 m east along Torstraße, then left (north) 80 m.
const A = [52.52935, 13.40125]
const M_LAT = 1 / 111320
const M_LNG = 1 / (111320 * Math.cos((A[0] * Math.PI) / 180))
const B = [A[0], A[1] + 120 * M_LNG]
const C = [B[0] + 80 * M_LAT, B[1]]
const ROUTE = {
  found: true,
  distanceM: 200,
  path: [A, B, C],
  steps: [
    { distanceM: 120, maneuver: 'DEPART', text: 'Auf der Torstraße nach Osten', endLat: B[0], endLon: B[1] },
    { distanceM: 80, maneuver: 'TURN_LEFT', text: 'Links in die Brunnenstraße', endLat: C[0], endLon: C[1] },
  ],
}
const at = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]

let fails = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`)
  if (!ok) fails++
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--mute-audio', '--use-angle=metal'] })
const ctx = await browser.newContext({
  viewport: { width: 412, height: 860 },
  deviceScaleFactor: 2,
  ignoreHTTPSErrors: true,
  geolocation: { latitude: A[0], longitude: A[1], accuracy: 5 },
  permissions: ['geolocation'],
  locale: 'de-DE',
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.google?.maps?.Map, null, { timeout: 30000 }).catch(() => {})

const walkTo = async (p, acc = 5) => {
  await ctx.setGeolocation({ latitude: p[0], longitude: p[1], accuracy: acc })
  await page.waitForTimeout(900)
}

await page.evaluate(async (route) => {
  const m = await import('/src/ui/NavMode.ts')
  window.__nav = { arrived: 0, exited: 0, off: 0, steps: [] }
  window.__navClose = m.openNav({
    route,
    destination: { lat: route.path.at(-1)[0], lng: route.path.at(-1)[1], name: 'Brunnenstraße 1' },
    onArrive: () => window.__nav.arrived++,
    onExit: () => window.__nav.exited++,
    onLiveView: () => {},
    onOffRoute: () => window.__nav.off++,
    onStepChange: (t) => window.__nav.steps.push(t),
  })
}, ROUTE)

// Walk the first leg.
for (let t = 0.05; t <= 0.55; t += 0.1) await walkTo(at(A, B, t))
await page.waitForTimeout(2500)
await page.screenshot({ path: join(OUT, 'n3-1-straight.png') })
const banner1 = await page.locator('.wn-banner').innerText()
check('banner shows next turn', /Brunnenstraße/.test(banner1), banner1.replace(/\s+/g, ' '))
check('banner distance in metres', /\d+ m/.test(banner1))
const bar = await page.locator('.wn-bottom').innerText()
check('ETA bar min, distance, clock', /\d+ Min/.test(bar) && /\d+ m · \d\d:\d\d/.test(bar), bar.replace(/\s+/g, ' '))
check('status region polite', (await page.locator('.wn-banner [role=status][aria-live=polite]').count()) === 1)
const sizes = await page.evaluate(() => [...document.querySelectorAll('.wn-exit, .wn-live, .wn-recenter:not([hidden])')].map((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height)))
check('targets at least 48 px', sizes.every((s) => s >= 48), sizes.join(','))

// Pan away, recenter appears.
const box = await page.locator('.wn-map').boundingBox()
await page.mouse.move(box.x + 200, box.y + 400)
await page.mouse.down()
await page.mouse.move(box.x + 80, box.y + 250, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(500)
check('recenter after pan', await page.locator('.wn-recenter').isVisible())
await page.screenshot({ path: join(OUT, 'n3-2-panned.png') })
await page.locator('.wn-recenter').click()
check('recenter hides after tap', !(await page.locator('.wn-recenter').isVisible()))

// Around the corner.
for (let t = 0.65; t <= 1.0; t += 0.1) await walkTo(at(A, B, t))
for (let t = 0.1; t <= 0.4; t += 0.1) await walkTo(at(B, C, t))
await page.waitForTimeout(2000)
await page.screenshot({ path: join(OUT, 'n3-3-after-turn.png') })
const banner2 = await page.locator('.wn-banner').innerText()
check('after the turn banner shows the destination', /Brunnenstraße 1/.test(banner2), banner2.replace(/\s+/g, ' '))
check('step change reported', (await page.evaluate(() => window.__nav.steps.length)) >= 2)

// Off-route: 45 m west of the second leg.
const offP = [at(B, C, 0.45)[0], B[1] - 45 * M_LNG]
await walkTo([at(B, C, 0.42)[0], B[1] - 20 * M_LNG])
await walkTo(offP)
await walkTo(offP)
await page.waitForTimeout(1200)
await page.screenshot({ path: join(OUT, 'n3-4-offroute.png') })
check('off-route line', await page.locator('.wn-off').isVisible())
check('onOffRoute fired', (await page.evaluate(() => window.__nav.off)) >= 1)

// Back on and to the door.
for (let t = 0.5; t <= 0.95; t += 0.1) await walkTo(at(B, C, t))
await walkTo(C, 8)
await page.waitForTimeout(1500)
await page.screenshot({ path: join(OUT, 'n3-5-arrived.png') })
check('onArrive once', (await page.evaluate(() => window.__nav.arrived)) === 1)

await page.evaluate(() => window.__navClose())
check('close removes the DOM', (await page.locator('.wn-root').count()) === 0)
check('no page errors', errors.length === 0, errors.join(' | '))

await browser.close()
process.exit(fails)
