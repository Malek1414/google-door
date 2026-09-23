// Pure helpers of src/places.ts (viewRadius, haversine, computeOpenNow, toHit, lang) are not
// exported, so they are exercised through searchCategory / searchText against a mocked
// google.maps global. Plus extra edge cases for chipsFor / showDoorMarkers in core/mode.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.TZ = 'UTC'

const searchNearby = vi.fn()
const searchByText = vi.fn()
const importLibrary = vi.fn(async () => ({ Place: { searchNearby, searchByText } }))

type Any = Record<string, unknown>

function latLng(lat: number, lng: number) {
  return { lat: () => lat, lng: () => lng }
}

/** Fake map: centre and (optionally) the north-east corner of its bounds. */
function fakeMap(center: [number, number] | null, ne?: [number, number]): google.maps.Map {
  const c = center ? latLng(center[0], center[1]) : null
  const b = ne ? { getNorthEast: () => latLng(ne[0], ne[1]) } : null
  return { getCenter: () => c, getBounds: () => b } as unknown as google.maps.Map
}

function fakePlace(over: Any = {}): google.maps.places.Place {
  return {
    id: 'p1',
    displayName: 'Café Test',
    location: latLng(52.52, 13.405),
    ...over,
  } as unknown as google.maps.places.Place
}

function period(openDay: number, openHour: number, closeDay?: number, closeHour?: number, openMinute = 0, closeMinute = 0) {
  return closeDay == null
    ? { open: { day: openDay, hour: openHour, minute: openMinute } }
    : { open: { day: openDay, hour: openHour, minute: openMinute }, close: { day: closeDay, hour: closeHour, minute: closeMinute } }
}

const BERLIN = 120 // utcOffsetMinutes in summer

async function hitFor(place: Any) {
  searchNearby.mockResolvedValueOnce({ places: [fakePlace(place)] })
  const hits = await import('../src/places').then((m) => m.searchCategory(fakeMap([52.52, 13.405]), 'kaffee'))
  return hits[0]
}

let places: typeof import('../src/places')

beforeAll(async () => {
  ;(globalThis as Any).google = { maps: { importLibrary } }
  ;(globalThis as Any).document = { documentElement: { lang: '' } }
  places = await import('../src/places')
})

afterAll(() => {
  delete (globalThis as Any).google
  delete (globalThis as Any).document
})

