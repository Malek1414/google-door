// Business Profile details ("Profil bearbeiten"), stored on the device per business id.
// Pure helpers plus a guarded localStorage store; nothing here touches the DOM.

export const BUSINESS_DETAILS_KEY = 'doorway.businessDetails'
export const MAX_DESCRIPTION = 750
export const MAX_PHOTOS = 12

export type Tri = 'ja' | 'nein' | 'unbekannt'

export const ACCESS_ATTRS = [
  { id: 'entrance', label: 'Rollstuhlgerechter Eingang' },
  { id: 'parking', label: 'Rollstuhlgerechter Parkplatz' },
  { id: 'toilet', label: 'Rollstuhlgerechtes WC' },
  { id: 'seating', label: 'Rollstuhlgerechte Sitzplätze' },
  { id: 'elevator', label: 'Aufzug' },
  { id: 'stepFree', label: 'Stufenloser Zugang' },
  { id: 'tactile', label: 'Blindenleitsystem' },
  { id: 'assistanceDogs', label: 'Assistenzhunde willkommen' },
  { id: 'hearingLoop', label: 'Induktionsschleife' },
  // Shown under "Mehr" in Profil bearbeiten.
  { id: 'doorWide', label: 'Türbreite mindestens 90 cm', more: true },
  { id: 'automaticDoor', label: 'Automatische Tür', more: true },
  { id: 'doorButton', label: 'Türöffner-Taster', more: true },
  { id: 'noThreshold', label: 'Keine Schwelle über 2 cm', more: true },
  { id: 'ramp', label: 'Rampe', more: true },
  { id: 'handrail', label: 'Handlauf an Stufen oder Rampe', more: true },
  { id: 'bellReach', label: 'Klingel in Greifhöhe (höchstens 85 cm)', more: true },
  { id: 'smoothFloor', label: 'Ebener Boden, kein Kopfsteinpflaster', more: true },
  { id: 'noSlope', label: 'Kein starkes Gefälle am Zugang', more: true },
  { id: 'wideCorridors', label: 'Flure mindestens 120 cm breit', more: true },
  { id: 'lowCounter', label: 'Tresen höchstens 80 cm hoch', more: true },
  { id: 'goodLight', label: 'Gute Beleuchtung ohne Blendung', more: true },
  { id: 'contrast', label: 'Kontrastmarkierungen an Stufen und Glas', more: true },
  { id: 'braille', label: 'Braille oder tastbare Beschriftung', more: true },
  { id: 'visualAlarm', label: 'Alarm mit Lichtsignal', more: true },
  { id: 'grabBars', label: 'Haltegriffe im WC', more: true },
  { id: 'quietRoom', label: 'Ruhiger Raum', more: true },
] as const

export type AccessAttrId = (typeof ACCESS_ATTRS)[number]['id']

export const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'] as const

export interface DayHours {
  open: boolean
  from: string // "HH:MM"
  to: string
}

export interface BusinessDetails {
  name: string
  category: string
  description: string
  phone: string
  website: string
  address: string
  lat: number | null
  lon: number | null
  hours: DayHours[] // 7 entries, Monday first
  photos: string[] // JPEG data URLs
  access: Record<AccessAttrId, Tri>
  updatedAt: string
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export function emptyDetails(): BusinessDetails {
  const access = {} as Record<AccessAttrId, Tri>
  for (const a of ACCESS_ATTRS) access[a.id] = 'unbekannt'
  return {
    name: '',
    category: '',
    description: '',
    phone: '',
    website: '',
    address: '',
    lat: null,
    lon: null,
    hours: DAYS.map((_, i) => ({ open: i < 5, from: '09:00', to: '18:00' })),
    photos: [],
    access,
    updatedAt: '',
  }
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Coerce unknown JSON into a valid BusinessDetails, falling back to defaults field by field. */
export function normalizeDetails(o: unknown): BusinessDetails {
  const d = emptyDetails()
  if (!o || typeof o !== 'object') return d
  const r = o as Record<string, unknown>
  d.name = str(r.name, 200)
  d.category = str(r.category, 200)
  d.description = str(r.description, MAX_DESCRIPTION)
  d.phone = str(r.phone, 50)
  d.website = str(r.website, 500)
  d.address = str(r.address, 300)
  d.lat = num(r.lat)
  d.lon = num(r.lon)
  if (Array.isArray(r.hours)) {
    d.hours = d.hours.map((def, i) => {
      const h = r.hours && (r.hours as unknown[])[i]
      if (!h || typeof h !== 'object') return def
      const x = h as Record<string, unknown>
      return {
        open: x.open === true,
        from: typeof x.from === 'string' && HHMM.test(x.from) ? x.from : def.from,
        to: typeof x.to === 'string' && HHMM.test(x.to) ? x.to : def.to,
      }
    })
  }
  if (Array.isArray(r.photos)) {
    d.photos = r.photos.filter((p): p is string => typeof p === 'string' && p.startsWith('data:image/')).slice(0, MAX_PHOTOS)
  }
  if (r.access && typeof r.access === 'object') {
    const a = r.access as Record<string, unknown>
    for (const attr of ACCESS_ATTRS) {
      const v = a[attr.id]
      if (v === 'ja' || v === 'nein' || v === 'unbekannt') d.access[attr.id] = v
    }
  }
  d.updatedAt = str(r.updatedAt, 40)
  return d
}

/** Share of filled profile fields, 0 to 100. Pure. */
export function completeness(d: BusinessDetails): number {
  const checks: boolean[] = [
    d.name.trim() !== '',
    d.category.trim() !== '',
    d.description.trim().length >= 50,
    d.phone.trim() !== '',
    d.website.trim() !== '',
    d.address.trim() !== '',
    d.lat !== null && d.lon !== null,
    d.hours.some((h) => h.open),
    d.photos.length > 0,
  ]
  for (const a of ACCESS_ATTRS) checks.push(d.access[a.id] !== 'unbekannt')
  const done = checks.filter(Boolean).length
  return Math.round((done / checks.length) * 100)
}

function readAll(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(BUSINESS_DETAILS_KEY)
    const o = raw ? JSON.parse(raw) : null
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function loadDetails(businessId: string): BusinessDetails | null {
  const all = readAll()
  return Object.prototype.hasOwnProperty.call(all, businessId) ? normalizeDetails(all[businessId]) : null
}

/** Returns false when storage is blocked or full (e.g. too many photos). */
export function saveDetails(businessId: string, d: BusinessDetails): boolean {
  try {
    const all = readAll()
    all[businessId] = { ...d, updatedAt: new Date().toISOString() }
    localStorage.setItem(BUSINESS_DETAILS_KEY, JSON.stringify(all))
    return true
  } catch {
    return false
  }
}
