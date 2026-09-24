// Real navigation, end to end, with no ?sim or ?demo. Usage: node e2e/nav.mjs [baseUrl]
//
// map -> door card (?door=node/10795939972) -> Route (real /api/route, else the Maps JS
// Routes fallback) -> Start -> Live View driven by overridden geolocation, stepped along
// the route that was drawn, about once per second -> arrival sheet -> "Ja" -> Approach
// with the REAL engine (data-engine="real"), camera from Chrome's fake device and the
// real /api/door-fix (Gemini may answer 429: the engine must still say something).
//
// Env: NAV_SPEED (default 1 = 1.4 m per second of wall time), NAV_OUT (screenshots dir,
// default e2e/out/nav), NAV_WALK (write "lat,lng lat,lng ..." of the walk there),
// PLAYWRIGHT_CORE, CHROME_PATH as in smoke.mjs. Exit code = number of FAILs.
import { mkdirSync, writeFileSync } from 'node:fs'
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
const OUT = process.env.NAV_OUT || join(dirname(fileURLToPath(import.meta.url)), 'out', 'nav')
mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SPEED = Math.max(0.5, Number(process.env.NAV_SPEED || 1))
const DOOR_ID = 'node/10795939972'
// The door (data/berlin-mitte.json): tier 1, step-free, no surveyed approachBearing.
const DOOR = [52.5272097, 13.3711667]
// About 180 m south-west of the door, on Invalidenstraße by the Hauptbahnhof.
const START = { latitude: 52.5263, longitude: 13.3690 }
// Selectors for both guidance screens: NavMode (N3) and the camera Live View.
const SCREEN_NAV = '.wn-root, .nav-root'
const SEL_INSTR = '.wn-instr, .nav-instr, .ar-instr-t'
// NavMode: "180 m · 09:25" under the minutes; Live View: the door card's metres.
const SEL_DIST = '.wn-eta-sub, .nav-eta-sub, .ar-dest-m'
const PROFILE = { stepFreeRequired: false, channels: ['speech', 'visual'] }

