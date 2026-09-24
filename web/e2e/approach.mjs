// End-to-end replay of the last 10 metres. Usage: node e2e/approach.mjs [baseUrl]
//
// Drives a scripted approach through the REAL screen and engine the way ?sim=1 drives
// Live View: fake camera (Chrome fake device), compass via deviceorientation events,
// steps via devicemotion peaks, vision via a mocked /api/door-fix. No GPS anywhere.
//
// Env:
//   APPROACH_DEMO=1   open ?approach=demo / ?approach=check directly (scripted demo engine,
//                     ignores sensors and door-fix; only useful to shake out selectors)
//   PLAYWRIGHT_CORE, CHROME_PATH as in smoke.mjs
//
// Exit code = number of failed assertions.
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
const DEMO = process.env.APPROACH_DEMO === '1'
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Words the screen must show (ui/Approach.ts AP, core/instruct.ts).
const SAFETY = /Ich führe dich nur zur Tür/
const UNSURE = /Ich bin mir gerade unsicher/
const FROM_MAP = /Richtung aus der Karte/
const PROFILE_KEY = 'doorway.profile'
const BLIND = { stepFreeRequired: false, channels: ['speech', 'visual'] }
const WHEELCHAIR = { stepFreeRequired: true, channels: ['visual'] }

// ── world model for the mocked vision ───────────────────────────────────────
// The door sits at compass 60°. Its distance shrinks while the harness "walks".
// /api/door-fix answers from this truth unless an override is queued.
const DOOR_COMPASS = 60
const SIM_DOOR = 'node/10795939972' // config.ts DEFAULT_SIM_DOOR
const STEP_M = 0.68
const world = { heading: 100, distanceM: 8, walking: false }
const overrides = [] // DoorFix bodies served before falling back to the truth
const doorFixLog = [] // { ts, heading, body }
let doorCheckCalls = 0
// `through` with the real engine: core/approach.ts has visionSaysInside(), but neither
// DoorFix (CONTRACT) nor /api/door-fix carries an "inside" signal, and the core has no
// "user stops in the threshold" rule yet. So nothing can end the threshold phase, and
// every check that needs `through` is SKIPPED (not failed) until Malek adds one.
const THROUGH_REACHABLE = DEMO
const THROUGH_SKIP = 'no "inside" signal in DoorFix/door-fix and no stop rule in core/approach.ts (question for Malek)'

const rel = (compass, heading) => ((((compass - heading) % 360) + 540) % 360) - 180
function truthFix() {
  return {
    found: true,
    bearingDeg: Math.round(rel(DOOR_COMPASS, world.heading) * 10) / 10,
    distanceM: Math.max(0.3, Math.round(world.distanceM * 10) / 10),
    confidence: 0.88,
    kind: 'sliding',
    note: 'Glastür',
    ts: Date.now(),
    source: 'gemini-frame',
  }
}
const NOT_FOUND = () => ({ found: false, bearingDeg: 0, distanceM: 0, confidence: 0.1, kind: 'unknown', note: '', ts: Date.now(), source: 'gemini-frame' })

