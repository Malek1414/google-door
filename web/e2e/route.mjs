// Regression cover for the route preview. Usage: node e2e/route.mjs [baseUrl]
//
// Every check here is one of the bugs in Malek's e21a687 ("roughly this way"):
//   1. no server key -> every route silently became a crow-flight "Ungefähr in diese Richtung"
//   2. routeTarget was set on one of three paths into drawRoute, so routing to a Google
//      POI kept the previous door and Start guided to that door
//   3. Start was omitted instead of disabled, sliding "Andere Türen" under the thumb
//   4. the route preview was wiped by a location tick or a data reload
//   5. /api/door-fix gave up on the first 429
//
// Scenarios (fresh browser context each, 402x874 touch, de-DE, geolocation Berlin Hbf):
//   mock   /api/route answers a recorded Routes response: door -> Route -> POI -> Route -> Start
//   slot   wheelchair profile, a door with steps (no guidance): Start keeps slot 1, disabled
//   retry  POI route fails once (quota), "Erneut versuchen", then tick + reload
//   real   no mocks, against the running backend (server proxy or the Maps JS fallback)
//   503    /api/route 503 and the browser Routes library blocked: a German error, no line
//   503js  /api/route 503, browser Routes library allowed: a route or an error, never a guess
//   429    ?sim=1 -> arrival -> "Zum Eingang führen"; /api/door-fix 429 twice, then 200
//
// A check that depends on work still in progress (steps panel, error UI) prints PENDING
// with the reason when the feature is not in the DOM at all; if the feature is there and
// wrong, it is a FAIL. Env: PLAYWRIGHT_CORE, CHROME_PATH as in smoke.mjs; ROUTE_ONLY=mock,429
// runs a subset; ROUTE_ASSETS_FROM=https://localhost:5199 serves the app files from an
// older build (same origin, so the Maps key still works) to prove the checks bite.
// Exit code = number of FAILs.
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
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ONLY = (process.env.ROUTE_ONLY || '').split(',').filter(Boolean)
const runs = (name) => !ONLY.length || ONLY.includes(name)
const ASSETS_FROM = (process.env.ROUTE_ASSETS_FROM || '').replace(/\/+$/, '')

const HBF = { latitude: 52.5249, longitude: 13.3688 }
const CROW = /Ungefähr in diese Richtung|Roughly this way/
const ROUTE_BLUE = '#1a73e8'
// Directions.ts D.de: every reason the sheet may give instead of a route.
const GERMAN_REASON = /Route gerade nicht verfügbar|nicht freigeschaltet|Keine Verbindung zur Routenberechnung|Zu viele Routenanfragen|konnte nicht berechnet werden|keine Fußgängerroute/

// Recorded from the Routes API (walking, de-DE) around Berlin Hbf, in the shape the
// /api/route proxy returns it (server/route.py: path decoded, steps flattened).
// The path is re-anchored onto the tapped door at run time, so the far end is real.
const RECORDED = {
  found: true,
  distanceM: 250,
  duration: '206s',
  path: [
    [52.52490, 13.36880], [52.52512, 13.36884], [52.52541, 13.36889], [52.52578, 13.36893],
    [52.52580, 13.36921], [52.52583, 13.36952], [52.52563, 13.36958], [52.52545, 13.36962],
    [52.52541, 13.37010], [52.52537, 13.37043],
  ],
  steps: [
    { distanceM: 99, maneuver: 'DEPART', text: 'Auf Ella-Trebe-Straße nach Norden', endLat: 52.52578, endLon: 13.36893 },
    { distanceM: 19, maneuver: 'TURN_RIGHT', text: 'Rechts abbiegen auf Europaplatz', endLat: 52.52583, endLon: 13.36952 },
    { distanceM: 23, maneuver: 'TURN_LEFT', text: 'Links Richtung Invalidenstraße abbiegen', endLat: 52.52545, endLon: 13.36962 },
    { distanceM: 109, maneuver: 'TURN_RIGHT', text: 'Rechts abbiegen auf Invalidenstraße\nDas Ziel befindet sich rechts', endLat: 52.52537, endLon: 13.37043 },
  ],
}
/** The recording, bent so it starts where it was asked from and ends at the door asked for. */
function recordedTo(req) {
  const p = RECORDED.path
  const [a0, o0] = p[0]
  const [a1, o1] = p[p.length - 1]
  const path = p.map(([la, lo], i) => {
    const f = i / (p.length - 1)
    return [+(la + (req.fromLat - a0) * (1 - f) + (req.toLat - a1) * f).toFixed(6), +(lo + (req.fromLon - o0) * (1 - f) + (req.toLon - o1) * f).toFixed(6)]
  })
  return { ...RECORDED, path }
}

