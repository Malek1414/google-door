// Google Maps Live View look for the web camera view: the calibration prompt, the 3D
// arrow, "Dreh dich um", the floating door label, the white ETA bar and the mini map
// that appears when the phone is lowered. Builders plus pure helpers; LiveView.ts owns
// the state and decides what shows.

import { lang } from '../strings'
import { h, s } from './dom'

export const GOOGLE_BLUE = '#1A73E8'
/** Door behind the user: from this far off the arrow gives way to "Dreh dich um". */
export const TURN_AROUND_DEG = 120
/** ...and it comes back only below this, so a jittering compass does not flip it. */
export const TURN_BACK_DEG = 105
/** The door label shows while the door is this close to straight ahead. */
export const DOOR_VIEW_DEG = 30
/** Beta below this = phone lowered toward the ground: the mini map comes up. */
export const TILT_DOWN_DEG = 45
export const TILT_UP_DEG = 55
/** No reliable compass after this long: fall back to the map. */
export const CALIB_TIMEOUT_MS = 10_000
/** Walking speed for the ETA, same as the map navigation (core/navProgress.ts WALK_MPS). */
const WALK_MPS = 1.3

export const LV = lang === 'de'
  ? {
      calibTitle: 'Richte die Kamera auf Gebäude und Schilder auf der anderen Straßenseite',
      calibPos: 'Standort',
      calibDir: 'Richtung',
      calibFound: 'gefunden',
      calibSearching: 'wird bestimmt',
      calibFallback: 'Kompass wird kalibriert. Folge vorerst der Karte unten.',
      turnAround: 'Dreh dich um',
      min: 'Min.',
      arrive: 'Ankunft',
    }
  : {
      calibTitle: 'Point your camera at buildings and signs across the street',
      calibPos: 'Location',
      calibDir: 'Direction',
      calibFound: 'found',
      calibSearching: 'finding',
      calibFallback: 'Compass is calibrating. Follow the map below for now.',
      turnAround: 'Turn around',
      min: 'min',
      arrive: 'Arrive',
    }

/** Pure. Show "Dreh dich um"? Hysteresis between TURN_BACK_DEG and TURN_AROUND_DEG. */
export function turnAroundShown(relDeg: number, shown: boolean): boolean {
  const a = Math.abs(relDeg)
  if (!Number.isFinite(a)) return shown
  return shown ? a > TURN_BACK_DEG : a > TURN_AROUND_DEG
}

/** Pure. Horizontal place of the door label (0..1 of the width), or null when out of view. */
export function doorLabelX(relDoorDeg: number): number | null {
  if (!Number.isFinite(relDoorDeg) || Math.abs(relDoorDeg) >= DOOR_VIEW_DEG) return null
  return 0.5 + (relDoorDeg / DOOR_VIEW_DEG) * 0.36
}

/** Pure. Is the phone lowered (mini map)? null pitch = no orientation data = upright. */
export function tiltedDown(betaDeg: number | null, shown: boolean): boolean {
  if (betaDeg === null || !Number.isFinite(betaDeg)) return false
  return shown ? betaDeg < TILT_UP_DEG : betaDeg < TILT_DOWN_DEG
}

/** Pure. "340 m" / "1,2 km", rounded the way the map navigation rounds. */
export function shortDistance(m: number): string {
  if (!Number.isFinite(m)) return ''
  if (m < 1000) {
    const step = m < 100 ? 5 : 10
    return `${Math.max(0, Math.round(m / step) * step)} m`
  }
  return `${(m / 1000).toFixed(1).replace('.', lang === 'de' ? ',' : '.')} km`
}

/** Pure. The bottom bar: "5 Min." and "340 m · Ankunft 11:12". */
export function etaParts(remainingM: number, now: Date): { min: string; sub: string } {
  if (!Number.isFinite(remainingM)) return { min: '', sub: '' }
  const s = remainingM / WALK_MPS
  const mins = Math.max(1, Math.round(s / 60))
  const at = new Date(now.getTime() + s * 1000)
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return { min: `${mins} ${LV.min}`, sub: `${shortDistance(remainingM)} · ${LV.arrive} ${clock}` }
}

/** Pure. "Google Berlin, Haupteingang Tucholskystraße 2" -> "Google Berlin". */
export function shortName(name: string): string {
  const first = name.split(',')[0]?.trim()
  return first || name
}

export interface Sketch {
  d: string
  me: { x: number; y: number }
  door: { x: number; y: number }
}

/**
 * Pure. North-up sketch of the way ahead, fitted into w x h with padding: the path from
 * the user's position to the door (straight line when there is no route).
 */
