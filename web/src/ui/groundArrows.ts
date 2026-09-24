// Ground arrows: blue chevrons lying ON THE PAVEMENT, leading to the door the camera
// has just recognised, the way Google Live View paints its path on the ground.
//
// Two pure parts and one builder:
//   groundGeometry  projects chevrons (and a threshold ring) from the ground plane onto
//                   the screen with a pinhole camera tilted by the device pitch (beta).
//   GroundGate      decides WHEN they may show: only a tier-1 door, only a fresh vision
//                   fix at real confidence, frozen (not updated) while the fix is stale,
//                   gone after that. It never makes a fix trusted itself: the engine and
//                   Malek's StabilityGuard (core/stability.ts) already did that.
//   groundLayer     the SVG the screens put over the camera.

import { lang } from '../strings'
import { s } from './dom'
import './ground.css'

/** Phone held at chest height. */
export const CAMERA_HEIGHT_M = 1.4
/** Vertical field of view of a phone camera held upright (portrait, 1x). */
export const VFOV_DEG = 68
/** /api/door-fix reports bearings on a frame it is told spans 70 degrees (server/approach.py
 *  FIX_PROMPT). Converting through that convention puts the arrows' end where the model
 *  saw the door in the picture, whatever the real lens is. */
export const PROMPT_HFOV_DEG = 70
/** Pitch assumed until the first deviceorientation event: phone held up, tilted a little down. */
export const DEFAULT_BETA_DEG = 72
/** Chevrons drawn at most. */
export const MAX_CHEVRONS = 5
/** Door this close (metres): the threshold ring marks where it is. */
export const RING_NEAR_M = 4
/** Below this the model is not sure enough to paint a path on the ground (door-fix answers
 *  from 0.5; the engine speaks from 0.5; arrows on the pavement ask for more). */
export const GROUND_MIN_CONFIDENCE = 0.65
/** A stale fix keeps its arrows this long, frozen and dimmed, then they go. */
export const FREEZE_MS = 3000
/** "Eingang erkannt" is said again after a new recognition at most this often. */
export const RECOGNISED_GAP_MS = 20_000

const rad = (d: number) => (d * Math.PI) / 180

export const GROUND_TEXT = lang === 'de'
  ? { searching: 'Suche den Eingang …', recognised: 'Eingang erkannt. Folge den Pfeilen am Boden.', seen: 'Eingang erkannt.' }
  : { searching: 'Looking for the entrance …', recognised: 'Entrance recognised. Follow the arrows on the ground.', seen: 'Entrance recognised.' }

export interface Viewport {
  w: number
  h: number
  /** Lowest y on screen that is still camera picture (top of the bottom panel). */
  bottom: number
}

export interface GroundShape {
  /** SVG path in screen pixels. */
  d: string
  /** Centre on screen, for tests and ordering. */
  cx: number
  cy: number
  /** Distance from the user in metres. */
  m: number
  /** Nearer chevrons are more opaque. */
  opacity: number
}

export interface GroundGeometry {
  chevrons: GroundShape[]
  ring: GroundShape | null
  /** Screen x (px) where the door stands on the ground. */
  doorX: number
}

// Chevron in its own ground frame, metres: u to the right, v forward, tip at +v.
const CHEVRON: [number, number][] = [
  [-0.48, -0.16], [0, 0.3], [0.48, -0.16], [0.48, -0.42], [0, 0.04], [-0.48, -0.42],
]

/**
 * Pure. Chevrons on the ground from the user's feet toward the door.
 *
 * relBearingDeg  door relative to the camera centre (the engine's projection), negative left.
 * distanceM      metres to the door; null = unknown (8 m assumed, only for the drawing).
 * betaDeg        DeviceOrientationEvent.beta: 90 upright, 0 flat. null = DEFAULT_BETA_DEG.
 *
 * The door's screen x comes from the bearing in the door-fix convention (PROMPT_HFOV_DEG);
 * the ground direction is the one that lands on that x. The nearest chevron sits just
 * above vp.bottom, the rest recede toward the door, at most MAX_CHEVRONS.
 */
