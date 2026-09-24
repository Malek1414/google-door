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
  /** Up to six photos for the card's strip and Fotos tab; photoUrl is the first. */
  photoUrls?: string[]
  /** "19:00" while open, from the opening-hour periods. */
  closesAt?: string
  /** "9:00" (or "9:00 Mo." when not today) while closed. */
  opensAt?: string
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

/** Open-now verdict from opening-hour periods in the place's local time; null when unknown. */
const DAYS_DE = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.']
const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function clock(weekMin: number): string {
  const m = ((weekMin % 1440) + 1440) % 1440
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

/** When the place closes (open now) or next opens (closed now), as Maps writes it. */
function openingEdges(place: google.maps.places.Place): { closesAt?: string; opensAt?: string } {
  const hours = place.currentOpeningHours ?? place.regularOpeningHours
  if (!hours || hours.periods.length === 0) return {}
  const offset = place.utcOffsetMinutes
  const now = new Date()
  const local = offset == null ? now : new Date(now.getTime() + (offset + now.getTimezoneOffset()) * 60_000)
  const nowMin = local.getDay() * 1440 + local.getHours() * 60 + local.getMinutes()
  let nextOpen = Infinity
  for (const p of hours.periods) {
    if (!p.close) return {}
    const open = p.open.day * 1440 + p.open.hour * 60 + p.open.minute
    let close = p.close.day * 1440 + p.close.hour * 60 + p.close.minute
    if (close <= open) close += WEEK_MIN
    for (const shift of [0, WEEK_MIN]) {
      if (nowMin + shift >= open && nowMin + shift < close) return { closesAt: clock(close) }
    }
    const until = (open - nowMin + WEEK_MIN) % WEEK_MIN
    if (until < nextOpen) nextOpen = until
  }
  if (!Number.isFinite(nextOpen)) return {}
  const at = nowMin + nextOpen
  const sameDay = Math.floor(at / 1440) % 7 === local.getDay()
  const day = (lang().startsWith('de') ? DAYS_DE : DAYS_EN)[Math.floor(at / 1440) % 7]
  return { opensAt: sameDay ? clock(at) : `${clock(at)} ${day}` }
}

function computeOpenNow(place: google.maps.places.Place): boolean | null {
  const hours = place.currentOpeningHours ?? place.regularOpeningHours
  if (!hours || hours.periods.length === 0) return null
  const offset = place.utcOffsetMinutes
  const now = new Date()
  const local = offset == null ? now : new Date(now.getTime() + (offset + now.getTimezoneOffset()) * 60_000)
  const nowMin = local.getDay() * 1440 + local.getHours() * 60 + local.getMinutes()
  for (const p of hours.periods) {
    if (!p.close) return true // open 24/7
    const open = p.open.day * 1440 + p.open.hour * 60 + p.open.minute
    let close = p.close.day * 1440 + p.close.hour * 60 + p.close.minute
    if (close <= open) close += WEEK_MIN
    if ((nowMin >= open && nowMin < close) || (nowMin + WEEK_MIN >= open && nowMin + WEEK_MIN < close)) return true
  }
  return false
}

function toHit(place: google.maps.places.Place): PlaceHit | null {
  const loc = place.location
  if (!loc) return null
  const acc = place.accessibilityOptions
  const photoUrls: string[] = []
  for (const ph of (place.photos ?? []).slice(0, 6)) {
    try {
      photoUrls.push(ph.getURI({ maxHeight: 400 }))
    } catch {
      /* a photo without a URI is skipped */
    }
  }
  const photoUrl = photoUrls[0]
  return {
    placeId: place.id,
    name: place.displayName ?? '',
    lat: loc.lat(),
    lon: loc.lng(),
    rating: place.rating ?? undefined,
    ratingCount: place.userRatingCount ?? undefined,
    category: place.primaryTypeDisplayName ?? undefined,
    address: place.formattedAddress ?? undefined,
    openNow: computeOpenNow(place),
    photoUrl,
    photoUrls,
    ...openingEdges(place),
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


/** One place by id. This is what a tap on a Google POI label yields — the map click
 *  event carries only a placeId, so the details have to be fetched before the card
 *  can be shown. Same field set as search, so the card renders identically. */
export async function fetchPlaceById(placeId: string): Promise<PlaceHit | null> {
  const { Place } = (await google.maps.importLibrary('places')) as google.maps.PlacesLibrary
  // Without requestedLanguage a POI tap answers in the browser default, and German
  // users got "Art museum" on the card while search said "Kunstmuseum".
  const place = new Place({ id: placeId, requestedLanguage: lang(), requestedRegion: 'de' })
  await place.fetchFields({
    fields: [
      'id', 'displayName', 'location', 'rating', 'userRatingCount',
      'primaryTypeDisplayName', 'formattedAddress', 'regularOpeningHours',
      'photos', 'accessibilityOptions', 'currentOpeningHours', 'utcOffsetMinutes',
    ],
  })
  return toHit(place)
}