// ── results ─────────────────────────────────────────────────────────────────
const results = []
function check(name, ok, note = '') {
  results.push({ name, status: ok ? 'PASS' : 'FAIL' })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `  (${note})` : ''}`)
}
/** PENDING when the feature is not in the DOM yet (another agent is building it). */
function pendingOr(name, present, ok, reason, note = '') {
  if (!present) {
    results.push({ name, status: 'PENDING' })
    console.log(`PENDING ${name}  (${reason})`)
    return
  }
  check(name, ok, note)
}

// ── page-side instrumentation ───────────────────────────────────────────────
// Records every google.maps.Polyline the app creates, so a check can ask "is a real
// multi-point route on the map right now", which no DOM selector can answer.
function initScript({ mode, profile }) {
  try {
    if (mode) localStorage.setItem('doorway.mode', mode)
    if (profile) localStorage.setItem('doorway.profile', JSON.stringify(profile))
  } catch { /* ignored */ }
  window.__polys = []
  window.__geoTicks = 0
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
    } catch { /* read-only namespace: checks will report 0 lines */ }
    clearInterval(wrap)
  }, 10)
  const geo = navigator.geolocation
  if (geo) {
    const orig = geo.watchPosition.bind(geo)
    try {
      Object.defineProperty(geo, 'watchPosition', { configurable: true, value: (ok, ...rest) => orig((p) => { window.__geoTicks++; ok(p) }, ...rest) })
    } catch { /* ignored */ }
  }
}
const liveLines = (page) =>
  page.evaluate((blue) => (window.__polys || []).filter((p) => p.getMap()).map((p) => ({
    n: p.getPath().getLength(),
    // Walking dots (icons) today, a solid stroke in older builds: either way, blue.
    blue: [(p.get('icons') || [])[0]?.icon?.fillColor, p.get('strokeColor')].some((c) => String(c).toLowerCase() === blue),
  })), ROUTE_BLUE)
const routeLine = async (page) => (await liveLines(page)).filter((l) => l.blue).sort((a, b) => b.n - a.n)[0] ?? null

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--mute-audio', '--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const errors = []

async function newPage(tag, { mode = 'access', profile = null } = {}) {
  const ctx = await browser.newContext({
    locale: 'de-DE', viewport: { width: 402, height: 874 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    ignoreHTTPSErrors: true, geolocation: HBF, permissions: ['geolocation', 'camera'],
  })
  await ctx.addInitScript(initScript, { mode, profile })
  if (ASSETS_FROM) {
    // Mutation run: the page keeps BASE's origin (the Maps key is referrer-locked) but
    // every non-API file comes from an older build, to prove these checks catch the bugs.
    const origin = new URL(BASE).origin
    await ctx.route((u) => u.origin === origin && !u.pathname.startsWith('/api/'), async (route) => {
      const u = new URL(route.request().url())
      const res = await route.fetch({ url: ASSETS_FROM + u.pathname + u.search })
      await route.fulfill({ response: res })
    })
  }
  const page = await ctx.newPage()
  const routeCalls = []
  const entranceCalls = []
  page.on('request', (r) => {
    if (/\/api\/route\b/.test(r.url())) routeCalls.push(JSON.parse(r.postData() || '{}'))
    if (/\/api\/entrances\b|berlin-mitte\.json/.test(r.url())) entranceCalls.push(r.url())
  })
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${String(e).slice(0, 160)}`))
  return { ctx, page, routeCalls, entranceCalls }
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `route-${name}.png`) }).catch(() => {})

