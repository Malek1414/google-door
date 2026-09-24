import { describe, expect, it } from 'vitest'
import {
  CHEVRONS,
  FIRST_M,
  MAX_TURN_DEG,
  VIEW_H,
  VIEW_W,
  depressionFor,
  groundChevrons,
  horizonY,
  pathPoint,
  pathTurn,
  project,
} from '../src/ui/ar'
import { CAMERA_CONSTRAINTS, cameraErrorKind, streamLive } from '../src/core/camera'

const near = (list: ReturnType<typeof groundChevrons>) => list[list.length - 1]
const far = (list: ReturnType<typeof groundChevrons>) => list[0]

describe('ground plane projection', () => {
  it('upright phone: horizon at mid screen, the pavement below it', () => {
    expect(depressionFor(90)).toBe(0)
    expect(horizonY(90)).toBeCloseTo(VIEW_H / 2, 5)
    const p = project(0, 5, 0)!
    expect(p.x).toBeCloseTo(VIEW_W / 2, 5)
    expect(p.y).toBeGreaterThan(VIEW_H / 2)
  })
  it('tilting the phone down moves the same patch of pavement up the screen', () => {
    const ys = [90, 75, 60, 45].map((b) => project(0, 5, depressionFor(b))!.y)
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThan(ys[i - 1])
  })
  it('points behind the camera are not drawn', () => {
    expect(project(0, -2, 10)).toBeNull()
  })
  it('no orientation yet: a walking pose is assumed', () => {
    expect(depressionFor(null)).toBe(depressionFor(75))
  })
})

describe('the painted path', () => {
  for (const beta of [60, 75, 90]) {
    it(`straight ahead at beta ${beta}: chevrons recede up the screen and shrink`, () => {
      const list = groundChevrons(0, beta, 1)
      expect(list.length).toBe(CHEVRONS)
      for (let i = 1; i < list.length; i++) {
        expect(list[i].cy).toBeGreaterThan(list[i - 1].cy) // nearer = lower
        expect(list[i].size).toBeGreaterThan(list[i - 1].size) // nearer = bigger
      }
      for (const c of list) {
        expect(Math.abs(c.cx - VIEW_W / 2)).toBeLessThan(1)
        expect(c.cy).toBeGreaterThan(horizonY(beta)) // on the ground, below the horizon
        expect(c.cy).toBeLessThan(VIEW_H)
      }
      // the nearest one is big enough to read at arm's length
      expect(near(list).size).toBeGreaterThan(110)
    })
  }
  it('a target 30 degrees left bends the path left, nearest chevron still near the centre', () => {
    const list = groundChevrons(-30, 75, 1)
    expect(far(list).cx).toBeLessThan(near(list).cx)
    expect(far(list).heading).toBeLessThan(-20)
    expect(Math.abs(near(list).cx - VIEW_W / 2)).toBeLessThan(VIEW_W / 4)
  })
  it('90 right: the path turns right on the ground, chevrons point right', () => {
    const list = groundChevrons(90, 75, 1)
    expect(far(list).heading).toBeGreaterThan(60)
    expect(far(list).cx).toBeGreaterThan(VIEW_W / 2)
    // mirror image for left
    const left = groundChevrons(-90, 75, 1)
    left.forEach((c, i) => expect(c.cx).toBeCloseTo(VIEW_W - list[i].cx, 3))
  })
  it('behind: a hard painted turn, never a chevron above the horizon or behind the camera', () => {
    for (const rel of [180, -180, 170, -175]) {
      const list = groundChevrons(rel, 75, 1)
      expect(list.length).toBeGreaterThan(1)
      for (const c of list) expect(c.cy).toBeGreaterThan(horizonY(75))
      expect(Math.abs(pathPoint(20, pathTurn(rel)).heading)).toBe(MAX_TURN_DEG)
    }
  })
  it('near 180 the side already shown is kept, so the path does not flap', () => {
    expect(pathTurn(179, -1)).toBeLessThan(0)
    expect(pathTurn(-179, 1)).toBeGreaterThan(0)
    expect(pathTurn(100, -1)).toBe(100) // a clear side wins
    expect(pathTurn(140)).toBe(MAX_TURN_DEG)
  })
  it('the path starts straight ahead of the feet', () => {
    const p = pathPoint(1, 90)
    expect(Math.abs(p.x)).toBeLessThan(0.05)
    expect(p.z).toBeCloseTo(1, 1)
  })
  it('flow moves the chevrons forward along the path and fades them at the ends', () => {
    const a = groundChevrons(0, 75, 0.2)
    const b = groundChevrons(0, 75, 0.6)
    expect(Math.min(...b.map((c) => c.s))).toBeGreaterThan(Math.min(...a.map((c) => c.s)))
    const first = a.find((c) => c.s < FIRST_M)!
    expect(first.alpha).toBeLessThan(1)
  })
})

describe('camera helpers', () => {
  it('asks for the rear camera at 1280x720, no audio', () => {
    expect(CAMERA_CONSTRAINTS.audio).toBe(false)
    expect(CAMERA_CONSTRAINTS.video).toMatchObject({ facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } })
  })
  it('classifies refusals', () => {
    expect(cameraErrorKind({ name: 'NotAllowedError' })).toBe('denied')
    expect(cameraErrorKind({ name: 'NotReadableError' })).toBe('unavailable')
    expect(cameraErrorKind(null)).toBe('unavailable')
  })
  it('a stream is reusable only with a live video track', () => {
    const st = (state: string) => ({ getVideoTracks: () => [{ readyState: state }] }) as unknown as MediaStream
    expect(streamLive(st('live'))).toBe(true)
    expect(streamLive(st('ended'))).toBe(false)
    expect(streamLive(null)).toBe(false)
  })
})