export function sketchPath(
  me: { lat: number; lon: number },
  path: readonly [number, number][],
  door: { lat: number; lon: number },
  w: number,
  hgt: number,
  pad = 28,
): Sketch {
  const pts: [number, number][] = [[me.lat, me.lon], ...path, [door.lat, door.lon]]
  const k = Math.cos((me.lat * Math.PI) / 180)
  const xy = pts.map(([la, lo]) => [(lo - me.lon) * 111_195 * k, -(la - me.lat) * 111_195] as [number, number])
  const xs = xy.map((p) => p[0])
  const ys = xy.map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const spanX = Math.max(maxX - minX, 20), spanY = Math.max(maxY - minY, 20)
  const scale = Math.min((w - 2 * pad) / spanX, (hgt - 2 * pad) / spanY)
  const ox = (w - (maxX - minX) * scale) / 2 - minX * scale
  const oy = (hgt - (maxY - minY) * scale) / 2 - minY * scale
  const pr = xy.map(([x, y]) => ({ x: +(x * scale + ox).toFixed(1), y: +(y * scale + oy).toFixed(1) }))
  const d = pr.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')
  return { d, me: pr[0], door: pr[pr.length - 1] }
}

// ---- builders ----

const ms = (n: string, cls = 'ms') => h('span', { class: cls, 'aria-hidden': 'true' }, n)

/** The 3D arrow: a flat Material arrow laid on a tilted plane, extruded by CSS shadows. */
export function arrow3d(): { el: HTMLElement; rot: HTMLElement } {
  const svg = s('svg', { viewBox: '-80 -80 160 160', width: '160', height: '160', 'aria-hidden': 'true' },
    s('defs', {},
      s('linearGradient', { id: 'ar3d-top', x1: '0', y1: '0', x2: '0', y2: '1' },
        s('stop', { offset: '0', 'stop-color': '#6FA8FF' }),
        s('stop', { offset: '0.55', 'stop-color': '#3B86F2' }),
        s('stop', { offset: '1', 'stop-color': GOOGLE_BLUE }),
      ),
    ),
    s('path', {
      class: 'ar3d-face',
      d: 'M0 -70 L60 -6 L24 -6 L24 62 L-24 62 L-24 -6 L-60 -6 Z',
      fill: 'url(#ar3d-top)',
      stroke: '#fff',
      'stroke-width': '7',
      'stroke-linejoin': 'round',
      'paint-order': 'stroke',
    }),
  )
  const rot = h('div', { class: 'ar3d-rot' }, svg)
  const el = h('div', { class: 'ar3d ar-mark ar-mark-arrow', 'aria-hidden': 'true' }, h('div', { class: 'ar3d-plane' }, rot))
  return { el, rot }
}

/** "Dreh dich um" with a curved turn arrow, centred. */
export function turnPrompt(): HTMLElement {
  const arc = s('svg', { viewBox: '0 0 120 120', width: '112', height: '112', 'aria-hidden': 'true' },
    s('path', { d: 'M88 92 A40 40 0 1 1 92 40', fill: 'none', stroke: '#fff', 'stroke-width': '24', 'stroke-linecap': 'round' }),
    s('path', { d: 'M88 92 A40 40 0 1 1 92 40', fill: 'none', stroke: GOOGLE_BLUE, 'stroke-width': '14', 'stroke-linecap': 'round' }),
    s('path', { d: 'M104 18 L100 56 L66 40 Z', fill: GOOGLE_BLUE, stroke: '#fff', 'stroke-width': '5', 'stroke-linejoin': 'round', 'paint-order': 'stroke' }),
  )
  return h('div', { class: 'ar-turn ar-mark ar-mark-turn' }, h('div', { class: 'ar-turn-ic' }, arc), h('p', { class: 'ar-turn-t' }, LV.turnAround))
}

