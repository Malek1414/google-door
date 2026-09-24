// Seeded random-walk monkey test over the real map UI. Usage:
//   node e2e/fuzz.mjs [baseUrl]            (default https://localhost:5173/)
//   FUZZ_SEEDS=1,2,3 FUZZ_ACTIONS=600 node e2e/fuzz.mjs
// Phone viewport 402x874, touch, de-DE, geolocation Berlin Hbf. Each seed gets a fresh
// browser context. After every action it checks the invariants listed in README.md and
// prints one line per violation; the exit code is the number of violations.
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
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SEEDS = (process.env.FUZZ_SEEDS || '1,2,3').split(',').map(Number)
const ACTIONS = Number(process.env.FUZZ_ACTIONS || 600)
const VERBOSE = !!process.env.FUZZ_VERBOSE
const HOME = { latitude: 52.5249, longitude: 13.3688 }

// Bounds for the leak invariants.
const MAX_MARKERS = 700 // every door in a zoom-17 view plus places, route and me
const MAX_INTERVALS = 8
const MAX_WIN_LISTENER_GROWTH = 40
const BANNER_WITHIN_MS = 9000 // a failed /api call shows the snackbar within this
const BANNER_CLEAR_MS = 9000 // a good /api call after the fault clears it within this

function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Page-side instrumentation: intervals, window/document listeners, long tasks, Maps
// markers and maps (wrapped the moment the Maps callback fires), first tile paint.
const INIT = () => {
  const w = window
  const F = (w.__fuzz = { intervals: new Set(), winListeners: 0, byType: {}, longTasks: [], markers: new Set(), maps: [], polylines: new Set(), firstTiles: null, mapsReady: null })
  const si = w.setInterval.bind(w)
  const ci = w.clearInterval.bind(w)
  w.setInterval = (...a) => {
    const id = si(...a)
    // Vite's dev client polls for its socket while offline; that is the harness's server.
    if (/@vite\/client/.test(String(new Error().stack).split('\n').slice(2, 3).join(''))) return id
    F.intervals.add(id)
    ;(F.where ||= {})[id] = String(new Error().stack).split('\n').slice(2, 4).map((l) => l.trim().replace(/\?[^:)]*/, '')).join(' < ')
    return id
  }
  w.clearInterval = (id) => {
    F.intervals.delete(id)
    return ci(id)
  }
  const add = EventTarget.prototype.addEventListener
  const rem = EventTarget.prototype.removeEventListener
  const seen = new WeakMap()
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    if ((this === w || this === document) && fn) {
      let m = seen.get(this)
      if (!m) seen.set(this, (m = new Map()))
      const k = `${type}|${typeof o === 'boolean' ? o : !!o?.capture}`
      let fs = m.get(k)
      if (!fs) m.set(k, (fs = new Set()))
      if (!fs.has(fn)) {
        fs.add(fn)
        F.winListeners++
        F.byType[type] = (F.byType[type] || 0) + 1
        ;(F.lwhere ||= {})[type] = String(new Error().stack).split('\n')[2]?.trim().replace(/\?[^:)]*/, '')
      }
    }
    return add.call(this, type, fn, o)
  }
  EventTarget.prototype.removeEventListener = function (type, fn, o) {
    if ((this === w || this === document) && fn) {
      const fs = seen.get(this)?.get(`${type}|${typeof o === 'boolean' ? o : !!o?.capture}`)
      if (fs?.delete(fn)) {
        F.winListeners--
        F.byType[type]--
      }
    }
    return rem.call(this, type, fn, o)
  }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) F.longTasks.push({ at: e.startTime, ms: e.duration })
    }).observe({ type: 'longtask', buffered: true })
  } catch { /* no longtask support */ }
  const wrap = () => {
    const g = w.google?.maps
    if (!g || g.__fuzzWrapped) return
    g.__fuzzWrapped = true
    F.mapsReady = performance.now()
    const M = g.Marker
    g.Marker = class extends M {
      constructor(o) {
        super(o)
        F.markers.add(this)
      }
    }
    const P = g.Polyline
    g.Polyline = class extends P {
      constructor(o) {
        super(o)
        F.polylines.add(this)
      }
    }
    const Mp = g.Map
    g.Map = class extends Mp {
      constructor(el, o) {
        super(el, o)
        F.maps.push(this)
        g.event.addListenerOnce(this, 'tilesloaded', () => {
          F.firstTiles ??= performance.now()
        })
      }
    }
  }
  let cb
  Object.defineProperty(w, '__doorwayMapsReady', {
    configurable: true,
    get: () => (cb ? () => { wrap(); cb() } : undefined),
    set: (v) => { cb = v },
  })
}