async function openMap(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.locator('.gm-tab').first().waitFor({ state: 'visible', timeout: 20000 })
  await page.locator('.gm-row').first().waitFor({ state: 'attached', timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1500)
}
async function raiseSheet(page) {
  const sheet = page.locator('.gm-sheet').first()
  for (let i = 0; i < 2 && (await sheet.getAttribute('data-state')) === 'peek'; i++) {
    await page.locator('.gm-handle').first().click().catch(() => {})
    await page.waitForTimeout(600)
  }
}
let unguidableCard = false
/** Nearest door in the list -> door card -> Route. Returns the door's name.
 *  Default: a named door, so "which door is Start guiding to" has an answer to compare.
 *  withSteps: a door marked "Nicht stufenlos", which a wheelchair profile may not be
 *  guided to. */
async function routeToFirstDoor(page, { withSteps = false } = {}) {
  await raiseSheet(page)
  const rows = page.locator('.gm-row:not(.pc-row):visible')
  const pick = withSteps
    ? page.locator('.gm-row.door-not-step-free:visible, .gm-row.door-no-marker:visible')
    : rows.filter({ hasNot: page.locator('.gm-row-title', { hasText: 'Eingang ohne Namen' }) })
  const row = (await pick.count()) ? pick.first() : rows.first()
  const name = ((await row.locator('.gm-row-title').textContent().catch(() => '')) || '').trim()
  await row.tap()
  unguidableCard = await page.locator('.gm-sheet .reason').first().isVisible({ timeout: 3000 }).catch(() => false)
  // The door card leads with Route, filled Google blue; it opens directions mode.
  const route = page.locator('.gm-sheet .gm-pill', { hasText: /^\s*\S*\s*Route\s*$/ }).first()
  await route.waitFor({ state: 'visible', timeout: 8000 })
  await route.tap()
  await page.locator('.dir-head').first().waitFor({ state: 'visible', timeout: 20000 })
  await page.waitForTimeout(800)
  return name
}
/** Slot 1 of the route actions. */
const startSlot = (page) =>
  page.locator('.dir-actions').first().evaluate((el) => {
    const b = el.children[0]
    return b ? { text: b.textContent.trim(), primary: b.classList.contains('dir-start'), disabled: b.disabled === true, ariaDisabled: b.getAttribute('aria-disabled') } : null
  }).catch(() => null)
const sheetText = (page) => page.locator('.gm-sheet').first().innerText().catch(() => '')
const summaryOk = (s) => /\d+\s*Min\./.test(s) && /\d+(,\d)?\s*k?m\b/.test(s)

/** Bug 4: move the user a few metres (a watchPosition tick), then pan the map (its idle
 *  event reloads /api/entrances). The route preview must still be there after both. */
async function survivesTickAndReload({ page, ctx, entranceCalls }, what, n) {
  const head0 = (await page.locator('.dir-sum').first().textContent().catch(() => '')) || ''
  const ticks0 = await page.evaluate(() => window.__geoTicks)
  await ctx.setGeolocation({ latitude: HBF.latitude + 0.00008 * n, longitude: HBF.longitude + 0.00005 * n })
  await page.waitForTimeout(2500)
  const ticked = (await page.evaluate(() => window.__geoTicks)) > ticks0
  const loads0 = entranceCalls.length
  const box = await page.locator('.gm-map').first().boundingBox()
  if (box) {
    const dir = n % 2 ? -1 : 1
    await page.mouse.move(box.x + box.width / 2, box.y + 160)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 140 * dir, box.y + 260, { steps: 8 })
    await page.mouse.up()
  }
  await page.waitForTimeout(3000)
  const reloads = entranceCalls.length - loads0
  await shot(page, `02-after-tick-reload-${n}`)
  const head = (await page.locator('.dir-sum').first().textContent().catch(() => '')) || ''
  const visible = await page.locator('.dir-head').first().isVisible().catch(() => false)
  const line = await routeLine(page)
  check(`${what}: a location tick reached the app`, ticked)
  check(`${what}: a data reload happened`, reloads > 0, `${reloads} reloads`)
  check(`${what}: route preview survives location tick + data reload`, visible && head === head0 && !!line && line.n >= RECORDED.path.length,
    `sheet ${visible ? `"${head}"` : 'wiped'}, line ${line ? line.n : 0} points`)
}