/** The calibration card: phone panning over a street, the prompt, two progress steps. */
export function calibCard(): { el: HTMLElement; setSteps: (pos: boolean, dir: boolean) => void; fallback: () => void } {
  const scene = s('svg', { viewBox: '0 0 200 96', width: '200', height: '96', class: 'ar-calib-art', 'aria-hidden': 'true' },
    // buildings across the street
    s('rect', { x: '14', y: '34', width: '34', height: '50', rx: '3', fill: '#D2E3FC' }),
    s('rect', { x: '54', y: '18', width: '40', height: '66', rx: '3', fill: '#AECBFA' }),
    s('rect', { x: '100', y: '40', width: '30', height: '44', rx: '3', fill: '#D2E3FC' }),
    s('rect', { x: '136', y: '26', width: '48', height: '58', rx: '3', fill: '#AECBFA' }),
    s('rect', { x: '6', y: '84', width: '188', height: '4', rx: '2', fill: '#DADCE0' }),
    s('g', { class: 'ar-calib-phone' },
      s('rect', { x: '78', y: '22', width: '44', height: '72', rx: '9', fill: '#fff', stroke: '#202124', 'stroke-width': '4' }),
      s('rect', { x: '84', y: '30', width: '32', height: '52', rx: '3', fill: GOOGLE_BLUE, opacity: '0.18' }),
      s('path', { d: 'M100 70 L100 42 M92 50 L100 42 L108 50', stroke: GOOGLE_BLUE, 'stroke-width': '4', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    ),
  )
  const step = (label: string) => {
    const ic = ms('progress_activity', 'ms ar-calib-ic')
    const st = h('span', { class: 'ar-calib-st' }, LV.calibSearching)
    const li = h('li', { class: 'ar-calib-step' }, ic, h('span', { class: 'ar-calib-l' }, label), st)
    return { li, ic, st }
  }
  const pos = step(LV.calibPos)
  const dir = step(LV.calibDir)
  const title = h('p', { class: 'ar-calib-t', id: 'ar-calib-t' }, LV.calibTitle)
  const list = h('ul', { class: 'ar-calib-steps' }, pos.li, dir.li)
  const note = h('p', { class: 'ar-calib-note', hidden: true }, LV.calibFallback)
  const el = h('div', { class: 'ar-calib', role: 'group', 'aria-labelledby': 'ar-calib-t' }, scene, title, list, note)
  const mark = (x: ReturnType<typeof step>, ok: boolean) => {
    const want = ok ? 'check_circle' : 'progress_activity'
    if (x.ic.textContent !== want) x.ic.textContent = want
    x.li.classList.toggle('is-ok', ok)
    const txt = ok ? LV.calibFound : LV.calibSearching
    if (x.st.textContent !== txt) x.st.textContent = txt
  }
  return {
    el,
    setSteps: (p, d) => {
      mark(pos, p)
      mark(dir, d)
    },
    fallback: () => {
      note.hidden = false
    },
  }
}

/** The floating destination label: white bubble "Google Berlin · 340 m" over a red pin. */
export function doorLabel(): { el: HTMLElement; set: (text: string, x: number | null) => void } {
  const txt = h('span', { class: 'ar-door-t' }, '')
  const pin = s('svg', { viewBox: '-24 -24 48 64', width: '40', height: '54', 'aria-hidden': 'true' },
    s('path', { d: 'M0 -22 C-13 -22 -22 -13 -22 0 C-22 14 -7 26 0 38 C7 26 22 14 22 0 C22 -13 13 -22 0 -22 Z', fill: '#EA4335', stroke: '#fff', 'stroke-width': '3' }),
    s('circle', { r: '8', fill: '#fff' }),
  )
  const el = h('div', { class: 'ar-door', hidden: true, 'aria-hidden': 'true' }, h('div', { class: 'ar-door-b' }, txt), pin)
  return {
    el,
    set: (text, x) => {
      if (x === null) {
        if (!el.hidden) el.hidden = true
        return
      }
      if (txt.textContent !== text) txt.textContent = text
      el.style.left = `${(x * 100).toFixed(1)}%`
      if (el.hidden) el.hidden = false
    },
  }
}

/** The mini map card (phone lowered, no camera, or no compass): a route sketch. */
export function miniMap(): { el: HTMLElement; draw: (k: Sketch, headingDeg: number | null) => void } {
  const W = 360, H = 170
  const casing = s('path', { d: '', fill: 'none', stroke: '#fff', 'stroke-width': '12', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  const line = s('path', { d: '', fill: 'none', stroke: GOOGLE_BLUE, 'stroke-width': '7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  const beam = s('path', { d: 'M0 0 L-13 -30 A32 32 0 0 1 13 -30 Z', fill: GOOGLE_BLUE, opacity: '0.28' })
  const meG = s('g', {}, beam, s('circle', { r: '10', fill: '#fff' }), s('circle', { r: '7', fill: GOOGLE_BLUE }))
  const doorG = s('g', {},
    s('path', { d: 'M0 -26 C-9 -26 -15 -20 -15 -11 C-15 -1 -5 6 0 14 C5 6 15 -1 15 -11 C15 -20 9 -26 0 -26 Z', transform: 'translate(0 -14)', fill: '#EA4335', stroke: '#fff', 'stroke-width': '2.5' }),
    s('circle', { cy: '-25', r: '5', fill: '#fff' }),
  )
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' },
    s('rect', { width: String(W), height: String(H), fill: '#EEF1F4' }),
    s('path', { d: `M0 ${H * 0.32} H${W} M0 ${H * 0.74} H${W} M${W * 0.22} 0 V${H} M${W * 0.61} 0 V${H} M${W * 0.86} 0 V${H}`, stroke: '#fff', 'stroke-width': '9', fill: 'none' }),
    casing, line, doorG, meG,
  )
  const el = h('div', { class: 'ar-mini', 'aria-hidden': 'true' }, svg)
  return {
    el,
    draw: (k, headingDeg) => {
      if (casing.getAttribute('d') !== k.d) {
        casing.setAttribute('d', k.d)
        line.setAttribute('d', k.d)
      }
      meG.setAttribute('transform', `translate(${k.me.x} ${k.me.y})`)
      beam.setAttribute('visibility', headingDeg === null ? 'hidden' : 'visible')
      if (headingDeg !== null) beam.setAttribute('transform', `rotate(${headingDeg.toFixed(0)})`)
      doorG.setAttribute('transform', `translate(${k.door.x} ${k.door.y})`)
    },
  }
}

export const MINI_W = 360
export const MINI_H = 170
