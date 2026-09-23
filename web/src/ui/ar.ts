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

/** Chevron transform for a relative bearing. Fakes a Y-axis rotation with scaleX. */
export function stackTransform(relDeg: number, w: number, h: number): string {
  const clamped = Math.max(-180, Math.min(180, relDeg))
  // The chevron path points RIGHT, so -90 makes it point up-screen (away from the
  // viewer) when you are on bearing — which is how Google's read when walking straight.
  const rot = clamped - 90
  // Mild foreshortening as the stack swings away, floored so it never vanishes.
  // No mirroring: the rotation alone carries direction, and a scaleX flip made the
  // chevrons point left while walking straight ahead.
  const sx = Math.max(0.45, Math.abs(Math.cos((clamped * Math.PI) / 360)))
  const cx = w * 0.5
  const cy = h * 0.44
  const SIZE = 1.35 // measured against the recording: the stack spans ~45% of the width
  return (
    `translate(${cx} ${cy}) rotate(${rot.toFixed(1)}) ` +
    `scale(${(sx * SIZE).toFixed(3)} ${SIZE}) translate(-128 -40)`
  )
}