// ── 1. mocked /api/route: door, persistence, then a Google POI ──────────────
if (runs('mock')) {
  const { ctx, page, routeCalls, entranceCalls } = await newPage('mock')
  await ctx.route('**/api/route', async (route) => {
    const req = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(recordedTo(req)) })
  })
  let door = ''
  try {
    await openMap(page)
    door = await routeToFirstDoor(page)
    check('mock: door card -> Route opens the route preview', true, door)
  } catch (e) {
    check('mock: door card -> Route opens the route preview', false, String(e.message || e).split('\n')[0])
  }
  if (results.at(-1).status === 'PASS') {
    await shot(page, '01-door-route')
    const line = await routeLine(page)
    check('mock: a real multi-point route is drawn', !!line && line.n >= RECORDED.path.length, line ? `${line.n} points` : 'no blue line on the map')
    const head = (await page.locator('.dir-sum').first().textContent().catch(() => '')) || ''
    check('mock: sheet shows duration and distance', summaryOk(head), head)
    check('mock: no crow-flight "Ungefähr in diese Richtung"', !CROW.test(await sheetText(page)))
    const slot = await startSlot(page)
    check('mock: Start holds slot 1 on a door route', !!slot && slot.primary && /Start/.test(slot.text), JSON.stringify(slot))
    const stepsCount = await page.locator('.gm-sheet .dir-list .dir-step').count()
    pendingOr('mock: steps list shows every step plus arrival', stepsCount > 0, stepsCount === RECORDED.steps.length + 1,
      'agent A: steps panel (.dir-list) not rendered yet', `${stepsCount} rows`)

    // Bug 4: a location tick and a data reload must not wipe the preview.
    await survivesTickAndReload({ page, ctx, entranceCalls }, 'mock: door route', 1)

    // Bug 2: route to a Google POI; Start must not guide to the door from before.
    let poiOk = false
    try {
      // "Andere Türen": back to the map without clearing routeTarget by hand, which is
      // exactly how the stale door survived into the next route.
      await page.locator('.dir-more button', { hasText: 'Andere Türen' }).first().tap({ timeout: 8000 })
      await page.waitForTimeout(600)
      const modeChip = page.locator('.gm-chips button').first()
      if (!(await page.locator('[data-chip="kaffee"]').isVisible().catch(() => false))) await modeChip.tap()
      await page.locator('[data-chip="kaffee"]').first().tap()
      const poiRow = page.locator('.pc-row:visible').first()
      await poiRow.waitFor({ state: 'visible', timeout: 20000 })
      await poiRow.tap()
      const poiRoute = page.locator('.gm-sheet .gm-pill-primary', { hasText: /Route/ }).first()
      await poiRoute.waitFor({ state: 'visible', timeout: 15000 })
      const before = routeCalls.length
      await poiRoute.tap()
      await page.locator('.dir-head').first().waitFor({ state: 'visible', timeout: 20000 })
      await page.waitForTimeout(800)
      poiOk = routeCalls.length > before
    } catch (e) {
      await shot(page, '03-poi-failed')
      check('mock: Google POI -> Route opens the route preview', false, String(e.message || e).split('\n')[0])
    }
    if (poiOk) {
      await shot(page, '03-poi-route')
      await survivesTickAndReload({ page, ctx, entranceCalls }, 'mock: POI route', 2)
      const first = routeCalls[0]
      const last = routeCalls.at(-1)
      check('mock: POI route asks for the POI, not the door', Math.abs(last.toLat - first.toLat) + Math.abs(last.toLon - first.toLon) > 1e-5,
        `door ${first.toLat.toFixed(5)},${first.toLon.toFixed(5)} poi ${last.toLat.toFixed(5)},${last.toLon.toFixed(5)}`)
      const slot = await startSlot(page)
      check('mock: Start holds slot 1 on a POI route (disabled when not guidable)',
        !!slot && slot.primary && /Start/.test(slot.text) && (slot.disabled ? slot.ariaDisabled === 'true' : true), JSON.stringify(slot))
      // Tap Start the way a thumb would. Disabled: nothing may happen. Enabled: guidance
      // must name the POI's door, never the door routed to before.
      await page.locator('.dir-actions > :first-child').first().tap({ force: true, timeout: 3000 }).catch(() => {})
      const live = page.locator('#live-title')
      await live.waitFor({ state: 'attached', timeout: 4000 }).catch(() => {})
      const title = ((await live.textContent().catch(() => '')) || '').trim()
      await shot(page, '04-poi-start')
      check('mock: Start after a POI route never guides to the previous door',
        !title || (door && !title.includes(door)), title ? `guiding: ${title}` : slot?.disabled ? 'Start disabled, no guidance' : 'no guidance opened')
    }
  }
  await ctx.close()
}