let fails = 0
function check(name, ok, note = '') {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `  (${note})` : ''}`)
}

const R = 6371000
const rad = (d) => (d * Math.PI) / 180
function dist(a, b) {
  const dLat = rad(b[0] - a[0])
  const dLon = rad(b[1] - a[1])
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}
function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]))
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]))
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}
/** Points every `stepM` metres along a polyline, the last one exactly on its end. */
function resample(path, stepM) {
  const out = [path[0]]
  let carry = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const d = dist(a, b)
    let s = stepM - carry
    while (s <= d) {
      const f = s / d
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
      s += stepM
    }
    carry = d - (s - stepM)
  }
  const end = path[path.length - 1]
  if (dist(out[out.length - 1], end) > 0.3) out.push(end)
  return out
}

function initScript(profile) {
  try {
    localStorage.setItem('doorway.profile', JSON.stringify(profile))
    localStorage.setItem('doorway.mode', 'access')
  } catch { /* ignored */ }
  window.__polys = []
  window.__heading = 0
  const wrap = setInterval(() => {
    const m = window.google?.maps
    if (!m?.Polyline || m.Polyline.__rec) return
    const P = m.Polyline
    class Rec extends P {
      constructor(o) {
        super(o)
        window.__polys.push(this)
      }
    }
    Rec.__rec = true
    try {
      Object.defineProperty(m, 'Polyline', { configurable: true, writable: true, value: Rec })
    } catch { /* ignored */ }
    clearInterval(wrap)
  }, 10)
  // Compass: the walker faces along the route (window.__heading, set by the harness).
  setInterval(() => {
    const hd = window.__heading
    const alpha = (360 - hd) % 360
    const ios = new Event('deviceorientation')
    for (const [k, v] of Object.entries({ alpha, beta: 80, gamma: 0, absolute: false, webkitCompassHeading: hd, webkitCompassAccuracy: 10 })) Object.defineProperty(ios, k, { value: v })
    window.dispatchEvent(ios)
    const abs = new Event('deviceorientationabsolute')
    for (const [k, v] of Object.entries({ alpha, beta: 80, gamma: 0, absolute: true })) Object.defineProperty(abs, k, { value: v })
    window.dispatchEvent(abs)
  }, 60)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--mute-audio', '--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const ctx = await browser.newContext({
  locale: 'de-DE', viewport: { width: 402, height: 874 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  ignoreHTTPSErrors: true, geolocation: { ...START, accuracy: 5 }, permissions: ['geolocation', 'camera', 'microphone'],
})
await ctx.addInitScript(initScript, PROFILE)
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
const doorFix = []
page.on('response', (r) => {
  if (/\/api\/door-fix\b/.test(r.url())) doorFix.push(r.status())
})
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) }).catch(() => {})
const text = (sel) => page.locator(sel).first().textContent({ timeout: 1000 }).then((s) => (s || '').trim()).catch(() => '')

try {
  const url = `${BASE}?door=${encodeURIComponent(DOOR_ID)}`
  check('no sim or demo parameter in the URL', !/[?&](sim|demo|approach)=/.test(url), url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const routePill = page.locator('.gm-sheet .gm-pill', { hasText: /^\s*\S*\s*Route\s*$/ }).first()
  await routePill.waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(1200)
  await shot('01-door-card')
  await routePill.tap()
  await page.locator('.gm-routehead').first().waitFor({ state: 'visible', timeout: 25000 })
  // The route line: the longest polyline on the map.
  let path = []
  for (let i = 0; i < 40 && path.length < 2; i++) {
    path = await page.evaluate(() =>
      (window.__polys || []).filter((p) => p.getMap()).map((p) => p.getPath().getArray().map((q) => [q.lat(), q.lng()])).sort((a, b) => b.length - a.length)[0] || [])
    if (path.length < 2) await page.waitForTimeout(250)
  }
  const head = await text('.gm-routehead-t')
  check('Route: a walking route is drawn (multi-point line)', path.length >= 3, `${path.length} points, "${head}"`)
  await shot('02-route')
  const steps = await page.locator('.gm-sheet .dir-list .dir-step').count()
  check('Route: steps are listed', steps >= 2, `${steps} rows`)

  const start = page.locator('.gm-routeactions > :first-child').first()
  check('Start is enabled', !(await start.isDisabled().catch(() => true)))
  await start.tap()
  // Start opens the map navigation (ui/NavMode.ts) when it exists, else the camera Live View.
  await page.locator(`${SCREEN_NAV}, #live-title`).first().waitFor({ state: 'attached', timeout: 15000 })
  const navScreen = (await page.locator(SCREEN_NAV).count()) > 0
  console.log(`Start opened: ${navScreen ? 'map navigation (NavMode)' : 'camera Live View'}`)
  check('guidance opened without the sim banner', (await page.locator('.banner').count()) === 0)

  // Walk the route plus the last metres to the door.
  // The route ends on the street; the last metres go to the door itself.
  const full = dist(path[path.length - 1], DOOR) > 1 ? [...path, DOOR] : path
  const walk = resample(full, 1.4 * SPEED)
  if (process.env.NAV_WALK) writeFileSync(process.env.NAV_WALK, resample(full, 5).map(([a, o]) => `${a.toFixed(6)},${o.toFixed(6)}`).join(' ') + '\n')
  const lines = []
  const dists = []
  let arrivedAt = -1
  for (let i = 0; i < walk.length + 6; i++) {
    const p = walk[Math.min(i, walk.length - 1)]
    const nxt = walk[Math.min(i + 3, walk.length - 1)]
    if (dist(p, nxt) > 0.5) await page.evaluate((hd) => (window.__heading = hd), bearing(p, nxt))
    await ctx.setGeolocation({ latitude: p[0], longitude: p[1], accuracy: 5 })
    await page.waitForTimeout(1000)
    const line = await text(SEL_INSTR)
    if (line && lines[lines.length - 1] !== line) lines.push(line)
    const mm = (await text(SEL_DIST)).match(/([\d,.]+)\s*(km|m)\b/)
    const m = mm ? Number(mm[1].replace(',', '.')) * (mm[2] === 'km' ? 1000 : 1) : NaN
    if (Number.isFinite(m) && m > 0) dists.push(m)
    if (i === 3) await shot('03-nav-start')
    if (i === Math.floor(walk.length / 2)) await shot('04-nav-mid')
    if (await page.locator('.arrival-yes').first().isVisible().catch(() => false)) {
      arrivedAt = i
      break
    }
  }
  const stepLines = lines.filter((l) => /abbiegen|links|rechts|Richtung|auf |Ankunft|Weiter/i.test(l))
  console.log('instruction lines:', JSON.stringify(lines.slice(0, 20)))
  check('Start opened the map navigation (NavMode)', navScreen)
  check('instruction line shows route steps', stepLines.length >= 1, `${stepLines.length} step lines`)
  check('instruction line advances', new Set(lines.map((l) => l.replace(/·.*$/, '').trim())).size >= 2)
  check('distance to the door counts down', dists.length > 5 && dists[0] > dists[dists.length - 1] + 50, `${dists[0]} -> ${dists[dists.length - 1]}`)
  check('arrival sheet shows at the door', arrivedAt >= 0)
  check('arrival sheet asks the question', /Sollen wir dir zeigen, wo du reinkommst/.test(await text('.arrival')))
  await shot('05-arrival')

  await page.locator('.arrival-yes').first().tap()
  const apr = page.locator('section.apr').first()
  await apr.waitFor({ state: 'visible', timeout: 10000 })
  const engine = await apr.getAttribute('data-engine')
  check('Ja opens the REAL approach engine, not approachDemo', engine === 'real', `data-engine=${engine}`)
  const seen = []
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000)
    const t = await text('.apr-instr')
    if (t && seen[seen.length - 1] !== t) seen.push(t)
    if (i === 3) await shot('06-approach')
  }
  await shot('07-approach-later')
  console.log('approach lines:', JSON.stringify(seen))
  console.log('door-fix statuses:', JSON.stringify(doorFix.slice(0, 12)))
  check('engine produced lines past the safety line', seen.some((l) => !/Ich führe dich nur zur Tür/.test(l)) || seen.length >= 2)
  check('approach screen is not stuck empty', seen.every((l) => l.length > 0) && seen.length > 0)
} catch (e) {
  check('flow ran to the end', false, String(e.message || e).split('\n')[0])
  await shot('99-failure')
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
console.log(`\n${fails} failed`)
process.exit(fails)
