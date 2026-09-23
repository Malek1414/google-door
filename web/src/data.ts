// Talks to the two backend endpoints, with a static fallback for entrance data.

import { apiBase } from './config'
import type { Building, Dataset, Entrance, LivedClaim, Meta } from './core/types'

export interface BBox {
  south: number
  west: number
  north: number
  east: number
}

export interface EntranceResult {
  entrances: Entrance[]
  buildings: Building[]
  meta: Meta | null
  source: 'api' | 'static'
}

const API_TIMEOUT_MS = 4000
let staticData: Promise<Dataset> | null = null

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal })
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status })
    return (await r.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** The dataset copied into the build (data/berlin-mitte.json). */
export function loadStatic(): Promise<Dataset> {
  staticData ??= fetchJson<Dataset>(`${import.meta.env.BASE_URL}data/berlin-mitte.json`, undefined, 20000).catch((e) => {
    staticData = null
    throw e
  })
  return staticData
}

const inBox = (b: BBox) => (e: { lat: number; lon: number }) =>
  e.lat >= b.south && e.lat <= b.north && e.lon >= b.west && e.lon <= b.east

export async function fetchEntrances(b: BBox): Promise<EntranceResult> {
  const q = new URLSearchParams({
    south: b.south.toFixed(6),
    west: b.west.toFixed(6),
    north: b.north.toFixed(6),
    east: b.east.toFixed(6),
  })
  try {
    const r = await fetchJson<{ meta: Meta; entrances: Entrance[]; buildings: Building[] }>(`${apiBase()}/api/entrances?${q}`)
    return { entrances: r.entrances, buildings: r.buildings ?? [], meta: r.meta ?? null, source: 'api' }
  } catch {
    const d = await loadStatic()
    const entrances = d.entrances.filter(inBox(b))
    const ids = new Set(entrances.map((e) => e.buildingId).filter(Boolean))
    return { entrances, buildings: d.buildings.filter((x) => ids.has(x.id)), meta: d.meta, source: 'static' }
  }
}

/** The API has no by-id lookup; the static file is the source for a single door. */
export async function findEntrance(id: string): Promise<Entrance | null> {
  const d = await loadStatic()
  return d.entrances.find((e) => e.id === id) ?? null
}

export async function fetchLived(placeId: string): Promise<LivedClaim[]> {
  const r = await fetchJson<{ claims: LivedClaim[] }>(`${apiBase()}/api/lived/${encodeURIComponent(placeId)}`, undefined, 30000)
  // Contract: every claim has a verbatim quote and null coords. Re-check client side.
  return (r.claims ?? []).filter((c) => typeof c.quote === 'string' && c.quote.length > 0).map((c) => ({ ...c, coords: null }))
}

export async function postLook(body: { frame: string; heading: number; distanceM: number; target: string }): Promise<string> {
  const r = await fetchJson<{ say: string }>(
    `${apiBase()}/api/look`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    25000,
  )
  return r.say
}

export function bboxAround(lat: number, lon: number, radiusM: number): BBox {
  const dLat = radiusM / 111320
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180))
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon }
}