// ── 1b. a door that cannot carry guidance: Start stays in slot 1, disabled (bug 3) ──
if (runs('slot')) {
  const { ctx, page } = await newPage('slot', { profile: { stepFreeRequired: true, channels: ['visual'] } })
  await ctx.route('**/api/route', async (route) => {
    const req = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(recordedTo(req)) })
  })
  try {
    await openMap(page)
    // The wheelchair profile may preset "Stufenlos"; clear the door filters so doors
    // with steps are listed at all.
    for (const chip of await page.locator('.gm-chips button[aria-pressed="true"]:not([data-chip])').all()) {
      if (!/Barrierefrei/.test((await chip.textContent()) || '')) await chip.tap().catch(() => {})
    }
    await page.waitForTimeout(500)
    const door = await routeToFirstDoor(page, { withSteps: true })
    await shot(page, '08-unguidable-door')
    check('slot: setup: the door card says this door cannot be guided to', unguidableCard, door)
    const labels = await page.locator('.dir-actions > *').evaluateAll((els) => els.map((b) => b.textContent.trim()))
    const slot = await startSlot(page)
    check('slot: Start is slot 1 on a door without guidance, not omitted', !!slot && /Start/.test(slot.text), `${door}: [${labels.join(' | ')}]`)
    check('slot: that Start is disabled, and says so to a screen reader', !!slot && slot.disabled && slot.ariaDisabled === 'true', JSON.stringify(slot))
    check('slot: "Andere Türen" never slides into slot 1', !/Andere Türen/.test(labels[0] ?? ''))
    await page.locator('.dir-actions > :first-child').first().tap({ force: true, timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(1500)
    check('slot: tapping the disabled Start neither guides nor leaves the preview',
      (await page.locator('#live-title').count()) === 0 && (await page.locator('.dir-head').first().isVisible().catch(() => false)))
  } catch (e) {
    check('slot: unguidable door -> Route opens the route preview', false, String(e.message || e).split('\n')[0])
  }
  await ctx.close()
}

// ── 1c. POI route fails once, "Erneut versuchen" succeeds, then tick + reload ──
// The retry redraws with the sheet already re-rendered, so neither `selected` nor
// `placeOpen` protects the preview: only the routePreview guard does (bug 4).
if (runs('retry')) {
  const { ctx, page, entranceCalls } = await newPage('retry', { mode: 'standard' })
  let calls = 0
  await ctx.route('**/api/route', async (route) => {
    calls++
    if (calls === 1) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ detail: { code: 'quota', status: 429 } }) })
    const req = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(recordedTo(req)) })
  })
  await ctx.route(/routes\.googleapis\.com|RoutesService|ComputeRoutes/i, (route) => route.abort())
  try {
    await openMap(page)
    await page.locator('[data-chip="kaffee"]').first().tap()
    const poiRow = page.locator('.pc-row:visible').first()
    await poiRow.waitFor({ state: 'visible', timeout: 20000 })
    await poiRow.tap()
    const poiRoute = page.locator('.gm-sheet .gm-pill-primary', { hasText: /Route/ }).first()
    await poiRoute.waitFor({ state: 'visible', timeout: 15000 })
    await poiRoute.tap()
    await page.locator('.dir-head').first().waitFor({ state: 'visible', timeout: 20000 })
    await page.waitForTimeout(800)
    const text = await sheetText(page)
    const retry = page.locator('.dir-more button', { hasText: 'Erneut versuchen' }).first()
    const hasRetry = await retry.isVisible().catch(() => false)
    check('retry: a failed POI route is never a crow-flight guess', !CROW.test(text))
    pendingOr('retry: quota failure says "Zu viele Routenanfragen" and offers a retry', hasRetry, /Zu viele Routenanfragen/.test(text),
      'agent A: route error UI not rendered yet', text.split('\n').slice(0, 3).join(' | '))
    if (hasRetry) {
      await retry.tap()
      await page.locator('.dir-sum', { hasText: 'Min.' }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(800)
      const line = await routeLine(page)
      check('retry: "Erneut versuchen" draws the route', !!line && line.n >= RECORDED.path.length, line ? `${line.n} points` : 'no line')
      await survivesTickAndReload({ page, ctx, entranceCalls }, 'retry: POI route after retry', 3)
    }
  } catch (e) {
    check('retry: POI -> Route opens the route preview', false, String(e.message || e).split('\n')[0])
  }
  await ctx.close()
}

