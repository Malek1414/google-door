// Live View AR layer, measured frame by frame from a Google Maps Live View recording.
//
// The chevrons are the thing people recognise, and the detail that makes them read as
// Google's is that they are EXTRUDED SOLIDS, not flat arrows: a white face with blue
// sides, lit from the upper right so the blue shows on the left and underneath. Three
// of them, overlapping, drifting slightly.
//
// What we cannot copy: Google anchors these in the world with VPS, so they stay nailed
// to the pavement as the camera moves. We have a compass, so ours track bearing instead.
// Everything else — geometry, colour, the phase flow, the cards — is reproducible.

import { s } from './dom'

export const AR_BLUE = '#1b56c4'
export const AR_BLUE_DARK = '#123a86'
export const AR_FACE = '#ffffff'

/** One chevron: white face over a blue body offset down-left, which reads as extrusion. */
function chevron(idx: number): SVGGElement {
  // Classic ">" with a notched tail. 0,0 is the top-left of the body.
  const d = 'M0 0 L26 0 L60 40 L26 80 L0 80 L34 40 Z'
  const g = s('g', { class: 'ar-chev', 'data-i': String(idx) })
  // body (the extruded sides), then the face lifted up and right
  g.append(
    s('path', { d, fill: AR_BLUE, transform: 'translate(0 0)' }),
    s('path', { d, fill: AR_BLUE_DARK, transform: 'translate(4 4)', opacity: '0.55' }),
    s('path', { d, fill: AR_FACE, transform: 'translate(15 -7)' }),
    // thin blue rim on the face so it never melts into a bright background
    s('path', { d, fill: 'none', stroke: AR_BLUE, 'stroke-width': '2.5', transform: 'translate(15 -7)' }),
  )
  return g
}

/** Three overlapping chevrons, the middle one largest, as in the recording. */
export function chevronStack(): SVGGElement {
  const g = s('g', { class: 'ar-stack' })
  for (let i = 0; i < 3; i++) {
    const c = chevron(i)
    // Spread along the travel axis, NEAREST FIRST and largest, shrinking as they
    // recede — so the group reads as three solids going away into the scene rather
    // than as three stickers on the glass.
    const sc = [1, 0.88, 0.76][i]
    c.setAttribute('transform', `translate(${i * 88} ${(1 - sc) * 46}) scale(${sc})`)
    g.append(c)
  }
  return g
}

/** The red Maps teardrop that replaces the chevrons on approach. Hole is see-through. */
export function destinationPin(): SVGGElement {
  const g = s('g', { class: 'ar-pin' })
  g.append(
    s('path', {
      d: 'M0 -62 C-34 -62 -62 -34 -62 0 C-62 34 -20 72 0 96 C20 72 62 34 62 0 C62 -34 34 -62 0 -62 Z',
      fill: '#ea3323',
    }),
    // specular edge, upper left, so it reads as a solid object rather than a sticker
    s('path', {
      d: 'M0 -62 C-34 -62 -62 -34 -62 0 C-62 12 -56 26 -47 40 C-58 18 -52 -8 -34 -26 C-20 -40 -2 -46 0 -62 Z',
      fill: '#ff6a5c', opacity: '0.55',
    }),
    s('circle', { cx: '0', cy: '-4', r: '25', fill: '#000', 'fill-opacity': '0.001' }),
    s('circle', { cx: '0', cy: '-4', r: '25', fill: 'none', stroke: '#ea3323', 'stroke-width': '0' }),
  )
  // punch the hole with a mask so the scene shows through, exactly as Google's does
  const mask = s('mask', { id: 'ar-pin-hole' })
  mask.append(
    s('rect', { x: '-80', y: '-80', width: '160', height: '190', fill: '#fff' }),
    s('circle', { cx: '0', cy: '-4', r: '25', fill: '#000' }),
  )
  g.prepend(mask)
  g.querySelectorAll('path').forEach((p) => p.setAttribute('mask', 'url(#ar-pin-hole)'))
  return g
}

export type ArPhase = 'scanning' | 'ready' | 'guiding' | 'approach' | 'arrived'

/**
 * How far off-bearing before the stack reads as "turn" rather than "ahead".
 * Google keeps chevrons pointing forward well past 20 degrees, then swings hard.
 */
export const TURN_DEG = 22

/** Where the chevrons sit on the pavement: this far below the camera axis when upright. */
export const GROUND_DEPRESSION_DEG = 22

/**
 * Pure. Projects the chevrons onto the ground at the phone's tilt.
 * `betaDeg` is DeviceOrientationEvent.beta: 90 = phone upright, 0 = flat, looking down.
 *
 * squash: the ground is seen at (90 - beta) + GROUND_DEPRESSION_DEG below the horizon,
 *   so a flat shape on it is foreshortened by the sine of that angle. Upright phone:
 *   strongly flattened; pointing down at the pavement: seen face on.
 * cyFrac: the same patch of pavement moves up the screen as the phone tilts down.
 */
export function groundPlane(betaDeg: number): { squash: number; cyFrac: number } {
  const beta = Math.max(0, Math.min(110, betaDeg))
  const incl = Math.max(14, Math.min(90, 90 - beta + GROUND_DEPRESSION_DEG))
  const squash = Math.sin((incl * Math.PI) / 180)
  // Vertical field of view about 60 degrees: tan(30) of half the height per unit.
  const off = Math.tan(((GROUND_DEPRESSION_DEG - (90 - beta)) * Math.PI) / 180) / Math.tan(Math.PI / 6)
  const cyFrac = Math.max(0.36, Math.min(0.64, 0.5 + 0.5 * off))
  return { squash, cyFrac }
}

/**
 * Chevron transform for a relative bearing. Fakes a Y-axis rotation with scaleX.
 * With `betaDeg` (device pitch) the stack is laid on the ground plane: the in-plane
 * rotation is squashed vertically by the ground's foreshortening and placed where
 * that patch of pavement is on screen. Without it (no orientation events yet) the
 * output is exactly the old fixed-screen placement.
 */
export function stackTransform(relDeg: number, w: number, h: number, betaDeg?: number | null): string {
  const clamped = Math.max(-180, Math.min(180, relDeg))
  // The chevron path points RIGHT, so -90 makes it point up-screen (away from the
  // viewer) when you are on bearing — which is how Google's read when walking straight.
  const rot = clamped - 90
  // Mild foreshortening as the stack swings away, floored so it never vanishes.
  // No mirroring: the rotation alone carries direction, and a scaleX flip made the
  // chevrons point left while walking straight ahead.
  const sx = Math.max(0.45, Math.abs(Math.cos((clamped * Math.PI) / 360)))
  const cx = w * 0.5
  const SIZE = 1.35 // measured against the recording: the stack spans ~45% of the width
  const tail = `rotate(${rot.toFixed(1)}) scale(${(sx * SIZE).toFixed(3)} ${SIZE}) translate(-128 -40)`
  if (betaDeg === undefined || betaDeg === null || !Number.isFinite(betaDeg)) {
    return `translate(${cx} ${h * 0.44}) ${tail}`
  }
  const g = groundPlane(betaDeg)
  return `translate(${cx} ${(h * g.cyFrac).toFixed(1)}) scale(1 ${g.squash.toFixed(3)}) ${tail}`
}