// ── page-side instrumentation (runs before the app) ─────────────────────────
function initScript({ profileKey, profile }) {
  try { localStorage.setItem(profileKey, JSON.stringify(profile)) } catch { /* ignored */ }
  const rec = { live: [], phases: [], outsideVisibleIn: [], fromMapSeen: 0, geoTotal: 0, geoDuringApproach: 0, aprSeen: false, stepsSent: 0 }
  window.__rec = rec
  // Count every geolocation call; the ones after the approach screen opens must be zero.
  const geo = navigator.geolocation
  if (geo) {
    for (const k of ['getCurrentPosition', 'watchPosition']) {
      const orig = geo[k].bind(geo)
      try {
        Object.defineProperty(geo, k, { configurable: true, value: (...a) => { rec.geoTotal++; if (rec.aprSeen) rec.geoDuringApproach++; return orig(...a) } })
      } catch { /* ignored */ }
    }
  }
  const watchDom = () => {
    const live = document.getElementById('live')
    if (live) {
      new MutationObserver(() => {
        const txt = (live.textContent || '').trim()
        if (txt && rec.aprSeen) rec.live.push(txt)
      }).observe(live, { childList: true, characterData: true, subtree: true })
    }
    new MutationObserver(() => {
      const apr = document.querySelector('section.apr')
      if (apr && !rec.aprSeen) rec.aprSeen = true
      const src = apr?.querySelector('.apr-src')
      if (src && !src.hidden && !rec.fromMapVisible) rec.fromMapSeen++
      rec.fromMapVisible = !!(src && !src.hidden)
      const ph = apr?.getAttribute('data-phase')
      if (ph && rec.phases[rec.phases.length - 1] !== ph) {
        rec.phases.push(ph)
        const btn = apr.querySelector('.apr-big')
        if (btn && !btn.hidden) rec.outsideVisibleIn.push(ph)
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase', 'hidden'] })
  }
  if (document.body) watchDom()
  else document.addEventListener('DOMContentLoaded', watchDom)

  // Sensor driver: compass + pitch at 20 Hz, motion at 50 Hz.
  const drive = { heading: 100, beta: 80, walking: false, stepHz: 2 }
  window.__drive = drive
  let t0 = performance.now()
  // Desktop Chrome may lack the sensor event constructors: fall back to a plain Event
  // with the same fields, which is all the app's listeners read.
  function orientEvent(ctor, type, init) {
    let ev
    try { ev = new window[ctor](type, init) } catch { ev = null }
    if (!ev) {
      ev = new Event(type)
      for (const [k, v] of Object.entries(init)) Object.defineProperty(ev, k, { value: v })
    }
    return ev
  }
  setInterval(() => {
    const alpha = (360 - drive.heading) % 360
    const abs = orientEvent('DeviceOrientationEvent', 'deviceorientationabsolute', { alpha, beta: drive.beta, gamma: 0, absolute: true })
    window.dispatchEvent(abs)
    const ios = orientEvent('DeviceOrientationEvent', 'deviceorientation', { alpha, beta: drive.beta, gamma: 0, absolute: false })
    Object.defineProperty(ios, 'webkitCompassHeading', { value: drive.heading })
    Object.defineProperty(ios, 'webkitCompassAccuracy', { value: 10 })
    window.dispatchEvent(ios)
  }, 50)
  let lastPhase = 0
  setInterval(() => {
    const t = (performance.now() - t0) / 1000
    // One sharp vertical peak per step while walking, flat noise while standing.
    const phase = (t * drive.stepHz) % 1
    const z = drive.walking ? (phase < 0.15 ? 4.5 * Math.sin((phase / 0.15) * Math.PI) : -0.6) : 0.05 * Math.sin(t * 7)
    if (drive.walking && phase < lastPhase) rec.stepsSent++
    lastPhase = phase
    const init = {
      acceleration: { x: 0.1, y: 0.2, z },
      accelerationIncludingGravity: { x: 0.1, y: 9.81 + z, z: 0.3 },
      rotationRate: { alpha: 0, beta: 0, gamma: 0 },
      interval: 20,
    }
    window.dispatchEvent(orientEvent('DeviceMotionEvent', 'devicemotion', init))
  }, 20)
}

// ── harness ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const results = []
function check(name, ok, note = '') {
  results.push({ name, ok, skipped: false })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `  (${note})` : ''}`)
}
function skip(name, reason) {
  results.push({ name, ok: true, skipped: true })
  console.log(`SKIP ${name}  (${reason})`)
}
const errors = []

async function newPage(profile) {
  const ctx = await browser.newContext({
    locale: 'de-DE', viewport: { width: 430, height: 932 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    ignoreHTTPSErrors: true, geolocation: { latitude: 52.5249, longitude: 13.3688 }, permissions: ['geolocation', 'camera'],
  })
  await ctx.addInitScript(initScript, { profileKey: PROFILE_KEY, profile })
  // Vision: scripted. Live token: refused, so the engine takes the per-frame path.
  await ctx.route('**/api/door-fix**', async (route) => {
    const body = overrides.length ? overrides.shift() : truthFix()
    doorFixLog.push({ ts: Date.now(), heading: world.heading, body })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await ctx.route('**/api/door-check**', async (route) => {
    doorCheckCalls++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ step: false, widthCm: 92, opens: 'automatic', note: 'Schiebetür', confidence: 0.9 }) })
  })
  // The sim door (Hbf, node/10795939972) has no surveyed approachBearing, so the map
  // fallback could never fire. Give it one that matches the scripted world.
  await ctx.route('**/data/berlin-mitte.json', async (route) => {
    const res = await route.fetch()
    const d = await res.json()
    const list = Array.isArray(d) ? d : d.entrances ?? []
    for (const e of list) if (e.id === SIM_DOOR && e.approachBearing == null) e.approachBearing = DOOR_COMPASS
    await route.fulfill({ response: res, body: JSON.stringify(d), headers: { ...res.headers(), 'content-type': 'application/json' } })
  })
  await ctx.route('**/api/live-token**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"disabled in e2e"}' }))
  await ctx.route('**/api/speak**', (route) => route.fulfill({ status: 503, body: '' }))
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`) })
  page.on('response', (r) => { if (r.status() >= 500 && !/\/api\/(speak|live-token)/.test(r.url())) errors.push(`http ${r.status()}: ${r.url().slice(0, 120)}`) })
  return page
}