// ── 2. real backend, no mocks ───────────────────────────────────────────────
if (runs('real')) {
  const { ctx, page, routeCalls } = await newPage('real')
  try {
    await openMap(page)
    const door = await routeToFirstDoor(page)
    await page.waitForTimeout(2500)
    await shot(page, '05-real-route')
    const line = await routeLine(page)
    const head = (await page.locator('.dir-sum').first().textContent().catch(() => '')) || ''
    check('real: backend route is a real multi-point line', !!line && line.n >= 3, `${door}: ${line ? line.n : 0} points, ${routeCalls.length} /api/route call(s)`)
    check('real: sheet shows duration and distance', summaryOk(head), head)
    check('real: no crow-flight "Ungefähr in diese Richtung"', !CROW.test(await sheetText(page)))
    // "Route entfernen" must take the route off the map AND out of the sheet.
    await page.locator('.dir-head-btns button').last().tap({ timeout: 8000 })
    await page.waitForTimeout(1200)
    const headLeft = await page.locator('.dir-head').count()
    const lineLeft = await routeLine(page)
    check('real: "Route entfernen" clears the line from the map', !lineLeft, lineLeft ? `${lineLeft.n} points still drawn` : '')
    check('real: "Route entfernen" clears the route summary from the sheet', headLeft === 0,
      headLeft ? 'stale "N Min. · m" header left in the sheet while a door card is open' : '')
  } catch (e) {
    check('real: door card -> Route opens the route preview', false, String(e.message || e).split('\n')[0])
  }
  await ctx.close()
}

// ── 3. /api/route 503, no browser fallback: a German reason, never a guess ──
async function run503(tag, blockBrowser) {
  const { ctx, page } = await newPage(tag)
  await ctx.route('**/api/route', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ detail: { code: 'not_configured', message: 'ROUTES_API_KEY / MAPS_API_KEY not configured' } }),
  }))
  // The Maps JS Routes library is the second path (Directions.ts viaMapsJs).
  if (blockBrowser) await ctx.route(/routes\.googleapis\.com|RoutesService|ComputeRoutes/i, (route) => route.abort())
  try {
    await openMap(page)
    await routeToFirstDoor(page)
    await page.waitForTimeout(2500)
    await shot(page, `06-${tag}`)
    const text = await sheetText(page)
    const line = await routeLine(page)
    const errEl = page.locator('.gm-sheet .dir-error').first()
    const errShown = await errEl.isVisible().catch(() => false)
    check(`${tag}: no crow-flight "Ungefähr in diese Richtung"`, !CROW.test(text))
    if (blockBrowser) {
      check(`${tag}: no line posing as a route`, !line || line.n < 2, line ? `${line.n} points` : 'nothing drawn')
      pendingOr(`${tag}: a visible German reason instead of a route`, errShown, GERMAN_REASON.test(text) && /Keine Route/.test(text),
        'agent A: route error UI ([role=alert] in the sheet) not rendered yet', text.split('\n').slice(0, 3).join(' | '))
      const retry = await page.locator('.dir-more button', { hasText: 'Erneut versuchen' }).count()
      pendingOr(`${tag}: offers "Erneut versuchen"`, errShown, retry === 1, 'agent A: route error UI not rendered yet')
    } else {
      const drawn = !!line && line.n >= 3
      check(`${tag}: browser fallback draws a real route or says why`, drawn || (errShown && GERMAN_REASON.test(text)),
        drawn ? `${line.n} points via Maps JS` : text.split('\n')[0])
    }
    const slot = await startSlot(page)
    check(`${tag}: Start still holds slot 1`, !!slot && slot.primary && /Start/.test(slot.text), JSON.stringify(slot))
  } catch (e) {
    check(`${tag}: door card -> Route opens the route preview`, false, String(e.message || e).split('\n')[0])
  }
  await ctx.close()
}
if (runs('503')) await run503('503', true)
if (runs('503js')) await run503('503js', false)