export function groundGeometry(relBearingDeg: number, distanceM: number | null, betaDeg: number | null, vp: Viewport): GroundGeometry {
  const none: GroundGeometry = { chevrons: [], ring: null, doorX: vp.w / 2 }
  if (!Number.isFinite(relBearingDeg) || vp.w <= 0 || vp.h <= 0) return none
  const beta = betaDeg !== null && Number.isFinite(betaDeg) ? betaDeg : DEFAULT_BETA_DEG
  // Tilt below the horizon; clamp so the ground is always in front of the camera.
  const t = rad(Math.max(0, Math.min(80, 90 - beta)))
  const f = vp.h / 2 / Math.tan(rad(VFOV_DEG / 2))
  const xFrac = Math.max(0.06, Math.min(0.94, 0.5 + relBearingDeg / PROMPT_HFOV_DEG))
  const doorX = xFrac * vp.w
  // Door behind or far off to the side: no path to paint; the screen's arrow turns the user.
  if (Math.abs(relBearingDeg) > PROMPT_HFOV_DEG / 2 + 10) return { ...none, doorX }
  const phi = Math.atan((doorX - vp.w / 2) / f)
  const dDoor = Math.max(0.5, Math.min(25, distanceM ?? 8))

  const project = (X: number, Z: number): [number, number] | null => {
    const zc = Z * Math.cos(t) + CAMERA_HEIGHT_M * Math.sin(t)
    if (zc < 0.3) return null
    const yc = CAMERA_HEIGHT_M * Math.cos(t) - Z * Math.sin(t)
    return [vp.w / 2 + (f * X) / zc, vp.h / 2 + (f * yc) / zc]
  }
  const along = (m: number): [number, number] => [m * Math.sin(phi), m * Math.cos(phi)]
  const shape = (pts: [number, number][], m: number, opacity: number): GroundShape | null => {
    const scr = pts.map(([X, Z]) => project(X, Z))
    if (scr.some((p) => p === null)) return null
    const q = scr as [number, number][]
    const cx = q.reduce((a, p) => a + p[0], 0) / q.length
    const cy = q.reduce((a, p) => a + p[1], 0) / q.length
    const d = q.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') + ' Z'
    return { d, cx, cy, m, opacity }
  }

  // Nearest ground distance still visible above the panel: the ray through vp.bottom.
  const alpha = Math.atan((Math.min(vp.bottom, vp.h) - 24 - vp.h / 2) / f)
  const depression = t + alpha
  const dMin = depression > rad(3) ? Math.max(0.8, CAMERA_HEIGHT_M / Math.tan(depression) / Math.cos(phi)) : Infinity

  const chevrons: GroundShape[] = []
  const lastAt = dDoor - 0.9
  if (Number.isFinite(dMin) && lastAt > dMin) {
    const n = Math.max(1, Math.min(MAX_CHEVRONS, Math.floor((lastAt - dMin) / 0.9) + 1))
    const step = n > 1 ? (lastAt - dMin) / (n - 1) : 0
    for (let i = 0; i < n; i++) {
      const m = dMin + i * step
      const [cx, cz] = along(m)
      const pts = CHEVRON.map(([u, v]) => {
        // rotate the chevron so its tip points along phi
        const X = cx + u * Math.cos(phi) + v * Math.sin(phi)
        const Z = cz - u * Math.sin(phi) + v * Math.cos(phi)
        return [X, Z] as [number, number]
      })
      const sh = shape(pts, m, +(1 - (0.5 * i) / Math.max(1, n - 1)).toFixed(2))
      if (sh && sh.cy <= vp.bottom) chevrons.push(sh)
    }
  }

  let ring: GroundShape | null = null
  if (dDoor <= RING_NEAR_M) {
    const [cx, cz] = along(dDoor)
    const pts: [number, number][] = []
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2
      pts.push([cx + 0.55 * Math.cos(a), cz + 0.3 * Math.sin(a)])
    }
    const sh = shape(pts, dDoor, 1)
    if (sh && sh.cy <= vp.bottom && sh.cy >= 0) ring = sh
  }
  return { chevrons, ring, doorX }
}

// ── gate ────────────────────────────────────────────────────────────────────

export type GroundState = 'off' | 'searching' | 'live' | 'frozen'

