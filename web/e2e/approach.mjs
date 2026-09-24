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
const STOP_SHORT_M = Number(process.env.STOP_SHORT_M || 0)
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Words the screen must show (ui/Approach.ts AP, core/instruct.ts).
const SAFETY = /Ich führe dich nur zur Tür/
const UNSURE = /Ich bin mir gerade unsicher/
const FROM_MAP = /Richtung aus der Karte/
const NO_DIRECTION = /Ich sehe den Eingang nicht und habe keine Richtung dafür/
const PROFILE_KEY = 'doorway.profile'
const BLIND = { stepFreeRequired: false, channels: ['speech', 'visual'] }
const WHEELCHAIR = { stepFreeRequired: true, channels: ['visual'] }

// ── world model for the mocked vision ───────────────────────────────────────
// The door sits at compass 60°. Its distance shrinks while the harness "walks".
// /api/door-fix answers from this truth unless an override is queued.
const DOOR_COMPASS = 60
const SIM_DOOR = 'node/10795939972' // config.ts DEFAULT_SIM_DOOR
const STEP_M = 0.68
const world = { heading: 100, distanceM: 8, walking: false, visionFails: false, surveyBearing: true }
const overrides = [] // DoorFix bodies served before falling back to the truth
const doorFixLog = [] // { ts, heading, body }
let doorCheckCalls = 0
// `through` is PROPOSED two ways (CONTRACT § Phases, 0c88afc):
//   DoorFix.inside  explicit true at confidence >= 0.6 (0.55 must not count)
//   stillness       no steps for STILL_MS = 4 s while in `threshold`
// "Noch draußen" takes either back and restarts the stillness clock.
const STILL_MS = 4000

const rel = (compass, heading) => ((((compass - heading) % 360) + 540) % 360) - 180
function truthFix() {
  return {
    found: true,
    bearingDeg: Math.round(rel(DOOR_COMPASS, world.heading) * 10) / 10,
    distanceM: Math.max(0.3, Math.round(world.distanceM * 10) / 10),
    confidence: 0.88,
    kind: 'sliding',
    note: 'Glastür',
    inside: false,
    ts: Date.now(),
    source: 'gemini-frame',
  }
}
const NOT_FOUND = () => ({ found: false, bearingDeg: 0, distanceM: 0, confidence: 0.1, kind: 'unknown', note: '', inside: false, ts: Date.now(), source: 'gemini-frame' })

const INSIDE = (confidence) => ({ ...truthFix(), inside: true, confidence })

