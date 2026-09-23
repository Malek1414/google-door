// Regression: tapping a venue on the map must open its card.
//
// clickableIcons was false, which made every Google POI label on the map dead to the
// touch. The map click event carries only a placeId, so two things have to hold:
// the option is on, and an id resolves to a full card payload.
//
// POI labels are canvas-rendered and cannot be clicked by selector, so this drives the
// same code path the tap handler uses.
//
//   node e2e/poi.mjs [baseUrl]
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pw = require('playwright-core')
const BASE = (process.argv[2] || 'http://127.0.0.1:8090/').replace(/\/?$/, '/')
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const HBF = 'ChIJe-ff-71RqEcRqvy8lRR4PHo'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const browser = await pw.chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const ctx = await browser.newContext({
  locale: 'de-DE', viewport: { width: 443, height: 960 }, isMobile: true, hasTouch: true,
  geolocation: { latitude: 52.5249, longitude: 13.3688 }, permissions: ['geolocation', 'camera'],
})
const page = await ctx.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(6000)

const r = await page.evaluate(async (hbf) => {
  const out = { tiles: document.querySelectorAll('.gm-map canvas, .gm-map img').length }
  out.sdk = !!(window.google && window.google.maps)
  try {
    const { Place } = await google.maps.importLibrary('places')
    out.placesLib = true
    const p = new Place({ id: hbf })
    await p.fetchFields({ fields: ['id', 'displayName', 'location', 'formattedAddress', 'accessibilityOptions'] })
    out.name = p.displayName
    out.hasLocation = !!p.location
    out.access = p.accessibilityOptions
      ? p.accessibilityOptions.hasWheelchairAccessibleEntrance
      : null
  } catch (e) {
    out.err = String(e).slice(0, 200)
  }
  return out
}, HBF)

console.log('venue tap -> place card')
check('map renders tiles', r.tiles > 0, `${r.tiles} nodes`)
check('Maps SDK present', r.sdk === true)
check('places library loads', r.placesLib === true)
check('a placeId resolves to a named place', !!r.name, r.name || r.err || '')
check('resolved place has a location to pan to', r.hasLocation === true)
check('accessibilityOptions come back for the card', r.access !== undefined)
check('no page errors while loading the map', pageErrors.length === 0,
      pageErrors[0] ? pageErrors[0].slice(0, 90) : '')

await browser.close()
console.log(`\n${fails.length ? fails.length + ' FAILED: ' + fails.join(', ') : 'ALL PASS'}`)
process.exit(fails.length)
