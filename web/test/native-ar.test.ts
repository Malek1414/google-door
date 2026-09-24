import { describe, expect, it, vi } from 'vitest'
import type { Route } from '../src/core/route'
import type { ArrowTarget } from '../src/core/target'
import { buildPayload, EVENT_HOOK, HANDLER, nativeArAvailable, openNativeAr, OPEN_TIMEOUT_MS, type NativeArEvent, type NativeWindow } from '../src/ui/nativeAr'

const TARGET = { lat: 52.5272097, lon: 13.3711667, entrance: { approachBearing: 180 } } as unknown as ArrowTarget

const ROUTE: Route = {
  found: true,
  distanceM: 90,
  path: [
    [52.5265, 13.3705],
    [52.5268, 13.3708],
    [52.5272, 13.3711],
  ],
  steps: [
    { distanceM: 40, maneuver: 'DEPART', text: 'Nach Norden\nRichtung Hbf', endLat: 52.5268, endLon: 13.3708 },
    { distanceM: 50, maneuver: 'TURN_LEFT', text: 'Links abbiegen', endLat: 52.5272, endLon: 13.3711 },
  ],
}

function fakeWindow(opts: { flag?: unknown; handler?: boolean } = {}) {
  const posted: unknown[] = []
  const w: NativeWindow = {
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id) => clearTimeout(id),
  }
  if ('flag' in opts) w.doorwayNative = { arLiveView: opts.flag }
  if (opts.handler !== false) w.webkit = { messageHandlers: { [HANDLER]: { postMessage: (b) => posted.push(b) } } }
  return { w, posted }
}

describe('nativeArAvailable: only the iOS wrapper with the flag and the handler', () => {
  it('a browser has neither', () => {
    expect(nativeArAvailable({ setTimeout: () => 0, clearTimeout: () => {} })).toBe(false)
  })
  it('the flag must be exactly true', () => {
    expect(nativeArAvailable(fakeWindow({ flag: 'true' }).w)).toBe(false)
    expect(nativeArAvailable(fakeWindow({ flag: false }).w)).toBe(false)
    expect(nativeArAvailable(fakeWindow({ flag: true }).w)).toBe(true)
  })
  it('a flag without the message handler is not enough', () => {
    expect(nativeArAvailable(fakeWindow({ flag: true, handler: false }).w)).toBe(false)
  })
})

describe('buildPayload', () => {
  it('pins each instruction to where its step starts', () => {
    const p = buildPayload(ROUTE, TARGET, 'Haupteingang')!
    expect(p.route).toHaveLength(3)
    expect(p.door).toEqual({ lat: 52.5272097, lng: 13.3711667, name: 'Haupteingang', approachBearing: 180 })
    expect(p.steps).toEqual([
      { text: 'Nach Norden', lat: 52.5265, lng: 13.3705, maneuver: 'DEPART' },
      { text: 'Links abbiegen', lat: 52.5268, lng: 13.3708, maneuver: 'TURN_LEFT' },
    ])
  })
  it('no route, no payload: the web Live View takes it', () => {
    expect(buildPayload({ ...ROUTE, found: false }, TARGET, 'x')).toBeNull()
    expect(buildPayload({ ...ROUTE, path: [[52.5, 13.3]] }, TARGET, 'x')).toBeNull()
  })
})

describe('openNativeAr: fallback when native cannot run', () => {
  const payload = buildPayload(ROUTE, TARGET, 'Haupteingang')!

  it('returns null in a browser, so the caller shows the web Live View', () => {
    const { w } = fakeWindow({ handler: false })
    expect(openNativeAr(payload, () => {}, w)).toBeNull()
  })

  it('posts the route and relays events until the last one', () => {
    const { w, posted } = fakeWindow({ flag: true })
    const seen: NativeArEvent[] = []
    expect(openNativeAr(payload, (e) => seen.push(e), w)).not.toBeNull()
    expect(posted).toEqual([{ op: 'open', ...payload }])
    w[EVENT_HOOK]!({ type: 'localizing' })
    w[EVENT_HOOK]!({ type: 'nonsense' })
    w[EVENT_HOOK]!({ type: 'tracking' })
    w[EVENT_HOOK]!({ type: 'arrived', via: 'distance' })
    expect(w[EVENT_HOOK]).toBeUndefined()
    expect(seen).toEqual([{ type: 'localizing' }, { type: 'tracking' }, { type: 'arrived', via: 'distance' }])
  })

  it('an error event (no credentials, no VPS) reaches the caller once', () => {
    const { w } = fakeWindow({ flag: true })
    const seen: NativeArEvent[] = []
    openNativeAr(payload, (e) => seen.push(e), w)
    const hook = w[EVENT_HOOK]!
    hook({ type: 'error', reason: 'not-configured' })
    hook({ type: 'closed' })
    expect(seen).toEqual([{ type: 'error', reason: 'not-configured' }])
  })

  it('a native side that never answers counts as an error', () => {
    vi.useFakeTimers()
    try {
      const { w } = fakeWindow({ flag: true })
      const seen: NativeArEvent[] = []
      openNativeAr(payload, (e) => seen.push(e), w)
      vi.advanceTimersByTime(OPEN_TIMEOUT_MS + 1)
      expect(seen).toEqual([{ type: 'error', reason: 'no-response' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a throwing message handler is a fallback, not a crash', () => {
    const { w } = fakeWindow({ flag: true })
    w.webkit!.messageHandlers![HANDLER] = { postMessage: () => { throw new Error('gone') } }
    expect(openNativeAr(payload, () => {}, w)).toBeNull()
    expect(w[EVENT_HOOK]).toBeUndefined()
  })
})