// ── 4. /api/door-fix 429 twice, then 200: guidance continues ────────────────
if (runs('429')) {
  const BLIND = { stepFreeRequired: false, channels: ['speech', 'visual'] }
  const { ctx, page } = await newPage('429', { mode: null, profile: BLIND })
  const fixLog = []
  await ctx.route('**/api/door-fix**', async (route) => {
    fixLog.push({ ts: Date.now() })
    if (fixLog.length <= 2) return route.fulfill({ status: 429, contentType: 'application/json', body: '{"detail":"gemini 429"}' })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ found: true, bearingDeg: -15, distanceM: 6, confidence: 0.9, kind: 'sliding', note: 'Glastür', inside: false, ts: Date.now(), source: 'gemini-frame' }) })
  })
  await ctx.route('**/api/door-check**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"step":false,"widthCm":92,"opens":"automatic","note":"","confidence":0.9}' }))
  await ctx.route('**/api/live-token**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"disabled in e2e"}' }))
  await ctx.route('**/api/speak**', (route) => route.fulfill({ status: 503, body: '' }))
  // Compass, so the engine has a heading to send with each frame.
  await ctx.addInitScript(() => {
    setInterval(() => {
      const ev = new Event('deviceorientation')
      for (const [k, v] of Object.entries({ alpha: 260, beta: 80, gamma: 0, absolute: false, webkitCompassHeading: 100, webkitCompassAccuracy: 10 })) Object.defineProperty(ev, k, { value: v })
      window.dispatchEvent(ev)
      const abs = new Event('deviceorientationabsolute')
      for (const [k, v] of Object.entries({ alpha: 260, beta: 80, gamma: 0, absolute: true })) Object.defineProperty(abs, k, { value: v })
      window.dispatchEvent(abs)
    }, 50)
  })
  let reached = false
  try {
    await page.goto(`${BASE}?sim=1&speed=20`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const trigger = page.locator('button.apr-trigger:visible, button.arrival-yes:visible').first()
    const deadline = Date.now() + 90000
    let clicks = 0
    while (Date.now() < deadline && !reached) {
      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click()
        await page.locator('section.apr').first().waitFor({ state: 'visible', timeout: 10000 })
        reached = true
        break
      }
      const next = page.locator('button:visible').filter({ hasText: /^(weiter|los|start|starten|fertig|ok|verstanden)/i }).first()
      if (clicks < 20 && (await next.count())) await next.click({ timeout: 2000 }).then(() => { clicks++ }).catch(() => {})
      await page.waitForTimeout(1000)
    }
    check('429: approach screen opens', reached, reached ? '' : 'no "Zum Eingang führen" within 90 s')
  } catch (e) {
    check('429: approach screen opens', false, String(e.message || e).split('\n')[0])
  }
  if (reached) {
    const arrow = page.locator('section.apr .apr-dir').first()
    const end = Date.now() + 25000
    let arrowOn = false
    while (Date.now() < end && !(fixLog.length >= 4 && arrowOn)) {
      await page.waitForTimeout(500)
      arrowOn = await arrow.isVisible().catch(() => false)
    }
    await shot(page, '07-doorfix-429')
    check('429: door-fix is asked again after a 429', fixLog.length >= 3, `${fixLog.length} calls`)
    check('429: guidance continues once door-fix answers 200 (arrow shown)', arrowOn,
      `phase ${await page.locator('section.apr').first().getAttribute('data-phase').catch(() => '?')}`)
  }
  await ctx.close()
}

await browser.close()
if (errors.length) console.log(`\npage errors:\n  ${errors.join('\n  ')}`)
const count = (s) => results.filter((r) => r.status === s).length
console.log(`\n${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('PENDING')} PENDING`)
process.exit(count('FAIL'))