// Snapshot of everything the invariants need, taken page-side in one round trip.
const PROBE = () => {
  const F = window.__fuzz
  const vis = (el) => {
    if (!el || !el.isConnected) return false
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const gm = document.querySelector('.gm')
  const sheets = [...document.querySelectorAll('.gm-sheet')].filter(vis)
  const sheet = sheets[0]
  const nav = document.querySelector('.gm-nav')
  const search = document.querySelector('.gm-search')
  const ss = document.querySelector('.ss')
  const banner = document.querySelector('.health-banner')
  // Text a user can see or hear: rendered text plus accessible names.
  if (!document.body) return { navigating: true }
  const texts = [document.body.innerText]
  document.querySelectorAll('[aria-label],[title],[alt]').forEach((el) => {
    texts.push(el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.getAttribute('alt') || '')
  })
  const bad = []
  for (const t of texts) {
    const m = t && t.match(/\bNaN\b|\bundefined\b|\bnull\b|\[object \w+\]|Infinity/)
    if (m) bad.push(t.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' '))
  }
  const liveMap = F.maps.find((m) => m.getDiv()?.isConnected) ?? null
  let liveMarkers = 0
  let orphan = 0
  for (const mk of F.markers) {
    const mp = mk.getMap()
    if (!mp) {
      F.markers.delete(mk)
      continue
    }
    if (mp === liveMap) liveMarkers++
    else orphan++
  }
  let livePolys = 0
  let orphanPolys = 0
  for (const pl of F.polylines) {
    const mp = pl.getMap()
    if (!mp) {
      F.polylines.delete(pl)
      continue
    }
    if (mp === liveMap) livePolys++
    else orphanPolys++
  }
  return {
    map: !!gm,
    ss: !!ss && vis(ss),
    sheetCount: sheets.length,
    sheetState: sheet?.dataset.state ?? null,
    sheetTop: sheet ? sheet.getBoundingClientRect().top : null,
    drag: sheet ? sheet.style.getPropertyValue('--drag') : '',
    navVisible: vis(nav),
    navTop: nav ? nav.getBoundingClientRect().top : null,
    navBottom: nav ? nav.getBoundingClientRect().bottom : null,
    searchBottom: search && vis(search) ? search.getBoundingClientRect().bottom : null,
    rootScroll: gm ? gm.scrollTop + gm.scrollLeft : 0,
    bad,
    banner: banner && vis(banner) ? banner.textContent : null,
    liveMarkers,
    orphan,
    livePolys,
    orphanPolys,
    maps: F.maps.length,
    intervals: F.intervals.size,
    winListeners: F.winListeners,
    innerH: window.innerHeight,
  }
}

