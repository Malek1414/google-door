// Replay real footage through /api/door-fix. Usage:
//   node e2e/door-fix-replay.mjs <framesDir> [baseUrl] [doorId]
//
// Sends every *.jpg in <framesDir> with the payload the approach engine sends
// (ui/approachEngine.ts requestFix: { frame, headingDeg, doorId }) and prints one row per
// frame: expected label, seen, bearing, distance, confidence, latency.
//
// Labels come from <framesDir>/labels.json ({ "<file>": "door" | "partial" | "main" | "none" })
// or from LABELS below (the Google Berlin walk, frames named <video>-<second>.jpg).
//   door     the target door is clearly visible: it must be found
//   partial  cut off at the edge: either answer is fine
//   main     the main entrance with steps is in view: finding a door here is a WRONG door
//   none     looking away
//
// Exit code = misses on "door" frames. Wrong-door hits are printed as WRONG and counted
// separately (they are the dangerous failure).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node e2e/door-fix-replay.mjs <framesDir> [baseUrl] [doorId]')
  process.exit(2)
}
const BASE = (process.argv[3] || 'https://doorway.5.45.109.195.sslip.io').replace(/\/$/, '')
const DOOR = process.argv[4] || 'demo/google-accessible'
// The walk is heading roughly east-south-east at the door (route.json approachBearing 107.2).
const HEADING = 107

// IMG_3137 (1x) and IMG_3138 (0.5x), Sami, 24.09.2026. x = door centre as a fraction of the width.
const LABELS = {
  '3137-000.0.jpg': ['main'], '3137-003.0.jpg': ['main'], '3137-005.0.jpg': ['none'],
  '3137-006.0.jpg': ['none'], '3137-007.0.jpg': ['none'], '3137-008.0.jpg': ['none'],
  '3137-009.0.jpg': ['door', 0.2], '3137-010.0.jpg': ['door', 0.42], '3137-011.0.jpg': ['door', 0.43],
  '3137-012.0.jpg': ['door', 0.55], '3137-013.0.jpg': ['door', 0.55], '3137-014.0.jpg': ['door', 0.6],
  '3138-000.0.jpg': ['none'], '3138-002.0.jpg': ['none'], '3138-003.5.jpg': ['none'],
  '3138-006.0.jpg': ['main'], '3138-008.0.jpg': ['partial', 0.03], '3138-009.0.jpg': ['partial', 0.05],
  '3138-010.0.jpg': ['door', 0.35], '3138-011.0.jpg': ['door', 0.45], '3138-012.0.jpg': ['door', 0.5],
  '3138-013.0.jpg': ['door', 0.55],
}
const custom = join(dir, 'labels.json')
const labels = existsSync(custom) ? JSON.parse(readFileSync(custom, 'utf8')) : LABELS
const label = (f) => {
  const l = labels[f]
  return Array.isArray(l) ? { kind: l[0], x: l[1] ?? null } : { kind: l ?? 'none', x: null }
}

const files = readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f) && !f.startsWith('sheet')).sort()
const rows = []
for (const f of files) {
  const frame = readFileSync(join(dir, f)).toString('base64')
  const t0 = Date.now()
  let body = null
  let status = 0
  try {
    const r = await fetch(`${BASE}/api/door-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame, headingDeg: HEADING, doorId: DOOR }),
    })
    status = r.status
    body = r.ok ? await r.json() : null
  } catch {
    status = -1
  }
  const ms = Date.now() - t0
  const { kind, x } = label(basename(f))
  const seen = body?.found === true
  const verdict =
    kind === 'door' ? (seen ? 'hit' : 'MISS') : kind === 'partial' ? (seen ? 'hit' : 'ok') : seen ? 'WRONG' : 'ok'
  rows.push({
    file: f,
    label: kind,
    x: x === null ? '' : x.toFixed(2),
    seen: seen ? 'yes' : 'no',
    bearing: seen ? body.bearingDeg.toFixed(0) : '',
    dist: seen ? body.distanceM.toFixed(1) : '',
    conf: body ? body.confidence.toFixed(2) : `http ${status}`,
    ms,
    verdict,
    note: (body?.note ?? '').slice(0, 40),
  })
  console.error(`${f} ${verdict} ${ms} ms`)
}

const cols = ['file', 'label', 'x', 'seen', 'bearing', 'dist', 'conf', 'ms', 'verdict', 'note']
console.log(`| ${cols.join(' | ')} |`)
console.log(`|${cols.map(() => '---').join('|')}|`)
for (const r of rows) console.log(`| ${cols.map((c) => r[c]).join(' | ')} |`)

const door = rows.filter((r) => r.label === 'door')
const misses = door.filter((r) => r.verdict === 'MISS').length
const wrong = rows.filter((r) => r.verdict === 'WRONG').length
const lat = rows.map((r) => r.ms).sort((a, b) => a - b)
console.log(
  `\nhits ${door.length - misses}/${door.length} on clear door frames, wrong-door ${wrong}, ` +
    `latency median ${lat[Math.floor(lat.length / 2)]} ms, max ${lat[lat.length - 1]} ms`,
)
process.exit(misses)
