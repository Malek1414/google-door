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

/** Google blue and Maps red, flat (no gradients, no extrusion). */
export const AR_ARROW_BLUE = '#1A73E8'
export const AR_PIN_RED = '#EA4335'

/**
 * ONE flat Material arrow, pointing up (0 deg = straight ahead), its visual centre at
 * the origin so rotate() turns it in place. White outline and a soft shadow (ar.css)
 * keep it visible on any camera picture. An invisible ring of the arrow's full reach
 * keeps the group's bounding box centred at every angle. (Name kept for callers.)
 */
export function chevronStack(): SVGGElement {
  const g = s('g', { class: 'ar-stack ar-arrow' })
  g.append(
    s('circle', { r: '78', fill: 'none', stroke: 'none' }),
    s('path', {
      d: 'M0 -72 L62 -2 L26 -2 L26 72 L-26 72 L-26 -2 L-62 -2 Z',
      fill: AR_ARROW_BLUE,
      stroke: '#fff',
      'stroke-width': '5',
      'stroke-linejoin': 'round',
      'paint-order': 'stroke',
    }),
  )
  return g
}

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
export function stackTransform(relDeg: number, w: number, h: number, _betaDeg?: number | null): string {
  // Fixed screen centre, rotation about the arrow's own centre, constant size: nothing
  // but the angle depends on the input (no orbit, no pitch placement, no squash).
  const rot = Number.isFinite(relDeg) ? relDeg : 0
  return `translate(${(w * ARROW_CX).toFixed(1)} ${(h * ARROW_CY).toFixed(1)}) rotate(${rot.toFixed(1)}) scale(${ARROW_SCALE})`
}

/** Arrow placement as fractions of the SVG viewBox, and its size (~43 % of the width). */
export const ARROW_CX = 0.5
export const ARROW_CY = 0.46
export const ARROW_SCALE = 1.35