// ── page-side instrumentation (runs before the app) ─────────────────────────
function initScript({ profileKey, profile }) {
  try { localStorage.setItem(profileKey, JSON.stringify(profile)) } catch { /* ignored */ }
  const rec = { live: [], phases: [], phaseAt: [], arrowShownAt: [], outsideVisibleIn: [], fromMapSeen: 0, geoTotal: 0, geoDuringApproach: 0, aprSeen: false, stepsSent: 0 }
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
      const dir = apr?.querySelector('.apr-dir')
      const arrowOn = !!(dir && !dir.hidden && !dir.closest('[hidden]'))
      if (arrowOn && !rec.arrowVisible) rec.arrowShownAt.push(Date.now())
      rec.arrowVisible = arrowOn
      const ph = apr?.getAttribute('data-phase')
      if (ph && rec.phases[rec.phases.length - 1] !== ph) {
        rec.phases.push(ph)
        rec.phaseAt.push(Date.now())
        const btn = apr.querySelector('.apr-big')
        if (btn && !btn.hidden) rec.outsideVisibleIn.push(ph)
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase', 'hidden'] })
  }
  if (document.body) watchDom()
  else document.addEventListener('DOMContentLoaded', watchDom)

  // Sensor driver: compass + pitch at 20 Hz, motion at 50 Hz.
  // motion:false stops devicemotion entirely (the stillness route); walking:false still
  // sends flat noise, as a phone held by a standing person does.
  const drive = { heading: 100, beta: 80, walking: false, stepHz: 2, motion: true }
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
    if (!drive.motion) return
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
  args: ['--mute-audio', '--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const results = []
function check(name, ok, note = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `  (${note})` : ''}`)
}
/** Real engine: a check. Demo engine: SKIP with the reason, never a fake PASS or FAIL. */
function realOnly(reason, name, ok, note = '') {
  if (!DEMO) return check(name, ok, note)
  results.push({ name, ok: true, skipped: true })
  console.log(`SKIP ${name}  (demo: ${reason})`)
}
const NO_FIX_CALLS = 'the scripted demo makes no door-fix calls'
const errors = []

async function newPage(profile) {
  const ctx = await browser.newContext({
    locale: 'de-DE', viewport: { width: 430, height: 932 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    ignoreHTTPSErrors: true, geolocation: { latitude: 52.5249, longitude: 13.3688 }, permissions: ['geolocation', 'camera'],
  })
  await ctx.addInitScript(initScript, { profileKey: PROFILE_KEY, profile })
  // Vision: scripted. Live token: refused, so the engine takes the per-frame path.
  await ctx.route('**/api/door-fix**', async (route) => {
    const body = overrides.length ? overrides.shift() : world.visionFails ? NOT_FOUND() : truthFix()
    doorFixLog.push({ ts: Date.now(), heading: world.heading, body })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await ctx.route('**/api/door-check**', async (route) => {
    doorCheckCalls++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ step: false, widthCm: 92, opens: 'automatic', note: 'Schiebetür', confidence: 0.9 }) })
  })
  // The sim door (Hbf, node/10795939972) has no surveyed approachBearing, so the map
  // fallback could never fire. Give it one that matches the scripted world, except in
  // the no-direction scenario, which needs exactly that gap.
  if (world.surveyBearing) await ctx.route('**/data/berlin-mitte.json', async (route) => {
    const res = await route.fetch()
    const d = await res.json()
    const list = Array.isArray(d) ? d : d.entrances ?? []
    for (const e of list) if (e.id === SIM_DOOR && e.approachBearing == null) e.approachBearing = DOOR_COMPASS
    await route.fulfill({ response: res, body: JSON.stringify(d), headers: { ...res.headers(), 'content-type': 'application/json' } })
  })
  // STOP_SHORT_M=10: the sim walk ends that far from the door, as real GPS near a
  // building does. The arrival card never appears; the Live View panel trigger must.
  if (STOP_SHORT_M > 0) await ctx.route('**/tracks/*.json', async (route) => {
    const res = await route.fetch()
    const pts = await res.json()
    const door = { lat: 52.52721, lon: 13.371167 }
    const m = (p) => Math.hypot((p.lat - door.lat) * 111195, (p.lon - door.lon) * 111195 * Math.cos((door.lat * Math.PI) / 180))
    const cut = pts.findIndex((p) => m(p) < STOP_SHORT_M)
    await route.fulfill({ response: res, body: JSON.stringify(cut > 1 ? pts.slice(0, cut) : pts), headers: { ...res.headers(), 'content-type': 'application/json' } })
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

/** ?sim=1 → Start → "Zum Eingang führen" (Live View panel from 25 m, or the arrival card). Returns how it got there. */
async function reachApproach(page, directParam) {
  if (DEMO) {
    await page.goto(`${BASE}?approach=${directParam}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.locator('section.apr').first().waitFor({ state: 'visible', timeout: 15000 })
    return `?approach=${directParam}`
  }
  await page.goto(`${BASE}?sim=1&speed=20`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const trigger = page.locator('button.apr-trigger:visible, button.arrival-yes:visible').first()
  const deadline = Date.now() + 90000
  let clicks = 0
  while (Date.now() < deadline) {
    if (await trigger.isVisible().catch(() => false)) {
      await shot(page, `00-arrival-${directParam === 'demo' ? 'guide' : 'check'}`)
      await trigger.click()
      await page.locator('section.apr').first().waitFor({ state: 'visible', timeout: 10000 })
      const where = (await page.locator('.arrival').count()) ? 'arrival card' : 'live view panel'
      return `sim ${where} after ${clicks} start click(s)`
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
  // e. threshold: under 1.5 m. Keep stepping in place from here on, so the stillness
  //    route cannot fire while the vision route is under test.
  await walk(1)
  world.walking = true
  await setDrive(page, { walking: true })
  const atThreshold = await waitPhase(page, ['threshold'], 8000)
  await shot(page, '04-threshold')

  // f. hedged interior: inside:true at confidence 0.55 must NOT propose `through`.
  const hedgedFrom = doorFixLog.length
  for (let i = 0; i < 12; i++) overrides.push(INSIDE(0.55))
  const hedgedPhasesFrom = (await rec(page)).phases.length
  await page.waitForTimeout(DEMO ? 1000 : 7000)
  const hedgedServed = doorFixLog.slice(hedgedFrom).filter((x) => x.body.inside && x.body.confidence < 0.6).length
  const hedgedPhases = (await rec(page)).phases.slice(hedgedPhasesFrom)
  overrides.length = 0

  // g. vision route: inside:true at confidence 0.8 → `through`, while still stepping.
  for (let i = 0; i < 12; i++) overrides.push(INSIDE(0.8))
  const visionThrough = await waitPhase(page, ['through'], DEMO ? 20000 : 10000)
  const insideServed = doorFixLog.filter((x) => x.body.inside && x.body.confidence >= 0.6).length
  overrides.length = 0
  await shot(page, '05-through-vision')
  const btn = page.locator('button.apr-big', { hasText: 'Noch draußen' }).first()
  const btnVisible = visionThrough && (await btn.isVisible().catch(() => false))

  // h. "Noch draußen": back to threshold, guidance keeps running, and standing there
  //    does not re-propose within STILL_MS (the clock restarted on the press).
  world.walking = false
  await setDrive(page, { walking: false, motion: false })
  let keptRunning = false
  let reproposed = true
  let afterNote = 'button not visible'
  let pressedAt = 0
  if (btnVisible) {
    world.distanceM = 1
    const fixesBefore = doorFixLog.length
    const liveBefore = (await rec(page)).live.length
    await btn.click()
    pressedAt = Date.now()
    await page.waitForTimeout(1000)
    const ph = await phaseOf(page)
    await page.waitForTimeout(STILL_MS - 1500) // still inside the fresh stillness window
    const phNow = await phaseOf(page)
    const r2 = await rec(page)
    const progressed = doorFixLog.length > fixesBefore || r2.live.length > liveBefore
    keptRunning = (await page.locator('section.apr').count()) > 0 && ph === 'threshold' && progressed
    reproposed = r2.phaseAt.some((t, k) => t > pressedAt && r2.phases[k] === 'through')
    afterNote = `phase ${ph} then ${phNow}, +${doorFixLog.length - fixesBefore} door-fix, +${r2.live.length - liveBefore} announcements`
    await shot(page, '06-still-outside')
  }

  // i. stillness route: no motion at all, no inside flag → `through` after STILL_MS.
  const stillThrough = pressedAt ? await waitPhase(page, ['through'], STILL_MS + 6000) : false
  const r3 = await rec(page)
  const stillAt = r3.phaseAt.find((t, k) => t > pressedAt && r3.phases[k] === 'through')
  const stillAfterMs = stillAt ? stillAt - pressedAt : null
  const insideDuringStill = doorFixLog.some((x) => x.ts > pressedAt && x.body.inside)
  if (stillThrough) await shot(page, '06b-through-stillness')

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
  realOnly(NO_FIX_CALLS, 'guide: inside at 0.55 does not propose through', hedgedServed > 0 && !hedgedPhases.includes('through'), `${hedgedServed} hedged fix(es) served, phases ${hedgedPhases.join('→') || '(none)'}`)
  realOnly(NO_FIX_CALLS, 'guide: inside at 0.8 proposes through', visionThrough && insideServed > 0 && r.phases.lastIndexOf('through') > firstIdx[2], `${insideServed} inside fix(es) served; ${r.phases.join('→')}`)
  check('guide: "Noch draußen" visible in through', btnVisible)
  check('guide: "Noch draußen" → threshold, guidance keeps running', keptRunning, afterNote)
  check('guide: not re-proposed right after "Noch draußen"', pressedAt > 0 && !reproposed)
  check('guide: stillness > 4 s at threshold proposes through', stillThrough && stillAfterMs !== null && stillAfterMs >= STILL_MS - 300 && !insideDuringStill,
    `${stillAfterMs === null ? 'never' : `${stillAfterMs} ms after press`}${insideDuringStill ? ', but an inside fix was served' : ''}`)

  check('guide: osm-fallback shown when vision fails', fromMapShown > 0 || r.fromMapSeen > 0, `${fromMapShown} visible now, shown ${r.fromMapSeen}x`)
  const unsureHits = hits(UNSURE)
  check('guide: unstable fixes → unsure line once', unsureHits === 1, `${unsureHits}x`)
  check('guide: no geolocation during approach', r.geoDuringApproach === 0, `${r.geoDuringApproach} call(s) after open, ${r.geoTotal} total`)
  realOnly(NO_FIX_CALLS, 'guide: engine asked vision', doorFixLog.length > 0, `${doorFixLog.length} door-fix call(s), ${doorFixLog.filter((x) => !x.body.found).length} not found, ${r.stepsSent} steps sent`)
}
await page.context().close()

// ── 2. no direction: vision fails and the door has no surveyed bearing ───────
// A short run of good fixes, then only found:false. The sim door is NOT patched here,
// so there is nothing honest to point at: the engine must say so once and hide the arrow.
Object.assign(world, { heading: 60, distanceM: 8, walking: false, visionFails: false, surveyBearing: false })
overrides.length = 0
doorFixLog.length = 0
page = await newPage(BLIND)
try {
  how = await reachApproach(page, 'demo')
  await page.waitForTimeout(3000)
  world.visionFails = true
  const failFrom = Date.now()
  // Stale anchor (> 8 s) plus FALLBACK_AFTER misses, then time to (not) repeat itself.
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const r = await rec(page)
    if (r.live.some((x) => NO_DIRECTION.test(x))) break
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(6000)
  await shot(page, '08-no-direction')
  const r = await rec(page)
  const n = r.live.reduce((k, x) => k + (x.match(new RegExp(NO_DIRECTION.source, 'g')) ?? []).length, 0)
  const lineAt = Date.now()
  const arrowNow = r.arrowVisible
  const misses = doorFixLog.filter((x) => x.ts >= failFrom && !x.body.found).length
  check('no-direction: line spoken once', n === 1, `${n}x, ${misses} not-found fix(es), ${how}`)
  realOnly('the script shows no-direction only in its first step, then moves on (unit test covers the layout)', 'no-direction: no arrow', !arrowNow && !r.fromMapSeen, `arrow ${arrowNow ? 'visible' : 'hidden'} at ${lineAt - failFrom} ms, map note shown ${r.fromMapSeen}x`)
} catch (e) {
  await shot(page, '08-no-direction')
  check('no-direction: line spoken once', false, String(e.message || e).split('\n')[0])
}
await page.context().close()
world.surveyBearing = true

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
