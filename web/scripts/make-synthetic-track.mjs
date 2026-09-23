// SYNTHETIC track generator. NOT a real walk.
//
// Produces public/tracks/hbf-approach-synthetic.json: a made-up approach to the
// Hauptbahnhof step-free door node/10795939972 (CONTRACT fixture) from about 60 m,
// so ?sim=1 works before anyone has recorded a real walk. Replace it with a
// ?record=1 recording and pass ?track=tracks/<file>.json.
//
// Script: 0-12 s poor GPS (30 m, cone), 12-24 s the walker drifts 55 degrees left
// (arrow must say turn right, beacon pans right), then corrects and closes in.
//
//   node scripts/make-synthetic-track.mjs

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DOOR = { lat: 52.5272097, lon: 13.3711667 } // node/10795939972, step-free
const START_BEARING_FROM_DOOR = 300 // start north-west of the door
const START_DISTANCE_M = 60
const WALK_MS = 1.3

const R = 6371008.8
const rad = (d) => (d * Math.PI) / 180
const deg = (r) => (r * 180) / Math.PI
const norm = (d) => ((d % 360) + 360) % 360

function dest(p, b, m) {
  const d = m / R
  const f1 = rad(p.lat)
  const l1 = rad(p.lon)
  const br = rad(b)
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(br))
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2))
  return { lat: deg(f2), lon: deg(l2) }
}
function dist(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat))
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon))
  return norm(deg(Math.atan2(y, x)))
}

let pos = dest(DOOR, START_BEARING_FROM_DOOR, START_DISTANCE_M)
const pts = []
for (let t = 0; t <= 120; t += 1) {
  const toDoor = bearing(pos, DOOR)
  const d = dist(pos, DOOR)
  const drift = t >= 12 && t < 24 ? -55 * Math.sin(((t - 12) / 12) * Math.PI) : 0
  const wobble = 4 * Math.sin(t * 1.7) // deterministic sway of a hand-held phone
  const heading = norm(toDoor + drift + wobble)
  const accuracy = t < 12 ? 30 : Math.max(4, 12 - (t - 12) * 0.5)
  pts.push({ t, lat: +pos.lat.toFixed(7), lon: +pos.lon.toFixed(7), heading: +heading.toFixed(1), accuracy: +accuracy.toFixed(1), headingSource: 'ios-webkit' })
  if (d < 1) break
  pos = dest(pos, norm(toDoor + drift * 0.8), Math.min(WALK_MS, d - 0.5))
}
// Stand at the door for three seconds.
const last = pts[pts.length - 1]
for (let i = 1; i <= 3; i++) pts.push({ ...last, t: last.t + i })

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../public/tracks/hbf-approach-synthetic.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(pts, null, 1) + '\n')
console.log(`wrote ${pts.length} points, ${pts[pts.length - 1].t} s, start ${START_DISTANCE_M} m from door -> ${out}`)