export interface GroundInput {
  /** Door tier: only 1 carries arrows (safety rule). */
  tier: number | null | undefined
  /** Where the direction comes from. Only the camera recognises a door. */
  source: 'gemini-live' | 'gemini-frame' | 'osm-fallback' | null
  /** Door bearing from a FRESH, trusted fix; null when there is none (stale, lost). */
  relBearingDeg: number | null
  distanceM: number | null
  /** Confidence of the fix behind the bearing. */
  confidence: number | null | undefined
  /** Through the door: nothing left to point at. */
  done?: boolean
}

export interface GroundVerdict {
  state: GroundState
  /** Bearing and distance to draw with ('live'), or the frozen ones ('frozen'). */
  relBearingDeg: number | null
  distanceM: number | null
  /** True exactly once per recognition: haptic plus "Eingang erkannt". */
  recognisedNow: boolean
}

/** Is this input a recognition the ground may show? */
export function recognised(i: GroundInput): boolean {
  return (
    i.tier === 1 &&
    !i.done &&
    (i.source === 'gemini-frame' || i.source === 'gemini-live') &&
    i.relBearingDeg !== null &&
    Number.isFinite(i.relBearingDeg) &&
    typeof i.confidence === 'number' &&
    i.confidence >= GROUND_MIN_CONFIDENCE
  )
}

/**
 * Stateful gate between the engine's view and the ground layer.
 *   not tier 1 / through         -> off
 *   recognised                   -> live (draw every update)
 *   was live, now not recognised -> frozen for FREEZE_MS (last arrows, not updated), then searching
 *   never recognised             -> searching ("Suche den Eingang …")
 */
export class GroundGate {
  private last: { rel: number; dist: number | null } | null = null
  private lostAt: number | null = null
  private wasLive = false
  private lastSaidAt = -Infinity

  push(i: GroundInput, nowMs: number): GroundVerdict {
    if (i.tier !== 1 || i.done) {
      this.last = null
      this.lostAt = null
      this.wasLive = false
      return { state: 'off', relBearingDeg: null, distanceM: null, recognisedNow: false }
    }
    if (recognised(i)) {
      const fresh = !this.wasLive
      this.wasLive = true
      this.lostAt = null
      this.last = { rel: i.relBearingDeg as number, dist: i.distanceM }
      const say = fresh && nowMs - this.lastSaidAt >= RECOGNISED_GAP_MS
      if (say) this.lastSaidAt = nowMs
      return { state: 'live', relBearingDeg: this.last.rel, distanceM: this.last.dist, recognisedNow: say }
    }
    if (this.wasLive && this.last) {
      if (this.lostAt === null) this.lostAt = nowMs
      if (nowMs - this.lostAt < FREEZE_MS) return { state: 'frozen', relBearingDeg: this.last.rel, distanceM: this.last.dist, recognisedNow: false }
      this.wasLive = false
      this.last = null
      this.lostAt = null
    }
    return { state: 'searching', relBearingDeg: null, distanceM: null, recognisedNow: false }
  }
}

// ── builder ─────────────────────────────────────────────────────────────────

/** Full-screen SVG over the camera. `draw` repaints; `set` switches state classes. */
export function groundLayer(): { el: SVGSVGElement; draw: (g: GroundGeometry | null, vp: Viewport, state: GroundState) => void } {
  const el = s('svg', { class: 'ground', 'aria-hidden': 'true', width: '100%', height: '100%' }) as SVGSVGElement
  const chevG = s('g', { class: 'ground-chevrons' })
  const ringEl = s('path', { class: 'ground-ring', d: '' })
  el.append(ringEl, chevG)
  return {
    el,
    draw: (g, vp, state) => {
      el.setAttribute('viewBox', `0 0 ${vp.w.toFixed(0)} ${vp.h.toFixed(0)}`)
      el.dataset.state = state
      const show = g && (state === 'live' || state === 'frozen')
      const list = show ? g.chevrons : []
      // Far first, so the near chevron paints on top.
      const ordered = [...list].sort((a, b) => b.m - a.m)
      while (chevG.childNodes.length > ordered.length) chevG.lastChild?.remove()
      ordered.forEach((c, i) => {
        let p = chevG.childNodes[i] as SVGPathElement | undefined
        if (!p) {
          p = s('path', { class: 'ground-chev' })
          chevG.append(p)
        }
        p.setAttribute('d', c.d)
        p.style.opacity = String(c.opacity)
        // Staggered pulse from near to far (CSS; none under reduced motion).
        p.style.animationDelay = `${((ordered.length - 1 - i) * 0.18).toFixed(2)}s`
      })
      ringEl.setAttribute('d', show && g.ring ? g.ring.d : '')
    },
  }
}

