// Accessibility run for Google Doorway. Usage: node e2e/a11y.mjs [baseUrl] [--only=name,name] [--no-zoom]
// For every screen: axe-core violations by impact, keyboard Tab order (stops, stops without a focus ring,
// stops off screen, controls without a name, identical names), touch targets under 44 px, and a 200 % zoom
// pass (page zoom 2 on a 640 px wide phone = 320 CSS px, WCAG 1.4.10) that counts clipped text and
// horizontal scrolling. playwright-core: PLAYWRIGHT_CORE or module resolution (see README).
// axe-core: AXE_PATH (path to axe.min.js), `axe-core` from node_modules, or the scratchpad copy.
// Exit code = number of serious + critical axe violations (nodes) over all screens.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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
function loadAxe() {
  const tries = [process.env.AXE_PATH, (() => { try { return req.resolve('axe-core/axe.min.js') } catch { return '' } })(), `${SCRATCH}/a11y/axe.min.js`]
  for (const t of tries) if (t && existsSync(t)) return readFileSync(t, 'utf8')
  throw new Error('axe-core not found. Set AXE_PATH=/path/to/axe.min.js')
}
const pw = await loadPlaywright()
const chromium = pw.chromium ?? pw.default?.chromium
const AXE = loadAxe()

const args = process.argv.slice(2)
const BASE = (args.find((a) => !a.startsWith('--')) || 'https://localhost:5173/').replace(/\/?$/, '/')
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean)
const ZOOM = !args.includes('--no-zoom')
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch({ executablePath: CHROME, args: ['--mute-audio', '--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })

async function newPage(path = '', { width = 402, height = 874 } = {}) {
  const ctx = await browser.newContext({
    locale: 'de-DE', viewport: { width, height }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
    geolocation: { latitude: 52.5249, longitude: 13.3688, accuracy: 8 }, permissions: ['geolocation', 'camera'],
  })
  const p = await ctx.newPage()
  p.errs = []
  p.on('pageerror', (e) => p.errs.push(String(e)))
  await p.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await p.waitForTimeout(5000)
  return p
}
async function tap(p, sel, text) {
  const l = (text ? p.locator(sel, { hasText: text }) : p.locator(sel)).first()
  if (!(await l.count())) throw new Error(`missing ${sel}${text ? ` "${text}"` : ''}`)
  await l.tap({ timeout: 4000 }).catch(() => l.evaluate((x) => x.click()))
  await p.waitForTimeout(1500)
}
async function makeBusiness(p) {
  await tap(p, '.gm-tab', 'Unternehmen')
  await p.locator('form.bz input').first().waitFor({ state: 'visible', timeout: 10000 })
  await p.locator('form.bz input').first().fill('Café Test')
  await tap(p, 'button', 'Kartenmitte')
  await tap(p, 'form.bz button[type=submit]')
  await p.locator('.bzh-action-btn').first().waitFor({ state: 'visible', timeout: 10000 })
}

// Each screen gets a fresh context, so a failure in one flow does not leak into the next.
const SCREENS = {
  home: async () => newPage(),
  search: async () => { const p = await newPage(); await tap(p, '.gm-search-input'); return p },
  'door-card': async () => { const p = await newPage(); await p.locator('.gx-door').first().scrollIntoViewIfNeeded(); await tap(p, '.gx-door'); return p },
  'place-card': async () => { const p = await newPage(); await tap(p, '.gm-chip', 'Restaurants'); await p.waitForTimeout(2000); await tap(p, '.gm-row.pc-row'); await p.waitForTimeout(1500); return p },
  foryou: async () => { const p = await newPage(); await tap(p, '.gm-tab', 'Für dich'); await p.waitForTimeout(1500); return p },
  contribute: async () => { const p = await newPage(); await tap(p, '.gm-tab', 'Beitragen'); await p.waitForTimeout(1500); return p },
  'contribute-editor': async () => { const p = await newPage(); await tap(p, '.gm-tab', 'Beitragen'); await tap(p, '.ct-tile', 'Eingang hinzufügen'); return p },
  'business-new': async () => { const p = await newPage(); await tap(p, '.gm-tab', 'Unternehmen'); return p },
  'business-home': async () => { const p = await newPage(); await makeBusiness(p); return p },
  'business-edit': async () => { const p = await newPage(); await makeBusiness(p); await tap(p, '.bzh-action-btn', 'Profil'); return p },
  'business-data': async () => { const p = await newPage(); await makeBusiness(p); await tap(p, '.bzh-info'); return p },
  'business-access': async () => { const p = await newPage(); await makeBusiness(p); await tap(p, '.bzh-access'); return p },
  'business-entrances': async () => { const p = await newPage(); await makeBusiness(p); await tap(p, '.bzh-action-btn', 'Eingänge'); return p },
  'business-editor': async () => { const p = await newPage(); await makeBusiness(p); await tap(p, '.bzh-action-btn', 'Eingänge'); await tap(p, '.bem-add'); return p },
  settings: async () => { const p = await newPage(); await tap(p, '.gm-avatar'); return p },
  start: async () => newPage('?sim=1'),
  approach: async () => newPage('?approach=demo'),
}

async function axeRun(p) {
  if (!(await p.evaluate(() => !!window.axe))) await p.addScriptTag({ content: AXE })
  return p.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ['violations'] })
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }))
  })
}
async function targets(p) {
  return p.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('[hidden],[aria-hidden="true"],[inert]') && r.bottom > 0 && r.top < innerHeight }
    const small = []
    for (const e of document.querySelectorAll('button,a[href],input,select,textarea,[role=button],[role=tab],[role=switch],[role=radio],[role=checkbox]')) {
      if (!vis(e) || e.closest('.gm-map,.gm-photo')) continue
      // A wrapping <label> is the real target for a checkbox or radio.
      const hit = (e.matches('input') && e.closest('label')) || e
      const r = hit.getBoundingClientRect()
      if (r.width < 44 || r.height < 44) small.push(`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} ${Math.round(r.width)}x${Math.round(r.height)}`)
    }
    return small
  })
}
async function keyboard(p) {
  // Start the Tab walk at the top of the document, not at whatever had focus last.
  await p.evaluate(() => { document.activeElement?.blur?.(); document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex') })
  const stops = []
  for (let i = 0; i < 70; i++) {
    await p.keyboard.press('Tab')
    await p.waitForTimeout(250) // the app scrolls a focused row into view on the next frame
    const f = await p.evaluate(() => {
      const e = document.activeElement
      if (!e || e === document.body) return null
      const r = e.getBoundingClientRect(); const cs = getComputedStyle(e)
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none'
      const name = (e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') || '').split(' ').map((id) => document.getElementById(id)?.textContent || '').join(' ') || (e.labels?.[0]?.textContent) || e.innerText || e.value || e.title || '').replace(/\s+/g, ' ').trim()
      const inMap = !!e.closest('.gm-map,.gm-photo')
      const off = r.width === 0 || r.bottom < 0 || r.top > innerHeight
      if (!e.dataset.a11yId) e.dataset.a11yId = String(Math.random())
      return { id: e.dataset.a11yId, name: name.slice(0, 60), ring, off, inMap, tag: e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0] }
    })
    if (!f) { if (stops.length && stops.at(-1) === null) break; stops.push(null); continue }
    if (stops.some((s) => s && s.id === f.id)) break
    stops.push(f)
  }
  const real = stops.filter(Boolean).filter((s) => !s.inMap)
  const names = real.map((s) => s.name).filter(Boolean)
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
  return {
    stops: real.length,
    noRing: real.filter((s) => !s.ring).map((s) => s.tag + ' "' + s.name + '"'),
    off: real.filter((s) => s.off).length,
    unnamed: real.filter((s) => !s.name).map((s) => s.tag),
    dupNames: dup,
    order: real.map((s) => s.name || s.tag),
  }
}
async function zoomCheck(name) {
  const p = await SCREENS[name]()
  await p.evaluate(() => { document.documentElement.style.zoom = '2' })
  await p.waitForTimeout(800)
  const r = await p.evaluate(() => {
    const clipped = []
    for (const e of document.querySelectorAll('body *')) {
      if (e.closest('.gm-map,.gm-photo,[hidden],[aria-hidden="true"],svg,.sr-only')) continue
      if (!e.childNodes.length || ![...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue
      const cs = getComputedStyle(e)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.fontFamily.includes('Material')) continue
      const hideX = cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis'
      const hideY = cs.overflowY === 'hidden' || cs.webkitLineClamp !== 'none'
      if ((hideX && e.scrollWidth > e.clientWidth + 2) || (hideY && e.scrollHeight > e.clientHeight + 2)) clipped.push(`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} "${e.textContent.trim().slice(0, 30)}"`)
    }
    const doc = document.scrollingElement
    return { clipped: [...new Set(clipped)], hscroll: doc.scrollWidth > doc.clientWidth + 2 }
  })
  await p.screenshot({ path: join(OUT, `a11y-zoom-${name}.png`) }).catch(() => {})
  await p.context().close()
  return r
}

const report = []
for (const name of Object.keys(SCREENS)) {
  if (ONLY.length && !ONLY.includes(name)) continue
  let row = { name }
  try {
    const p = await SCREENS[name]()
    const axe = await axeRun(p)
    const small = await targets(p)
    await p.screenshot({ path: join(OUT, `a11y-${name}.png`) }).catch(() => {})
    const kb = await keyboard(p)
    row = { name, axe, small, kb, errs: p.errs }
    await p.context().close()
    if (ZOOM) row.zoom = await zoomCheck(name).catch((e) => ({ error: String(e).slice(0, 120) }))
  } catch (e) {
    row.error = String(e?.message || e).split('\n')[0].slice(0, 160)
  }
  report.push(row)
  const by = (i) => (row.axe || []).filter((v) => v.impact === i).reduce((s, v) => s + v.n, 0)
  const line = row.error ? `ERROR ${row.error}` :
    `axe critical ${by('critical')} serious ${by('serious')} moderate ${by('moderate')} minor ${by('minor')}` +
    ` | tab ${row.kb.stops} (no ring ${row.kb.noRing.length}, off ${row.kb.off}, unnamed ${row.kb.unnamed.length}, same name ${row.kb.dupNames.length})` +
    ` | <44px ${row.small.length}` + (row.zoom ? ` | 200%: clipped ${row.zoom.clipped?.length ?? '?'}${row.zoom.hscroll ? ', h-scroll' : ''}` : '')
  console.log(`${name.padEnd(20)} ${line}`)
  for (const v of row.axe || []) if (v.impact === 'serious' || v.impact === 'critical') console.log(`    ${v.impact} ${v.id} x${v.n}: ${v.nodes.join(' , ')}`)
}
await browser.close()
writeFileSync(join(OUT, 'a11y.json'), JSON.stringify(report, null, 1))
const sum = (i) => report.reduce((s, r) => s + (r.axe || []).filter((v) => v.impact === i).reduce((a, v) => a + v.n, 0), 0)
const bad = sum('critical') + sum('serious')
console.log(`TOTAL axe critical ${sum('critical')} serious ${sum('serious')} moderate ${sum('moderate')} minor ${sum('minor')}; errors ${report.filter((r) => r.error).length}; details in e2e/out/a11y.json`)
process.exit(bad + report.filter((r) => r.error).length)