beforeEach(() => {
  searchNearby.mockReset()
  searchByText.mockReset()
  importLibrary.mockClear()
  importLibrary.mockImplementation(async () => ({ Place: { searchNearby, searchByText } }))
  ;(globalThis as Any).document = { documentElement: { lang: '' } }
  searchNearby.mockResolvedValue({ places: [] })
  searchByText.mockResolvedValue({ places: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('searchCategory: radius clamp (viewRadius + haversine)', () => {
  async function radiusFor(map: google.maps.Map): Promise<number> {
    await places.searchCategory(map, 'restaurants')
    const args = searchNearby.mock.calls[0]![0] as { locationRestriction: { radius: number } }
    return args.locationRestriction.radius
  }

  it('falls back to 1500 m when the map has no bounds yet', async () => {
    expect(await radiusFor(fakeMap([52.52, 13.405]))).toBe(1500)
  })
  it('measures centre to north-east corner: 0.01 deg latitude is 1112 m', async () => {
    expect(await radiusFor(fakeMap([52.52, 13.405], [52.53, 13.405]))).toBe(1112)
  })
  it('clamps tiny viewports up to 200 m', async () => {
    expect(await radiusFor(fakeMap([52.52, 13.405], [52.5201, 13.405]))).toBe(200)
  })
  it('clamps huge viewports down to 50 000 m', async () => {
    expect(await radiusFor(fakeMap([52.52, 13.405], [53.52, 13.405]))).toBe(50_000)
  })
  it('returns an integer radius', async () => {
    const r = await radiusFor(fakeMap([52.52, 13.405], [52.5237, 13.41]))
    expect(Number.isInteger(r)).toBe(true)
    expect(r).toBeGreaterThan(200)
    expect(r).toBeLessThan(1000)
  })
  it('passes the chip types, centre and locale through', async () => {
    ;(globalThis as Any).document = { documentElement: { lang: 'en' } }
    await places.searchCategory(fakeMap([52.52, 13.405]), 'einkaufen')
    expect(searchNearby).toHaveBeenCalledWith(
      expect.objectContaining({
        includedPrimaryTypes: ['shopping_mall', 'supermarket'],
        language: 'en',
        region: 'de',
        maxResultCount: 20,
      }),
    )
  })
  it('defaults the language to de when the document has none', async () => {
    await places.searchCategory(fakeMap([52.52, 13.405]), 'hotels')
    expect(searchNearby.mock.calls[0]![0]).toMatchObject({ language: 'de' })
  })
})

describe('searchCategory: guards and errors', () => {
  it('throws on an unknown chip id before touching the SDK', async () => {
    await expect(places.searchCategory(fakeMap([52.52, 13.405]), 'coffee')).rejects.toThrow('Unbekannte Kategorie: coffee')
    expect(importLibrary).not.toHaveBeenCalled()
  })
  it('returns [] without a map centre', async () => {
    expect(await places.searchCategory(fakeMap(null), 'restaurants')).toEqual([])
    expect(importLibrary).not.toHaveBeenCalled()
  })
  it('wraps a failing importLibrary in PlacesUnavailable with cause', async () => {
    const boom = new Error('no places lib')
    importLibrary.mockRejectedValueOnce(boom)
    const err = await places.searchCategory(fakeMap([52.52, 13.405]), 'restaurants').catch((e) => e)
    expect(err).toBeInstanceOf(places.PlacesUnavailable)
    expect(err.cause).toBe(boom)
    expect(err.name).toBe('PlacesUnavailable')
  })
  it('wraps a failing searchNearby in PlacesUnavailable', async () => {
    searchNearby.mockRejectedValueOnce(new Error('403'))
    await expect(places.searchCategory(fakeMap([52.52, 13.405]), 'restaurants')).rejects.toBeInstanceOf(places.PlacesUnavailable)
  })
})

describe('toHit: field mapping and access null handling', () => {
  it('keeps unknown accessibility as null, never false', async () => {
    const h = await hitFor({ accessibilityOptions: undefined })
    expect(h.access).toEqual({ entrance: null, restroom: null, seating: null, parking: null })
  })
  it('keeps null fields inside accessibilityOptions as null', async () => {
    const h = await hitFor({
      accessibilityOptions: {
        hasWheelchairAccessibleEntrance: null,
        hasWheelchairAccessibleRestroom: null,
        hasWheelchairAccessibleSeating: null,
        hasWheelchairAccessibleParking: null,
      },
    })
    expect(h.access).toEqual({ entrance: null, restroom: null, seating: null, parking: null })
  })
  it('passes explicit true/false through unchanged', async () => {
    const h = await hitFor({
      accessibilityOptions: {
        hasWheelchairAccessibleEntrance: true,
        hasWheelchairAccessibleRestroom: false,
        hasWheelchairAccessibleSeating: true,
        hasWheelchairAccessibleParking: false,
      },
    })
    expect(h.access).toEqual({ entrance: true, restroom: false, seating: true, parking: false })
  })
  it('maps the basic fields and turns nulls into undefined', async () => {
    const h = await hitFor({
      rating: 4.5,
      userRatingCount: 12,
      primaryTypeDisplayName: 'Café',
      formattedAddress: 'Unter den Linden 1',
    })
    expect(h).toMatchObject({
      placeId: 'p1',
      name: 'Café Test',
      lat: 52.52,
      lon: 13.405,
      rating: 4.5,
      ratingCount: 12,
      category: 'Café',
      address: 'Unter den Linden 1',
      openNow: null,
    })
    const bare = await hitFor({ displayName: null, rating: null, userRatingCount: null, primaryTypeDisplayName: null, formattedAddress: null })
    expect(bare.name).toBe('')
    expect(bare.rating).toBeUndefined()
    expect(bare.ratingCount).toBeUndefined()
    expect(bare.category).toBeUndefined()
    expect(bare.address).toBeUndefined()
  })
  it('drops places without a location', async () => {
    searchNearby.mockResolvedValueOnce({ places: [fakePlace({ location: null }), fakePlace({ id: 'p2' })] })
    const hits = await places.searchCategory(fakeMap([52.52, 13.405]), 'kaffee')
    expect(hits.map((h) => h.placeId)).toEqual(['p2'])
  })
  it('uses the first photo and survives a throwing getURI', async () => {
    const ok = await hitFor({ photos: [{ getURI: () => 'https://img/1' }, { getURI: () => 'https://img/2' }] })
    expect(ok.photoUrl).toBe('https://img/1')
    const bad = await hitFor({ photos: [{ getURI: () => { throw new Error('quota') } }] })
    expect(bad.photoUrl).toBeUndefined()
    const none = await hitFor({ photos: [] })
    expect(none.photoUrl).toBeUndefined()
  })
})

describe('computeOpenNow (via toHit)', () => {
  // Wednesday 2026-09-23, 12:00 UTC. Local time of the place = UTC + utcOffsetMinutes.
  const WED_NOON_UTC = new Date('2026-09-23T12:00:00Z')
  const WED = 3
  const THU = 4
  const SAT = 6
  const SUN = 0

  function at(iso: string) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(iso))
  }

  it('is null without opening hours or with empty periods', async () => {
    at(WED_NOON_UTC.toISOString())
    expect((await hitFor({})).openNow).toBeNull()
    expect((await hitFor({ regularOpeningHours: null })).openNow).toBeNull()
    expect((await hitFor({ regularOpeningHours: { periods: [] }, utcOffsetMinutes: 0 })).openNow).toBeNull()
  })
  it('is true for a period without close (open 24/7)', async () => {
    at(WED_NOON_UTC.toISOString())
    const h = await hitFor({ regularOpeningHours: { periods: [period(SUN, 0)] }, utcOffsetMinutes: 0 })
    expect(h.openNow).toBe(true)
  })
  it('is true inside and false outside a same-day period', async () => {
    at(WED_NOON_UTC.toISOString())
    const open = await hitFor({ regularOpeningHours: { periods: [period(WED, 9, WED, 18)] }, utcOffsetMinutes: 0 })
    expect(open.openNow).toBe(true)
    const later = await hitFor({ regularOpeningHours: { periods: [period(WED, 13, WED, 18)] }, utcOffsetMinutes: 0 })
    expect(later.openNow).toBe(false)
    const otherDay = await hitFor({ regularOpeningHours: { periods: [period(THU, 9, THU, 18)] }, utcOffsetMinutes: 0 })
    expect(otherDay.openNow).toBe(false)
  })
  it('closing minute is exclusive, opening minute inclusive', async () => {
    at('2026-09-23T12:00:00Z')
    const closesNow = await hitFor({ regularOpeningHours: { periods: [period(WED, 9, WED, 12)] }, utcOffsetMinutes: 0 })
    expect(closesNow.openNow).toBe(false)
    const opensNow = await hitFor({ regularOpeningHours: { periods: [period(WED, 12, WED, 18)] }, utcOffsetMinutes: 0 })
    expect(opensNow.openNow).toBe(true)
  })
  it('applies the place utc offset (Berlin summer: UTC+2)', async () => {
    at('2026-09-23T07:30:00Z') // 09:30 in Berlin
    const open = await hitFor({ regularOpeningHours: { periods: [period(WED, 9, WED, 18)] }, utcOffsetMinutes: BERLIN })
    expect(open.openNow).toBe(true)
    at('2026-09-23T06:30:00Z') // 08:30 in Berlin
    const closed = await hitFor({ regularOpeningHours: { periods: [period(WED, 9, WED, 18)] }, utcOffsetMinutes: BERLIN })
    expect(closed.openNow).toBe(false)
  })
  it('offset can push the local day forward past midnight', async () => {
    at('2026-09-23T23:30:00Z') // Thursday 01:30 in Berlin
    const h = await hitFor({ regularOpeningHours: { periods: [period(THU, 1, THU, 5)] }, utcOffsetMinutes: BERLIN })
    expect(h.openNow).toBe(true)
    const wed = await hitFor({ regularOpeningHours: { periods: [period(WED, 22, WED, 23, 0, 59)] }, utcOffsetMinutes: BERLIN })
    expect(wed.openNow).toBe(false)
  })
  it('handles overnight periods (22:00 to 02:00 next day)', async () => {
    const bar = { periods: [period(WED, 22, THU, 2)] }
    at('2026-09-23T23:30:00Z')
    expect((await hitFor({ regularOpeningHours: bar, utcOffsetMinutes: 0 })).openNow).toBe(true)
    at('2026-09-24T01:00:00Z')
    expect((await hitFor({ regularOpeningHours: bar, utcOffsetMinutes: 0 })).openNow).toBe(true)
    at('2026-09-24T02:00:00Z')
    expect((await hitFor({ regularOpeningHours: bar, utcOffsetMinutes: 0 })).openNow).toBe(false)
    at('2026-09-23T21:59:00Z')
    expect((await hitFor({ regularOpeningHours: bar, utcOffsetMinutes: 0 })).openNow).toBe(false)
  })
  it('handles the Saturday-to-Sunday week wrap', async () => {
    const club = { periods: [period(SAT, 22, SUN, 2)] }
    at('2026-09-27T01:00:00Z') // Sunday 01:00
    expect((await hitFor({ regularOpeningHours: club, utcOffsetMinutes: 0 })).openNow).toBe(true)
    at('2026-09-26T23:00:00Z') // Saturday 23:00
    expect((await hitFor({ regularOpeningHours: club, utcOffsetMinutes: 0 })).openNow).toBe(true)
    at('2026-09-27T03:00:00Z') // Sunday 03:00
    expect((await hitFor({ regularOpeningHours: club, utcOffsetMinutes: 0 })).openNow).toBe(false)
  })
  it('any matching period among several wins', async () => {
    at(WED_NOON_UTC.toISOString())
    const split = { periods: [period(WED, 8, WED, 11), period(WED, 11, WED, 13, 30, 0), period(THU, 8, THU, 18)] }
    expect((await hitFor({ regularOpeningHours: split, utcOffsetMinutes: 0 })).openNow).toBe(true)
    const gap = { periods: [period(WED, 8, WED, 11), period(WED, 14, WED, 18)] }
    expect((await hitFor({ regularOpeningHours: gap, utcOffsetMinutes: 0 })).openNow).toBe(false)
  })
  it('prefers currentOpeningHours over regularOpeningHours', async () => {
    at(WED_NOON_UTC.toISOString())
    const h = await hitFor({
      regularOpeningHours: { periods: [period(WED, 9, WED, 18)] },
      currentOpeningHours: { periods: [period(WED, 14, WED, 18)] }, // holiday: opens late today
      utcOffsetMinutes: 0,
    })
    expect(h.openNow).toBe(false)
  })
  it('without utcOffsetMinutes it uses the device clock', async () => {
    at(WED_NOON_UTC.toISOString())
    const n = new Date()
    const open = period(n.getDay(), n.getHours(), n.getDay(), n.getHours() + 1, n.getMinutes(), n.getMinutes())
    expect((await hitFor({ regularOpeningHours: { periods: [open] } })).openNow).toBe(true)
    const shifted = period(n.getDay(), n.getHours() + 1, n.getDay(), n.getHours() + 2, n.getMinutes(), n.getMinutes())
    expect((await hitFor({ regularOpeningHours: { periods: [shifted] } })).openNow).toBe(false)
  })
})

describe('searchText', () => {
  it('returns [] for blank queries without calling the SDK', async () => {
    expect(await places.searchText(fakeMap([52.52, 13.405]), '   ')).toEqual([])
    expect(importLibrary).not.toHaveBeenCalled()
  })
  it('trims the query and biases to the bounds when present', async () => {
    const map = fakeMap([52.52, 13.405], [52.53, 13.41])
    await places.searchText(map, '  Bäckerei ')
    const args = searchByText.mock.calls[0]![0] as Any
    expect(args.textQuery).toBe('Bäckerei')
    expect(args.locationBias).toBe(map.getBounds())
  })
  it('falls back to the centre as bias and omits it entirely without one', async () => {
    const centred = fakeMap([52.52, 13.405])
    await places.searchText(centred, 'Kino')
    expect((searchByText.mock.calls[0]![0] as Any).locationBias).toBe(centred.getCenter())
    searchByText.mockClear()
    await places.searchText(fakeMap(null), 'Kino')
    expect('locationBias' in (searchByText.mock.calls[0]![0] as Any)).toBe(false)
  })
  it('maps results through toHit and wraps SDK failures', async () => {
    searchByText.mockResolvedValueOnce({ places: [fakePlace({ id: 'x', location: null }), fakePlace({ id: 'y' })] })
    const hits = await places.searchText(fakeMap([52.52, 13.405]), 'Kino')
    expect(hits.map((h) => h.placeId)).toEqual(['y'])
    searchByText.mockRejectedValueOnce(new Error('nope'))
    await expect(places.searchText(fakeMap([52.52, 13.405]), 'Kino')).rejects.toBeInstanceOf(places.PlacesUnavailable)
  })
})

describe('NORMAL_CHIPS', () => {
  it('has unique ids and non-empty type lists', () => {
    const ids = places.NORMAL_CHIPS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of places.NORMAL_CHIPS) {
      expect(c.types.length).toBeGreaterThan(0)
      expect(c.labelDe).not.toBe('')
      expect(c.labelEn).not.toBe('')
      expect(c.icon).not.toBe('')
    }
  })
})

describe('mode: chipsFor / showDoorMarkers edge cases', () => {
  it('returns the exact standard list in Google Maps order', async () => {
    const { chipsFor } = await import('../src/core/mode')
    expect(chipsFor('standard')).toEqual(['restaurants', 'coffee', 'shopping', 'hotels', 'transit', 'parking'])
  })
  it('returns a fresh copy each call so callers cannot mutate the source list', async () => {
    const { chipsFor } = await import('../src/core/mode')
    const a = chipsFor('access')
    a.push('restaurants')
    expect(chipsFor('access')).toEqual(['stepFree', 'withSteps', 'automatic', 'noRevolving'])
    expect(chipsFor('access')).not.toBe(chipsFor('access'))
  })
  it('standard and access chip sets are disjoint', async () => {
    const { chipsFor } = await import('../src/core/mode')
    const std = new Set(chipsFor('standard'))
    for (const id of chipsFor('access')) expect(std.has(id)).toBe(false)
  })
  it('door markers appear exactly when access chips are active', async () => {
    const { chipsFor, showDoorMarkers } = await import('../src/core/mode')
    for (const m of ['standard', 'access'] as const) {
      expect(showDoorMarkers(m)).toBe(chipsFor(m).includes('stepFree'))
    }
  })
  it('door markers is a pure function of the mode', async () => {
    const { showDoorMarkers } = await import('../src/core/mode')
    expect(showDoorMarkers('access')).toBe(showDoorMarkers('access'))
    expect(showDoorMarkers('standard')).toBe(false)
  })
})
