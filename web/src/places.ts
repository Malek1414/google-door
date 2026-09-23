// Places API (New) through the Maps JS SDK: category chips and text search.
// Uses google.maps.importLibrary('places') -> Place.searchNearby / Place.searchByText.
// No UI here. Unknown accessibility stays null, never coerced to false.

export interface PlaceChip {
  id: string
  labelDe: string
  labelEn: string
  /** Material Symbols name. */
  icon: string
  types: string[]
}

export const NORMAL_CHIPS: readonly PlaceChip[] = [
  { id: 'restaurants', labelDe: 'Restaurants', labelEn: 'Restaurants', icon: 'restaurant', types: ['restaurant'] },
  { id: 'kaffee', labelDe: 'Kaffee', labelEn: 'Coffee', icon: 'local_cafe', types: ['cafe'] },
  { id: 'einkaufen', labelDe: 'Einkaufen', labelEn: 'Shopping', icon: 'shopping_bag', types: ['shopping_mall', 'supermarket'] },
  { id: 'hotels', labelDe: 'Hotels', labelEn: 'Hotels', icon: 'hotel', types: ['lodging'] },
  { id: 'tankstellen', labelDe: 'Tankstellen', labelEn: 'Gas', icon: 'local_gas_station', types: ['gas_station'] },
  { id: 'apotheken', labelDe: 'Apotheken', labelEn: 'Pharmacies', icon: 'local_pharmacy', types: ['pharmacy'] },
]

export interface PlaceAccess {
  entrance: boolean | null
  restroom: boolean | null
  seating: boolean | null
  parking: boolean | null
}

export interface PlaceHit {
  placeId: string
  name: string
  lat: number
  lon: number
  rating?: number
  ratingCount?: number
  category?: string
  address?: string
  /** true/false when opening hours allow a verdict, null when unknown. */
  openNow?: boolean | null
  photoUrl?: string
  /** Up to three photo URLs, the first equals photoUrl. */
  photoUrls?: string[]
  /** National format, e.g. "030 1234567". */
  phone?: string
  website?: string
  /** Open around the clock. */
  open24?: boolean
  /** "HH:MM" local time of the next close while open (absent for 24/7). */
  closesAt?: string
  /** "HH:MM" local time of the next opening while closed. */
  opensAt?: string
  /** Days until opensAt: 0 today, 1 tomorrow, ... */
  opensInDays?: number
  /** Weekday of opensAt, 0 = Sunday. */
  opensWeekday?: number
  access: PlaceAccess
}

export class PlacesUnavailable extends Error {
  readonly cause?: unknown
  constructor(cause?: unknown) {
    super('Places API (New) ist für diesen Schlüssel nicht aktiviert')
    this.name = 'PlacesUnavailable'
    this.cause = cause
  }
}

const FIELDS = [
  'id',
  'displayName',
  'location',
  'rating',
  'userRatingCount',
  'primaryTypeDisplayName',
  'formattedAddress',
  'regularOpeningHours',
  'currentOpeningHours',
  'utcOffsetMinutes',
  'accessibilityOptions',
  'photos',
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'websiteURI',
]

const MAX_RESULTS = 20
const MAX_RADIUS_M = 50_000
const MIN_RADIUS_M = 200

async function placesLib(): Promise<google.maps.PlacesLibrary> {
  try {
    return await google.maps.importLibrary('places')
  } catch (err) {
    throw new PlacesUnavailable(err)
  }
}

function lang(): string {
  return document.documentElement.lang || 'de'
}

/** Radius that covers the visible map (centre to corner), clamped to what searchNearby accepts. */
function viewRadius(map: google.maps.Map, center: google.maps.LatLng): number {
  const b = map.getBounds()
  if (!b) return 1500
  const ne = b.getNorthEast()
  const r = haversine(center.lat(), center.lng(), ne.lat(), ne.lng())
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(r)))
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