async function runSeed(seed) {
  const rnd = mulberry32(seed)
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: !process.env.FUZZ_HEADED,
    args: ['--mute-audio', '--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-blink-features=LongTaskTiming'],
  })
  const ctx = await browser.newContext({
    locale: 'de-DE', viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    ignoreHTTPSErrors: true, geolocation: HOME, permissions: ['geolocation', 'camera', 'microphone'],
  })
  await ctx.addInitScript(INIT)
  // No real share sheet or clipboard in a monkey run.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    try { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => {} }) } catch { /* none */ }
  })

  // ---- fault injection on /api/* ----
  let apiMode = 'ok' // ok | 500 | 429 | slow
  let offline = false
  let offlineEnded = 0
  const unreported = new Set()
  let lastApiFail = 0
  let lastApiOk = 0
  let faultSince = 0
  const apiLog = { ok: 0, fail: 0 }
  await ctx.route('**/api/**', async (route) => {
    const mode = apiMode
    if (mode === '429') {
      // A 429 is an answer from a working server: no snackbar expected.
      apiLog.fail++
      return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'quota' }) })
    }
    if (mode === '500') {
      // Only data.ts reports its answers to the health banner (entrances, lived).
      // Other callers (route, business, door-check) are listed for the join, not failed.
      const path = new URL(route.request().url()).pathname
      if (/\/api\/(entrances|lived)/.test(path)) lastApiFail = Date.now()
      else unreported.add(path.replace(/\/[^/]*\d[^/]*$/, '/:id'))
      apiLog.fail++
      return route.fulfill({ status: Number(mode), contentType: 'application/json', body: JSON.stringify({ error: mode === '429' ? 'quota' : 'boom' }) })
    }
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)))
    try {
      const resp = await route.fetch({ timeout: 30000 })
      const st = resp.status()
      await route.fulfill({ response: resp })
      if (st < 500 && st !== 429) {
        if (apiMode === 'ok' && !offline && /\/api\/(entrances|lived|health)/.test(route.request().url())) lastApiOk = Date.now()
        apiLog.ok++
      }
    } catch {
      await route.abort().catch(() => {})
    }
  })

  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  const violations = []
  const seen = new Set()
  let actionName = 'load'
  let i = 0
  const backend5xx = []
  const navs = []
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push({ i, action: actionName, url: f.url() }) })
  const violate = (kind, detail) => {
    const key = `${kind}|${String(detail).replace(/\d+/g, '#').slice(0, 80)}`
    const v = { seed, i, action: actionName, kind, detail: String(detail).slice(0, 220) }
    violations.push(v)
    if (!seen.has(key)) {
      seen.add(key)
      console.log(`  VIOLATION seed ${seed} #${i} after ${actionName}: ${kind}: ${v.detail}`)
      page.screenshot({ path: join(OUT, `fuzz-${seed}-${i}-${kind}.png`) }).catch(() => {})
    }
  }
  const faulty = () => offline || apiMode !== 'ok'
  const thirdParty = []
  page.on('pageerror', (e) => {
    // Google's lazy module loader throws 'Could not load "poly"' when the network is gone.
    // The stack is entirely Google's; the app cannot catch it. Counted, not a violation.
    const stack = String(e.stack || '')
    const frames = stack.split('\n').slice(1).filter((l) => /https?:/.test(l))
    if (frames.length && frames.every((l) => /googleapis|gstatic/.test(l))) return void thirdParty.push(e.message)
    if (/^Could not load "\w+"/.test(e.message || '') && (faulty() || Date.now() - offlineEnded < 15000)) return void thirdParty.push(e.message)
    violate('pageerror', `${e.message || e} ${frames[0] ?? ''}`.trim())
  })
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    // A failed request is logged by the browser itself; expected while we inject faults.
    const url = m.location()?.url ?? ''
    if (/Failed to load resource|net::ERR_|ERR_INTERNET_DISCONNECTED/.test(text)) {
      // The browser's own log line for a failed request. Expected while we inject
      // faults; a real backend 5xx on /api is counted (the app must cope, the snackbar
      // covers it) and a failing Google request is Google's. Anything else is ours.
      if (faulty() || Date.now() - lastApiFail < 10000) return
      if (/\/api\//.test(url)) return void backend5xx.push(url.replace(/^https?:\/\/[^/]+/, ''))
      if (/googleapis|gstatic|google\.com/.test(url)) return
    }
    violate('console', `${text} ${m.location()?.url ?? ''}`.trim())
  })

  const t0 = Date.now()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.locator('.gm-nav').waitFor({ timeout: 20000 })
  await page.waitForFunction(() => window.__fuzz?.firstTiles, null, { timeout: 30000 }).catch(() => {})
  const paint = await page.evaluate(() => ({ ready: window.__fuzz.mapsReady, tiles: window.__fuzz.firstTiles }))
  const firstPaint = paint.tiles ? Math.round(paint.tiles) : null
  await page.waitForTimeout(1500)
  const base0 = await page.evaluate(PROBE)

  // ---- actions ----
  async function visibleBoxes(sel) {
    return page.evaluate((s) => {
      const out = []
      document.querySelectorAll(s).forEach((el, idx) => {
        if (el.closest('[inert]') || el.disabled) return
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none') return
        const x = r.left + r.width / 2
        const y = r.top + r.height / 2
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return
        const top = document.elementFromPoint(x, y)
        if (!top || !(el === top || el.contains(top))) return
        out.push({ x, y, idx, label: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) })
      })
      return out
    }, sel)
  }
  async function tapSel(sel, filter) {
    let boxes = await visibleBoxes(sel)
    if (filter) boxes = boxes.filter((b) => filter.test(b.label) === true)
    if (!boxes.length) return false
    const b = pick(boxes)
    actionName += ` "${b.label}"`
    await page.touchscreen.tap(b.x, b.y)
    return b
  }
  async function touchSwipe(x, y0, y1, ms) {
    const steps = 6
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] })
    for (let s = 1; s <= steps; s++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * s) / steps }] })
      await page.waitForTimeout(ms / steps)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  const vp = () => page.viewportSize()

  const acts = {
    async chip() { await tapSel('.gm-chips .gm-chip, .gm-chips button') },
    async mapTap() {
      const p = await page.evaluate(PROBE)
      if (!p.map) return
      const { width } = vp()
      const top = (p.searchBottom ?? 60) + 60
      const bottom = (p.sheetTop ?? p.navTop ?? 700) - 10
      if (bottom <= top) return
      const x = 20 + rnd() * (width - 40)
      const y = top + rnd() * (bottom - top)
      actionName += ` @${Math.round(x)},${Math.round(y)}`
      await page.touchscreen.tap(x, y)
    },
    async marker() {
      const n = await page.evaluate((r) => {
        const F = window.__fuzz
        const live = [...F.markers].filter((m) => m.getMap() && m.getClickable?.() !== false && m.getVisible?.() !== false)
        if (!live.length) return 0
        window.google.maps.event.trigger(live[Math.floor(r * live.length)], 'click')
        return live.length
      }, rnd())
      actionName += ` (${n})`
    },
    async doorRow() { await tapSel('.gm-row, .gx-feed button, .pc-list button') },
    async pill() { await tapSel('.gm-pill, .gm-circle, .gm-round-s, .gm-more') },
    async cardTab() { await tapSel('.gm-tabbtn') },
    async navTab() { await tapSel('.gm-tab') },
    async handle() { await tapSel('.gm-handle') },
    async swipe() {
      const p = await page.evaluate(PROBE)
      if (p.sheetTop === null) return
      const { width } = vp()
      const y0 = p.sheetTop + 12 + rnd() * 40
      const dy = (rnd() < 0.5 ? -1 : 1) * (40 + rnd() * 500)
      const ms = pick([40, 120, 400])
      actionName += ` dy=${Math.round(dy)} ${ms}ms`
      await touchSwipe(width / 2 + (rnd() - 0.5) * 100, y0, Math.max(5, Math.min(vp().height - 5, y0 + dy)), ms)
    },
    async search() {
      if (!(await tapSel('.gm-search-input'))) return
      await page.waitForTimeout(150)
      const q = pick(['Kaffee', 'Hbf', 'Eingang', 'xyzzy', 'Reichstag', 'Apotheke', '   ', 'Ä ö ü ß', '<b>x</b>', 'a'.repeat(80)])
      actionName += ` q=${JSON.stringify(q.slice(0, 12))}`
      await page.keyboard.type(q, { delay: 5 }).catch(() => {})
      const then = pick(['enter', 'suggest', 'back', 'escape', 'clear'])
      actionName += ` ${then}`
      if (then === 'enter') await page.keyboard.press('Enter')
      else if (then === 'suggest') { if (!(await tapSel('.ss-row-btn, .ss-chip'))) await page.keyboard.press('Escape') }
      else if (then === 'back') await tapSel('.ss-bar .ss-icon-btn:first-child')
      else if (then === 'clear') { await tapSel('.ss-clear'); await page.keyboard.press('Escape') }
      else await page.keyboard.press('Escape')
    },
    async back() {
      if (await page.locator('.ss').count()) return page.keyboard.press('Escape')
      if (!(await tapSel('button', /Schließen|Zurück|Beenden|Abbrechen|Route entfernen|Andere Türen|close|back/i))) await page.keyboard.press('Escape')
    },
    async anyButton() {
      // Any tappable control in the sheet, but not the ones that leave for camera/mic.
      const boxes = (await visibleBoxes('.gm-sheet button, .gm-sheet a, .gm-sheet [role="tab"], .gm-sheet input')).filter((b) => !/Mikro|Sprach|Kamera|Lens|Aufnahme/i.test(b.label))
      if (!boxes.length) return
      const b = pick(boxes)
      actionName += ` "${b.label}"`
      await page.touchscreen.tap(b.x, b.y)
    },
    async doubleTap() {
      const boxes = await visibleBoxes('.gm-chip, .gm-pill, .gm-row, .gm-tab, .gm-handle, .gm-tabbtn, .gm-circle')
      if (!boxes.length) return
      const b = pick(boxes)
      actionName += ` "${b.label}"`
      await page.touchscreen.tap(b.x, b.y)
      await page.waitForTimeout(30 + rnd() * 60)
      await page.touchscreen.tap(b.x, b.y)
    },
    async locate() { await tapSel('.gm-right .gm-round, .gm-go, .gm-layers') },
    // ---- faults ----
    async geoJump() {
      const far = rnd() < 0.15
      const loc = far ? pick([{ latitude: 48.137, longitude: 11.575 }, { latitude: 0.0001, longitude: 0.0001 }, { latitude: 52.52, longitude: 13.405 }])
        : { latitude: HOME.latitude + (rnd() - 0.5) * 0.01, longitude: HOME.longitude + (rnd() - 0.5) * 0.015 }
      actionName += ` ${loc.latitude.toFixed(4)},${loc.longitude.toFixed(4)}`
      await ctx.setGeolocation({ ...loc, accuracy: pick([5, 30, 150]) })
    },
    async offlineToggle() {
      offline = !offline
      actionName += offline ? ' on' : ' off'
      if (!offline) offlineEnded = Date.now()
      if (offline) faultSince = Date.now()
      await ctx.setOffline(offline)
    },
    async apiFault() {
      const m = pick(['ok', 'ok', '500', '429', 'slow'])
      // Each mode is its own fault window: a 500 seen before must not count against 'slow'.
      if (m !== apiMode) faultSince = Date.now()
      if (m !== apiMode) bannerWanted = 0
      apiMode = m
      actionName += ` ${m}`
    },
    async resize() {
      const s = pick([{ width: 402, height: 874 }, { width: 874, height: 402 }, { width: 320, height: 568 }, { width: 430, height: 932 }, { width: 402, height: 600 }])
      actionName += ` ${s.width}x${s.height}`
      await page.setViewportSize(s)
    },
  }
  const weights = [
    ['chip', 8], ['mapTap', 8], ['marker', 8], ['doorRow', 8], ['pill', 10], ['cardTab', 4], ['navTab', 7], ['handle', 4],
    ['swipe', 8], ['search', 5], ['back', 7], ['anyButton', 8], ['doubleTap', 5], ['locate', 3],
    ['geoJump', 3], ['offlineToggle', 1.5], ['apiFault', 2.5], ['resize', 1.5],
  ]
  const total = weights.reduce((a, [, w]) => a + w, 0)
  const choose = () => {
    let r = rnd() * total
    for (const [k, w] of weights) if ((r -= w) < 0) return k
    return weights[0][0]
  }

  // ---- invariants ----
  let bannerWanted = 0 // time a failure should have raised the snackbar
  let faultEnded = 0 // when the last injected fault stopped
  let offMapSince = 0
  let resets = 0
  let maxMarkers = 0
  let maxIntervals = 0
  let maxListeners = 0
  const longTaskActions = []
  async function check() {
    // Let the sheet finish its snap (0.25 s transition) and any late state change land.
    await page.waitForFunction(() => !document.querySelector('.gm-sheet')?.getAnimations().length, null, { timeout: 1500 }).catch(() => {})
    const p = await page.evaluate(PROBE).catch((e) => ({ error: String(e) }))
    if (p.error) return violate('probe', p.error)
    if (p.navigating) return
    maxMarkers = Math.max(maxMarkers, p.liveMarkers)
    maxIntervals = Math.max(maxIntervals, p.intervals)
    maxListeners = Math.max(maxListeners, p.winListeners)
    if (p.intervals > MAX_INTERVALS) violate('intervals', `${p.intervals} open intervals: ${await page.evaluate(() => [...window.__fuzz.intervals].map((id) => window.__fuzz.where?.[id]).join(' | ')).catch(() => '')}`)
    if (p.winListeners - base0.winListeners > MAX_WIN_LISTENER_GROWTH) violate('listeners', `${p.winListeners} window/document listeners (start ${base0.winListeners}): ${await page.evaluate(() => Object.entries(window.__fuzz.byType).filter(([, n]) => n > 2).map(([k, n]) => `${k}=${n} ${window.__fuzz.lwhere?.[k]}`).join(' | ')).catch(() => '')}`)
    if (p.liveMarkers > MAX_MARKERS) violate('markers', `${p.liveMarkers} live markers`)
    if (p.orphan) violate('marker-leak', `${p.orphan} markers still on a detached map (${p.maps} maps made)`)
    if (p.orphanPolys) violate('polyline-leak', `${p.orphanPolys} polylines on a detached map`)
    for (const b of p.bad) violate('bad-text', b)
    if (p.map) {
      offMapSince = 0
      if (p.sheetCount !== 1) violate('sheet-count', `${p.sheetCount} sheets visible`)
      if (!p.navVisible) violate('nav', 'nav bar not visible')
      else if (Math.abs(p.navBottom - p.innerH) > 2) violate('nav', `nav bottom ${p.navBottom} != viewport ${p.innerH}`)
      if (p.rootScroll) violate('root-scroll', `root scrolled by ${p.rootScroll}`)
      if (p.drag) violate('stale-drag', `--drag ${p.drag} left on the sheet (${p.sheetState})`)
      if (p.sheetTop !== null && p.navTop !== null) {
        const floor = p.sheetState === 'full' || p.searchBottom === null ? 0 : p.searchBottom
        if (p.sheetTop < floor - 1) violate('sheet-top', `${p.sheetState} sheet top ${Math.round(p.sheetTop)} above search bottom ${Math.round(floor)}`)
        if (p.sheetTop > p.navTop - 40) violate('sheet-top', `${p.sheetState} sheet top ${Math.round(p.sheetTop)} under nav ${Math.round(p.navTop)}`)
      }
    } else if (!p.ss) {
      offMapSince ||= Date.now()
    }
    // Health snackbar: shown while the backend fails, gone after it answers again.
    const now = Date.now()
    if (faulty() && (offline || lastApiFail >= faultSince)) {
      bannerWanted ||= offline ? faultSince : lastApiFail
      if (!p.banner && now - bannerWanted > BANNER_WITHIN_MS) violate('banner-missing', `no snackbar ${Math.round((now - bannerWanted) / 1000)} s into ${offline ? 'offline' : apiMode}`)
    } else if (!faulty()) {
      if (bannerWanted) faultEnded = now
      bannerWanted = 0
      // The real backend may legitimately report "routes unavailable"; only the
      // "no connection" line comes from an injected fault and must go away again.
      if (p.banner && /Keine Verbindung/.test(p.banner) && faultEnded && lastApiOk > faultEnded && now - lastApiOk > BANNER_CLEAR_MS) {
        violate('banner-stuck', `"${p.banner}" still up ${Math.round((now - lastApiOk) / 1000)} s after a good /api answer`)
      }
    }
  }

  let lastLong = 0
  for (i = 1; i <= ACTIONS; i++) {
    const kind = choose()
    actionName = kind
    try {
      // Off the map (settings, guidance, recorder): back out, or reload after a while.
      const onMap = await page.locator('.gm').count().catch(() => 0)
      if (!onMap && kind !== 'geoJump' && kind !== 'apiFault') {
        actionName = 'leave-screen'
        await acts.back()
        await page.waitForTimeout(400)
        if (offMapSince && Date.now() - offMapSince > 6000) {
          resets++
          actionName = 'reset'
          offMapSince = 0
          // A reload while offline can only fail; end the faults first.
          if (offline) await ctx.setOffline((offline = false))
          offlineEnded = Date.now()
          apiMode = 'ok'
          await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})
          await page.locator('.gm-nav').waitFor({ timeout: 20000 }).catch(() => {})
        }
      } else {
        await acts[kind]()
      }
    } catch (e) {
      const msg = String(e?.message || e).split('\n')[0]
      if (!/Target closed|detached|navigat/i.test(msg)) violate('harness', `${kind}: ${msg}`)
    }
    await page.waitForTimeout(kind === 'swipe' ? 380 : 180 + Math.floor(rnd() * 250))
    await check()
    const lt = await page.evaluate((from) => window.__fuzz.longTasks.slice(from), lastLong).catch(() => [])
    lastLong += lt.length
    for (const t of lt) if (t.ms > 200) longTaskActions.push({ i, action: actionName, ms: Math.round(t.ms) })
    if (VERBOSE) console.log(`  ${seed}#${i} ${actionName}`)
  }
  // Recover and prove the snackbar clears.
  apiMode = 'ok'
  if (offline) await ctx.setOffline((offline = false))
  const final = await page.evaluate(PROBE).catch(() => ({}))
  const byType = await page.evaluate(() => window.__fuzz.byType).catch(() => ({}))
  await browser.close()
  return {
    seed, actions: ACTIONS, violations, resets, firstPaint, mapsReady: paint.ready ? Math.round(paint.ready) : null,
    loadMs: Date.now() - t0, maxMarkers, maxIntervals, maxListeners, base: base0.winListeners, maps: final.maps, longTasks: longTaskActions, api: apiLog, backend5xx, navs, thirdParty, byType, unreported: [...unreported],
  }
}

