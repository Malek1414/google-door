// Live View AR layer, modelled on Google Maps Live View.
//
// Guidance is a path of blue chevrons lying ON THE PAVEMENT ahead (see groundChevrons):
// slabs with a white-edged Google-blue top and a dark-blue base, projected through a
// pinhole camera pitched by the phone's tilt, bending toward the target. The red Maps
// pin takes over close in (LiveView).
//
// What we cannot copy: Google anchors these in the world with VPS. We have a compass and
// the phone's pitch, so ours track bearing and tilt instead.

import { s } from './dom'

export const AR_BLUE = '#1b56c4'
export const AR_BLUE_DARK = '#123a86'
export const AR_FACE = '#ffffff'

/** Google blue and Maps red, flat (no gradients, no extrusion). */
export const AR_ARROW_BLUE = '#1A73E8'
export const AR_PIN_RED = '#EA4335'

/** The Maps pin, same family: flat red, white outline, white dot. Centred on its head. */
export function destinationPin(): SVGGElement {
  const g = s('g', { class: 'ar-pin' })
  g.append(
    s('path', {
      d: 'M0 -46 C-26 -46 -46 -26 -46 0 C-46 26 -14 52 0 72 C14 52 46 26 46 0 C46 -26 26 -46 0 -46 Z',
      fill: AR_PIN_RED,
      stroke: '#fff',
      'stroke-width': '5',
      'stroke-linejoin': 'round',
    }),
    s('circle', { cx: '0', cy: '0', r: '16', fill: '#fff' }),
  )
  return g
}

export type ArPhase = 'scanning' | 'ready' | 'guiding' | 'approach' | 'arrived'

/**
 * How far off-bearing before the guidance reads as "turn" rather than "ahead".
 */
export const TURN_DEG = 22

// ── Ground chevrons ───────────────────────────────────────────────────────────
//
// The guidance is a path of chevrons painted on the pavement ahead, like a runway,
// drawn with a real pinhole projection: the phone's pitch (DeviceOrientation beta)
// tilts the virtual camera, so the chevrons stay on the ground as the phone tilts.
// The path leaves from in front of the user's feet and bends toward the target
// (relative bearing), so a target to the side or behind shows as a painted turn,
// never as an arrow floating at the screen edge.
//
// Coordinates on the ground: x metres to the right, z metres ahead.

/** The SVG user space LiveView draws in (preserveAspectRatio slice keeps the height). */
export const VIEW_W = 393
export const VIEW_H = 760
/** Eye (phone) height above the pavement. */
export const CAM_HEIGHT_M = 1.45
/** Vertical field of view of the rear camera as shown full-height in portrait (cover). */
export const VFOV_DEG = 64
/** Focal length in SVG units. */
export const FOCAL = VIEW_H / 2 / Math.tan((VFOV_DEG / 2) * (Math.PI / 180))
/** Assumed pitch before the first orientation event: phone held for walking. */
export const DEFAULT_BETA = 75
/** Chevron layout along the path (metres). */
export const FIRST_M = 4.0
export const SPACING_M = 1.7
export const CHEVRONS = 5
/** Chevron size on the ground (metres): width, tip depth, arm thickness, slab height. */
export const CHEV_W = 1.15
export const CHEV_TIP = 0.34
export const CHEV_ARM = 0.36
export const CHEV_SLAB = 0.1
/** Forward flow speed of the painted chevrons (metres per second). */
export const FLOW_MPS = 1.1
/** Largest bend the path shows: past this the target is "behind", shown as a hard turn. */
export const MAX_TURN_DEG = 110

const RAD = Math.PI / 180
const NEAR_M = 0.6

/** Pure. How far the camera axis points below the horizon for a given beta (degrees). */
export function depressionFor(betaDeg: number | null | undefined): number {
  const b = typeof betaDeg === 'number' && Number.isFinite(betaDeg) ? betaDeg : DEFAULT_BETA
  return Math.max(-5, Math.min(80, 90 - b))
}

/** Pure. Screen y of the horizon for a given beta (can be above the view). */
export function horizonY(betaDeg: number | null | undefined): number {
  return VIEW_H / 2 - FOCAL * Math.tan(depressionFor(betaDeg) * RAD)
}