const WEEK_MIN = 7 * 24 * 60

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (weekMin: number) => {
  const m = ((weekMin % 1440) + 1440) % 1440
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

export interface OpenState {
  openNow: boolean | null
  open24?: boolean
  closesAt?: string
  opensAt?: string
  opensInDays?: number
  opensWeekday?: number
}

type Period = { open: { day: number; hour: number; minute: number }; close?: { day: number; hour: number; minute: number } | null }

/** Open-now verdict plus next close/open time from weekly periods; nowMin = minutes since Sunday 00:00 local. */
export function openStateAt(periods: readonly Period[] | null | undefined, nowMin: number): OpenState {
  if (!periods || periods.length === 0) return { openNow: null }
  const iv: [number, number][] = []
  for (const p of periods) {
    if (!p.close) return { openNow: true, open24: true } // Places marks 24/7 as one period without close
    const open = p.open.day * 1440 + p.open.hour * 60 + p.open.minute
    let close = p.close.day * 1440 + p.close.hour * 60 + p.close.minute
    if (close <= open) close += WEEK_MIN
    iv.push([open, close])
  }
  iv.sort((x, y) => x[0] - y[0])
  // Merge touching periods; 23:59 -> 00:00 counts as touching (daily "open 24 hours").
  const merged: [number, number][] = []
  for (const [o, c] of iv) {
    const last = merged[merged.length - 1]
    if (last && o - last[1] <= 1) last[1] = Math.max(last[1], c)
    else merged.push([o, c])
  }
  if (merged.length > 1) {
    const first = merged[0]
    const last = merged[merged.length - 1]
    if (first[0] + WEEK_MIN - last[1] <= 1) {
      last[1] = first[1] + WEEK_MIN
      merged.shift()
    }
  }
  if (merged.some(([o, c]) => c - o >= WEEK_MIN - 1)) return { openNow: true, open24: true }
  let nextOpen: number | null = null
  for (const [o, c] of merged) {
    for (const n of [nowMin, nowMin + WEEK_MIN]) if (n >= o && n < c) return { openNow: true, closesAt: hhmm(c) }
    const ahead = (o - nowMin + WEEK_MIN) % WEEK_MIN
    if (nextOpen === null || ahead < (nextOpen - nowMin + WEEK_MIN) % WEEK_MIN) nextOpen = o % WEEK_MIN
  }
  if (nextOpen === null) return { openNow: false }
  const day = Math.floor(nextOpen / 1440)
  return { openNow: false, opensAt: hhmm(nextOpen), opensInDays: (day - Math.floor(nowMin / 1440) + 7) % 7, opensWeekday: day }
}

/** Open state in the place's local time; openNow null when unknown. */
function computeOpenState(place: google.maps.places.Place): OpenState {
  const hours = place.currentOpeningHours ?? place.regularOpeningHours
  const periods = hours?.periods?.length ? hours.periods : place.regularOpeningHours?.periods
  const offset = place.utcOffsetMinutes
  const now = new Date()
  const local = offset == null ? now : new Date(now.getTime() + (offset + now.getTimezoneOffset()) * 60_000)
  return openStateAt(periods, local.getDay() * 1440 + local.getHours() * 60 + local.getMinutes())
}

function toHit(place: google.maps.places.Place): PlaceHit | null {
  const loc = place.location
  if (!loc) return null
  const acc = place.accessibilityOptions
  const photoUrls: string[] = []
  for (const ph of place.photos?.slice(0, 3) ?? []) {
    try {
      const u = ph.getURI({ maxHeight: 400 })
      if (u) photoUrls.push(u)
    } catch {
      /* photo without URI: skip */
    }
  }
  const photoUrl = photoUrls[0]
  const st = computeOpenState(place)
  const phone = place.nationalPhoneNumber ?? place.internationalPhoneNumber ?? undefined
  return {
    placeId: place.id,
    name: place.displayName ?? '',
    lat: loc.lat(),
    lon: loc.lng(),
    rating: place.rating ?? undefined,
    ratingCount: place.userRatingCount ?? undefined,
    category: place.primaryTypeDisplayName ?? undefined,
    address: place.formattedAddress ?? undefined,
    openNow: st.openNow,
    open24: st.open24,
    closesAt: st.closesAt,
    opensAt: st.opensAt,
    opensInDays: st.opensInDays,
    opensWeekday: st.opensWeekday,
    photoUrl,
    photoUrls: photoUrls.length ? photoUrls : undefined,
    phone: phone || undefined,
    website: place.websiteURI || undefined,
    access: {
      entrance: acc?.hasWheelchairAccessibleEntrance ?? null,
      restroom: acc?.hasWheelchairAccessibleRestroom ?? null,
      seating: acc?.hasWheelchairAccessibleSeating ?? null,
      parking: acc?.hasWheelchairAccessibleParking ?? null,
    },
  }
}

function toHits(places: google.maps.places.Place[]): PlaceHit[] {
  return places.map(toHit).filter((h): h is PlaceHit => h !== null)
}

/** Nearby search for a chip around the map centre, radius from the visible bounds. */
export async function searchCategory(map: google.maps.Map, chipId: string): Promise<PlaceHit[]> {
  const chip = NORMAL_CHIPS.find((c) => c.id === chipId)
  if (!chip) throw new Error(`Unbekannte Kategorie: ${chipId}`)
  const center = map.getCenter()
  if (!center) return []
  const { Place } = await placesLib()
  try {
    const { places } = await Place.searchNearby({
      fields: FIELDS,
      locationRestriction: { center, radius: viewRadius(map, center) },
      includedPrimaryTypes: chip.types,
      maxResultCount: MAX_RESULTS,
      language: lang(),
      region: 'de',
    })
    return toHits(places)
  } catch (err) {
    throw new PlacesUnavailable(err)
  }
}

/** Free-text search for the search bar, biased to the visible map. */
export async function searchText(map: google.maps.Map, query: string): Promise<PlaceHit[]> {
  const textQuery = query.trim()
  if (!textQuery) return []
  const { Place } = await placesLib()
  const bias = map.getBounds() ?? map.getCenter()
  try {
    const { places } = await Place.searchByText({
      textQuery,
      fields: FIELDS,
      ...(bias ? { locationBias: bias } : {}),
      maxResultCount: MAX_RESULTS,
      language: lang(),
      region: 'de',
    })
    return toHits(places)
  } catch (err) {
    throw new PlacesUnavailable(err)
  }
}