const results = []
for (const seed of SEEDS) {
  console.log(`seed ${seed}: ${ACTIONS} actions`)
  const r = await runSeed(seed)
  results.push(r)
  const kinds = [...new Set(r.violations.map((v) => v.kind))]
  const longs = r.longTasks
  console.log(`${r.violations.length ? 'FAIL' : 'PASS'} seed ${seed}: ${r.violations.length} violations${kinds.length ? ` (${kinds.join(', ')})` : ''}; first tiles ${r.firstPaint} ms (Maps ready ${r.mapsReady} ms); max markers ${r.maxMarkers}, intervals ${r.maxIntervals}, window listeners ${r.maxListeners} (start ${r.base}); maps made ${r.maps}; resets ${r.resets}; api ok ${r.api.ok}/injected ${r.api.fail}/real 5xx ${r.backend5xx.length}; navigations ${r.navs.length}; google errors ${r.thirdParty.length}; long tasks >200 ms: ${longs.length}${longs.length ? ` (max ${Math.max(...longs.map((x) => x.ms))} ms after ${longs.sort((a, b) => b.ms - a.ms)[0].action})` : ''}`)
}
writeFileSync(join(OUT, `fuzz-report-${SEEDS.join('-')}.json`), JSON.stringify(results, null, 2))
const total = results.reduce((a, r) => a + r.violations.length, 0)
console.log(`${total ? 'FAIL' : 'PASS'} fuzz: ${results.length} seeds x ${ACTIONS} actions, ${total} violations`)
process.exit(Math.min(total, 250))