// ── overlay (DOM, sensors) ──────────────────────────────────────────────────

export interface GroundOverlay {
  /** The SVG to put over the camera (under the panels). */
  el: SVGSVGElement
  /** The "Suche den Eingang …" / "Eingang erkannt" chip, placed by the screen. */
  chip: HTMLElement
  /** Feed the latest guidance; called on every view change. */
  push(i: GroundInput): void
  readonly state: GroundState
  /** Chevrons or the ring are on screen right now (live or frozen, door in view). */
  readonly drawing: boolean
  stop(): void
}

/**
 * Wires GroundGate + groundGeometry + groundLayer to the device pitch and a slow
 * re-check (so a stale fix freezes and then clears even when no new view arrives).
 * `bottom` gives the top of the screen's bottom panel; `onRecognised` fires once per
 * recognition (the screen does the haptic and the spoken line: it owns the voice).
 */
export function groundOverlay(opts: {
  bottom: () => number
  onRecognised: () => void
  /** State or drawing changed. `drawing`: arrows are on the pavement (the screen's own
   *  arrow may step aside); a recognised door out of frame draws nothing. */
  onState?: (s: GroundState, drawing: boolean) => void
  now?: () => number
}): GroundOverlay {
  const now = opts.now ?? (() => performance.now())
  const gate = new GroundGate()
  const layer = groundLayer()
  const chipText = document.createElement('span')
  const chip = document.createElement('p')
  chip.className = 'ground-chip'
  chip.setAttribute('role', 'status')
  chip.hidden = true
  chip.append(chipText)
  let beta: number | null = null
  let input: GroundInput | null = null
  let state: GroundState = 'off'
  let frozen: GroundGeometry | null = null
  let drawing = false

  const onOrient = (e: DeviceOrientationEvent) => {
    if (typeof e.beta !== 'number' || !Number.isFinite(e.beta)) return
    beta = beta === null ? e.beta : beta + 0.25 * (e.beta - beta)
  }
  window.addEventListener('deviceorientation', onOrient)

  const vp = (): Viewport => {
    const w = window.innerWidth || 390
    const h = window.innerHeight || 760
    const b = opts.bottom()
    return { w, h, bottom: Number.isFinite(b) && b > 0 ? Math.min(b, h) : h }
  }

  const redraw = () => {
    if (!input) return
    const v = gate.push(input, now())
    if (v.recognisedNow) opts.onRecognised()
    const port = vp()
    let g: GroundGeometry | null = null
    if (v.state === 'live' && v.relBearingDeg !== null) {
      g = groundGeometry(v.relBearingDeg, v.distanceM, beta, port)
      frozen = g
    } else if (v.state === 'frozen') {
      g = frozen
    } else {
      frozen = null
    }
    layer.draw(g, port, v.state)
    const nowDrawing = !!g && (g.chevrons.length > 0 || g.ring !== null)
    if (v.state !== state || nowDrawing !== drawing) {
      state = v.state
      drawing = nowDrawing
      opts.onState?.(state, drawing)
    }
    // "Folge den Pfeilen" only while there are arrows to follow (a door right in front or
    // out of frame has none on the visible pavement).
    const text = v.state === 'live' ? (nowDrawing ? GROUND_TEXT.recognised : GROUND_TEXT.seen) : v.state === 'off' ? '' : GROUND_TEXT.searching
    chip.hidden = !text
    chip.classList.toggle('is-found', v.state === 'live')
    if (chipText.textContent !== text) chipText.textContent = text
  }
  const timer = window.setInterval(redraw, 250)

  return {
    el: layer.el,
    chip,
    push(i) {
      input = i
      redraw()
    },
    get state() {
      return state
    },
    get drawing() {
      return drawing
    },
    stop() {
      window.clearInterval(timer)
      window.removeEventListener('deviceorientation', onOrient)
    },
  }
}