/**
 * Pure. Projects a ground point (x right, z ahead, y up from the pavement) to SVG space
 * for a camera `CAM_HEIGHT_M` up, pitched down by `depDeg`. null when behind the camera.
 */
export function project(x: number, z: number, depDeg: number, y = 0): { x: number; y: number; d: number } | null {
  const f = depDeg * RAD
  const dy = y - CAM_HEIGHT_M
  const d = -dy * Math.sin(f) + z * Math.cos(f)
  if (d < NEAR_M) return null
  const v = dy * Math.cos(f) + z * Math.sin(f)
  return { x: VIEW_W / 2 + (FOCAL * x) / d, y: VIEW_H / 2 - (FOCAL * v) / d, d }
}

/**
 * Pure. The bend the path makes for a relative bearing (+ right). Near 180 degrees the
 * side is ambiguous; `prevSign` keeps the side already shown so the path does not flap.
 */
export function pathTurn(relDeg: number, prevSign: 1 | -1 | 0 = 0): number {
  let r = Number.isFinite(relDeg) ? ((((relDeg + 180) % 360) + 360) % 360) - 180 : 0
  if (Math.abs(r) > 160 && prevSign !== 0 && Math.sign(r) !== prevSign) r = prevSign * Math.abs(r)
  if (r === -180) r = 180
  return Math.max(-MAX_TURN_DEG, Math.min(MAX_TURN_DEG, r))
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

/** Where the path starts bending and over how many metres: sharper turns bend sooner. */
function bendFor(turnDeg: number): { start: number; len: number } {
  // Gentle: a long curve from just ahead. Sharp: straight to a turn point ~4.5 m out,
  // then a tight painted corner, so the turned chevrons are still inside the camera's
  // narrow (about 32 degree) horizontal view instead of running off the screen edge.
  const k = Math.min(1, Math.abs(turnDeg) / 90)
  return { start: 2.6 + 1.6 * k, len: 3.2 - 2.2 * k }
}

/** Pure. Chevron spacing along the path: tighter round a sharp corner. */
export function spacingFor(turnDeg: number): number {
  return SPACING_M * (1 - 0.4 * Math.min(1, Math.abs(turnDeg) / 90))
}

export interface PathPose {
  x: number
  z: number
  /** Direction of travel on the ground, degrees, 0 = straight ahead, + = right. */
  heading: number
}

/** Pure. The pose `sM` metres along the painted path for a bend of `turnDeg`. */
export function pathPoint(sM: number, turnDeg: number): PathPose {
  const { start, len } = bendFor(turnDeg)
  const head = (s: number) => turnDeg * smooth((s - start) / len)
  const STEP = 0.05
  let x = 0
  let z = 0
  let s = 0
  while (s < sM) {
    const ds = Math.min(STEP, sM - s)
    const th = head(s + ds / 2) * RAD
    x += Math.sin(th) * ds
    z += Math.cos(th) * ds
    s += ds
  }
  return { x, z, heading: head(sM) }
}

/** Pure. The chevron outline (pointing along +w) in local metres (u right, w forward). */
export function chevronOutline(): [number, number][] {
  const W = CHEV_W / 2
  const tip = CHEV_TIP
  const arm = CHEV_ARM
  const back = -tip
  return [
    [-W, back],
    [0, tip],
    [W, back],
    [W, back - arm],
    [0, tip - arm],
    [-W, back - arm],
  ]
}

export interface GroundChevron {
  /** SVG path of the top face. */
  face: string
  /** SVG path of the slab's base (drawn under the face in a darker blue). */
  base: string
  /** Distance along the path, metres. */
  s: number
  /** Camera depth of the chevron centre, metres (larger = further). */
  depth: number
  /** Screen centre of the face. */
  cx: number
  cy: number
  /** Screen width of the face (px in SVG units). */
  size: number
  alpha: number
  /** Direction of the chevron on the ground (degrees, + right). */
  heading: number
}

function pathD(pts: { x: number; y: number }[]): string {
  return 'M' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L') + ' Z'
}

/**
 * Pure. The chevrons for a relative bearing, pitch and flow phase (0..1, one spacing).
 * Sorted far to near, so drawing in order paints near ones on top.
 */
export function groundChevrons(relDeg: number, betaDeg: number | null | undefined, flow = 1, prevSign: 1 | -1 | 0 = 0): GroundChevron[] {
  const turn = pathTurn(relDeg, prevSign)
  const dep = depressionFor(betaDeg)
  const outline = chevronOutline()
  const out: GroundChevron[] = []
  const f = Math.max(0, Math.min(1, flow))
  for (let i = 0; i <= CHEVRONS; i++) {
    const sM = FIRST_M + (i - 1 + f) * spacingFor(turn)
    // A new chevron appears quickly at the near end; the far one fades out.
    const alpha = i === 0 ? smooth(f / 0.35) : i === CHEVRONS ? 1 - smooth(f) : 1
    if (alpha < 0.02) continue
    const pose = pathPoint(sM, turn)
    const th = pose.heading * RAD
    const cos = Math.cos(th)
    const sin = Math.sin(th)
    const world = outline.map(([u, w]) => [pose.x + u * cos + w * sin, pose.z - u * sin + w * cos] as const)
    const top = world.map(([x, z]) => project(x, z, dep, CHEV_SLAB))
    const bot = world.map(([x, z]) => project(x, z, dep, 0))
    if (top.some((p) => !p) || bot.some((p) => !p)) continue
    const c = project(pose.x, pose.z, dep, CHEV_SLAB)!
    const xs = (top as { x: number }[]).map((p) => p.x)
    out.push({
      face: pathD(top as { x: number; y: number }[]),
      base: pathD(bot as { x: number; y: number }[]),
      s: sM,
      depth: c.d,
      cx: c.x,
      cy: c.y,
      size: Math.max(...xs) - Math.min(...xs),
      alpha,
      heading: pose.heading,
    })
  }
  return out.sort((a, b) => b.depth - a.depth)
}

/**
 * The live ground layer. `set` when bearing or pitch change, `tick` every frame for
 * the forward flow (static with prefers-reduced-motion).
 */
export function groundArrows(): { el: SVGGElement; set(relDeg: number, betaDeg: number | null): void; tick(dtSec: number): void } {
  const el = s('g', { class: 'ar-stack ar-ground' })
  const slots: { g: SVGGElement; base: SVGPathElement; face: SVGPathElement }[] = []
  for (let i = 0; i <= CHEVRONS; i++) {
    const base = s('path', { class: 'ar-chev-base', fill: AR_BLUE_DARK, stroke: AR_BLUE_DARK, 'stroke-linejoin': 'round' })
    const face = s('path', { class: 'ar-chev-face', fill: AR_ARROW_BLUE, stroke: '#fff', 'stroke-linejoin': 'round', 'paint-order': 'stroke' })
    const g = s('g', { class: 'ar-chev' }, base, face)
    slots.push({ g, base, face })
    el.append(g)
  }
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  let rel = 0
  let beta: number | null = null
  let flow = calm ? 1 : 0.5
  let sign: 1 | -1 | 0 = 0
  const draw = () => {
    const turn = pathTurn(rel, sign)
    if (Math.abs(turn) > 20) sign = turn > 0 ? 1 : -1
    const list = groundChevrons(rel, beta, flow, sign)
    slots.forEach((slot, i) => {
      const c = list[i]
      if (!c) {
        slot.g.setAttribute('visibility', 'hidden')
        return
      }
      slot.g.setAttribute('visibility', 'visible')
      slot.g.setAttribute('opacity', c.alpha.toFixed(2))
      slot.base.setAttribute('d', c.base)
      slot.face.setAttribute('d', c.face)
      const sw = Math.max(1.5, Math.min(6, c.size * 0.028))
      slot.face.setAttribute('stroke-width', sw.toFixed(1))
      slot.base.setAttribute('stroke-width', (sw * 0.6).toFixed(1))
    })
  }
  draw()
  return {
    el,
    set(r, b) {
      rel = Number.isFinite(r) ? r : 0
      beta = b
      draw()
    },
    tick(dt) {
      if (calm || !(dt > 0)) return
      flow = (flow + (Math.min(dt, 0.1) * FLOW_MPS) / SPACING_M) % 1
      draw()
    },
  }
}