const shot = (page, name) => page.screenshot({ path: join(OUT, `approach-${name}.png`) }).catch(() => {})
const rec = (page) => page.evaluate(() => window.__rec)
const setDrive = (page, patch) => page.evaluate((p) => Object.assign(window.__drive, p), patch)
const phaseOf = (page) => page.locator('section.apr').first().getAttribute('data-phase').catch(() => null)
async function waitPhase(page, want, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (want.includes(await phaseOf(page))) return true
    await page.waitForTimeout(200)
  }
  return false
}

/** ?sim=1 → Start → arrival card → "Zum Eingang führen". Returns how it got there. */
async function reachApproach(page, directParam) {
  if (DEMO) {
    await page.goto(`${BASE}?approach=${directParam}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.locator('section.apr').first().waitFor({ state: 'visible', timeout: 15000 })
    return `?approach=${directParam}`
  }
  await page.goto(`${BASE}?sim=1&speed=20`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const trigger = page.locator('button.apr-trigger', { hasText: 'Zum Eingang führen' }).first()
  const deadline = Date.now() + 90000
  let clicks = 0
  while (Date.now() < deadline) {
    if (await trigger.isVisible().catch(() => false)) {
      await shot(page, `00-arrival-${directParam === 'demo' ? 'guide' : 'check'}`)
      await trigger.click()
      await page.locator('section.apr').first().waitFor({ state: 'visible', timeout: 10000 })
      return `sim arrival after ${clicks} start click(s)`
    }
    const next = page.locator('button:visible').filter({ hasText: /^(weiter|los|start|starten|fertig|ok|verstanden)/i }).first()
    if (clicks < 20 && (await next.count())) await next.click({ timeout: 2000 }).then(() => { clicks++ }).catch(() => {})
    await page.waitForTimeout(1000)
  }
  throw new Error('no "Zum Eingang führen" within 90 s')
}

// ── 1. guidance (blind / low vision profile) ────────────────────────────────
let page = await newPage(BLIND)
let how = ''
try {
  how = await reachApproach(page, 'demo')
  check('guide: screen opens', true, how)
} catch (e) {
  check('guide: screen opens', false, String(e.message || e).split('\n')[0])
}

if (results.at(-1).ok) {
  // a. orienting: door 40° left at 8 m; turn toward it in steps (40 → 20 → 5).
  await page.waitForTimeout(1500)
  await shot(page, '01-orienting')
  for (const h of [100, 90, 80, 70, 65, 60]) {
    world.heading = h
    await setDrive(page, { heading: h })
    await page.waitForTimeout(700)
  }
  // b. hallucination: the door "jumps" while the phone holds still, twice in a row.
  overrides.push({ ...truthFix(), bearingDeg: 35 }, { ...truthFix(), bearingDeg: -35 })
  await page.waitForTimeout(2500)
  // c. walk it in: 8 m → 4 m (≈ 6 steps).
  const walk = async (toM) => {
    world.walking = true
    await setDrive(page, { walking: true })
    while (world.distanceM > toM) {
      await page.waitForTimeout(500)
      world.distanceM -= STEP_M // 2 steps/s
    }
    world.walking = false
    await setDrive(page, { walking: false })
  }
  await walk(4)
  await waitPhase(page, ['walking'], 4000)
  await shot(page, '02-walking')
  // d. vision fails for a stretch: found:false → engine must fall back to the surveyed door.
  // Fallback needs FALLBACK_AFTER misses AND a stale anchor (> 8 s), so hold still up to 25 s.
  for (let i = 0; i < 30; i++) overrides.push(NOT_FOUND())
  await walk(2.5)
  const srcNote = page.locator('.apr-src:visible').filter({ hasText: FROM_MAP })
  await srcNote.first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {})
  const fromMapShown = await srcNote.count().catch(() => 0)
  await shot(page, '03-osm-fallback')
  overrides.length = 0
  // e. threshold: under 1.5 m.
  await walk(1)
  const atThreshold = await waitPhase(page, ['threshold'], 8000)
  await shot(page, '04-threshold')
  // f. through: the demo script gets there by itself; the real engine cannot (see THROUGH_SKIP).
  const through = THROUGH_REACHABLE ? await waitPhase(page, ['through'], 12000) : false
  if (THROUGH_REACHABLE) await shot(page, '05-through')

  // g. "Noch draußen" overrides and guidance keeps running.
  const btn = page.locator('button.apr-big', { hasText: 'Noch draußen' }).first()
  const btnVisible = await btn.isVisible().catch(() => false)
  let keptRunning = false
  let afterNote = 'button not visible'
  if (btnVisible) {
    world.distanceM = 1
    const fixesBefore = doorFixLog.length
    const liveBefore = (await rec(page)).live.length
    await btn.click()
    await page.waitForTimeout(1000)
    const ph = await phaseOf(page) // right after the override: out of `through`
    await page.waitForTimeout(3000) // then: still asking vision / still talking
    const alive = await page.locator('section.apr').count()
    const r2 = await rec(page)
    const progressed = doorFixLog.length > fixesBefore || r2.live.length > liveBefore
    keptRunning = alive > 0 && ph !== 'through' && progressed
    afterNote = `phase ${ph}, +${doorFixLog.length - fixesBefore} door-fix, +${r2.live.length - liveBefore} announcements`
    await shot(page, '06-still-outside')
  }

  const r = await rec(page)
  const hits = (re) => r.live.reduce((n, x) => n + (x.match(new RegExp(re.source, 'g')) ?? []).length, 0)
  const safetyHits = hits(SAFETY)
  check('guide: safety line once and first', safetyHits === 1 && SAFETY.test(r.live[0] ?? ''), `first="${(r.live[0] ?? '').slice(0, 60)}", ${safetyHits}x`)

  const order = ['orienting', 'walking', 'threshold']
  const firstIdx = order.map((p) => r.phases.indexOf(p))
  const inOrder = firstIdx.every((i) => i >= 0) && firstIdx.every((i, k) => k === 0 || i > firstIdx[k - 1])
  check('guide: phases orienting→walking→threshold', inOrder, r.phases.join('→'))
  check('guide: threshold reached under 1.5 m', atThreshold || r.phases.includes('threshold'))
  const wrongPhases = r.outsideVisibleIn.filter((p) => p !== 'through')
  check('guide: "Noch draußen" never outside through', wrongPhases.length === 0, wrongPhases.length ? `also in ${wrongPhases.join(',')}` : '')
  if (THROUGH_REACHABLE) {
    check('guide: through after threshold', through && r.phases.lastIndexOf('through') > firstIdx[2], r.phases.join('→'))
    check('guide: "Noch draußen" visible in through', btnVisible)
    check('guide: "Noch draußen" keeps guidance running', keptRunning, afterNote)
  } else {
    skip('guide: through after threshold', THROUGH_SKIP)
    skip('guide: "Noch draußen" visible in through', THROUGH_SKIP)
    skip('guide: "Noch draußen" keeps guidance running', THROUGH_SKIP)
  }

  check('guide: osm-fallback shown when vision fails', fromMapShown > 0 || r.fromMapSeen > 0, `${fromMapShown} visible now, shown ${r.fromMapSeen}x`)
  const unsureHits = hits(UNSURE)
  check('guide: unstable fixes → unsure line once', unsureHits === 1, `${unsureHits}x`)
  check('guide: no geolocation during approach', r.geoDuringApproach === 0, `${r.geoDuringApproach} call(s) after open, ${r.geoTotal} total`)
  check('guide: engine asked vision', DEMO || doorFixLog.length > 0, `${doorFixLog.length} door-fix call(s), ${doorFixLog.filter((x) => !x.body.found).length} not found, ${r.stepsSent} steps sent`)
}
await page.context().close()

// ── 2. wheelchair: one verdict ──────────────────────────────────────────────
page = await newPage(WHEELCHAIR)
try {
  how = await reachApproach(page, 'check')
  const card = page.locator('.apr-card:visible').first()
  await card.waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(4000) // anything that would retry has had time to
  const rows = await card.locator('dt').count()
  const text = ((await card.innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  await shot(page, '07-wheelchair')
  check('wheelchair: card with three rows', rows === 3, `${how}; "${text.slice(0, 80)}"`)
  check('wheelchair: exactly one door-check request', doorCheckCalls === 1, `${doorCheckCalls}`)
  const r = await rec(page)
  check('wheelchair: no geolocation during check', r.geoDuringApproach === 0, `${r.geoDuringApproach}`)
} catch (e) {
  await shot(page, '07-wheelchair')
  check('wheelchair: card with three rows', false, String(e.message || e).split('\n')[0])
  check('wheelchair: exactly one door-check request', doorCheckCalls === 1, `${doorCheckCalls}`)
}
await page.context().close()

console.log('\n--- console/page errors ---')
console.log(errors.length ? [...new Set(errors)].join('\n') : '(none)')
const fails = results.filter((r) => !r.ok).length
const skips = results.filter((r) => r.skipped).length
console.log(`\n${results.length - fails - skips} passed, ${fails} failed, ${skips} skipped${DEMO ? ' (APPROACH_DEMO)' : ''}; screenshots in ${OUT}`)
await browser.close()
process.exit(fails)
