import { afterEach, describe, expect, it, vi } from 'vitest'
import { destination } from '../src/core/geo'
import { createFixFilter, watchFixes, type Fix } from '../src/core/position'

const START = { lat: 52.5272, lon: 13.3711 }

type Cb = (p: GeolocationPosition) => void
function fakeGeo() {
  const watches = new Map<number, { ok: Cb; err?: (e: GeolocationPositionError) => void; opts?: PositionOptions }>()
  let next = 1
  return {
    watches,
    geolocation: {
      watchPosition: vi.fn((ok: Cb, err?: (e: GeolocationPositionError) => void, opts?: PositionOptions) => {
        const id = next++
        watches.set(id, { ok, err, opts })
        return id
      }),
      clearWatch: vi.fn((id: number) => void watches.delete(id)),
      getCurrentPosition: vi.fn(),
    },
    emit(lat: number, lon: number, accuracy: number, t: number, heading: number | null = null, speed: number | null = null) {
      for (const w of watches.values())
        w.ok({ coords: { latitude: lat, longitude: lon, accuracy, heading, speed, altitude: null, altitudeAccuracy: null }, timestamp: t } as GeolocationPosition)
    },
  }
}

const raw = (p: { lat: number; lon: number }, accuracy: number, t: number, heading: number | null = null, speed: number | null = null) => ({
  lat: p.lat, lng: p.lon, accuracy, heading, speed, t,
})

afterEach(() => vi.unstubAllGlobals())

describe('watchFixes on navigator.geolocation', () => {
  it('asks for high accuracy, no cache, and stop() clears the watch', () => {
    const g = fakeGeo()
    vi.stubGlobal('navigator', { geolocation: g.geolocation })
    vi.stubGlobal('location', { search: '' })
    const fixes: Fix[] = []
    const stop = watchFixes((f) => fixes.push(f))
    expect(g.watches.size).toBe(1)
    const opts = [...g.watches.values()][0].opts
    expect(opts).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 })
    g.emit(START.lat, START.lon, 5, 1000)
    expect(fixes[0]).toMatchObject({ lat: START.lat, lng: START.lon, accuracy: 5, t: 1000 })
    stop()
    stop()
    expect(g.watches.size).toBe(0)
    expect(g.geolocation.clearWatch).toHaveBeenCalledTimes(1)
  })

  it('never touches the sim without ?sim=1', () => {
    const g = fakeGeo()
    vi.stubGlobal('navigator', { geolocation: g.geolocation })
    vi.stubGlobal('location', { search: '?demo=1&track=tracks/hbf-approach-synthetic.json' })
    const stop = watchFixes(() => {})
    expect(g.geolocation.watchPosition).toHaveBeenCalledTimes(1)
    stop()
  })

  it('reports a denied permission in German', () => {
    const g = fakeGeo()
    vi.stubGlobal('navigator', { geolocation: g.geolocation })
    vi.stubGlobal('location', { search: '' })
    const errs: string[] = []
    const stop = watchFixes(() => {}, (m) => errs.push(m))
    ;[...g.watches.values()][0].err?.({ code: 1, message: 'denied' } as GeolocationPositionError)
    expect(errs).toEqual(['Standortzugriff verweigert'])
    stop()
  })

  it('reports a missing geolocation instead of throwing', () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('location', { search: '' })
    const errs: string[] = []
    watchFixes(() => {}, (m) => errs.push(m))()
    expect(errs.length).toBe(1)
  })
})

describe('fix filter', () => {
  it('keeps a bad first fix but drops later ones over 80 m', () => {
    const f = createFixFilter()
    expect(f.push(raw(START, 150, 0))).not.toBeNull()
    expect(f.push(raw(destination(START, 0, 10), 90, 1000))).toBeNull()
    expect(f.push(raw(destination(START, 0, 10), 20, 2000))).not.toBeNull()
  })

  it('ignores jitter under 2 m when standing', () => {
    const f = createFixFilter()
    const a = f.push(raw(START, 5, 0, null, 0))!
    const b = f.push(raw(destination(START, 90, 1.5), 5, 1000, null, 0))!
    expect(b.lat).toBe(a.lat)
    expect(b.lng).toBe(a.lng)
  })

  it('uses the course when walking faster than 0.5 m/s', () => {
    const f = createFixFilter()
    f.push(raw(START, 5, 0, 42, 1.4))
    expect(f.push(raw(destination(START, 42, 1.4), 5, 1000, 42, 1.4))!.headingDeg).toBe(42)
  })

  it('falls back to the bearing of fixes 5+ m apart, else null', () => {
    const f = createFixFilter()
    expect(f.push(raw(START, 5, 0, null, null))!.headingDeg).toBeNull()
    expect(f.push(raw(destination(START, 90, 3), 5, 1000, null, 0.2))!.headingDeg).toBeNull()
    const h = f.push(raw(destination(START, 90, 6), 5, 2000, null, 0.2))!.headingDeg!
    expect(h).toBeGreaterThan(88)
    expect(h).toBeLessThan(92)
  })

  it('does not jump backwards along a walk, but follows a real turn back', () => {
    const f = createFixFilter()
    let t = 0
    let last: Fix | null = null
    for (let m = 0; m <= 20; m += 1.4) last = f.push(raw(destination(START, 0, m), 5, (t += 1000), 0, 1.4))
    const held = f.push(raw(destination(START, 0, 16), 5, (t += 1000), 0, 1.4))!
    expect(held.lat).toBe(last!.lat)
    // Walking back for real: the course says 180 now, so the step is forwards again.
    const back = f.push(raw(destination(START, 0, 14), 5, (t += 1000), 180, 1.4))!
    expect(back.lat).toBeLessThan(last!.lat)
  })

  it('computes speed from successive fixes when the device gives none', () => {
    const f = createFixFilter()
    f.push(raw(START, 5, 0))
    expect(f.push(raw(destination(START, 0, 3), 5, 2000))!.speed).toBeCloseTo(1.5, 1)
  })
})
