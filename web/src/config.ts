// Runtime configuration. Nothing secret is compiled into the bundle.
//
// window.DOORWAY_CONFIG comes from /config.js, a file that is NOT part of the build
// (gitignored, copied next to index.html on deploy). See web/config.example.js.
// The Google Maps JS key is a browser key by design of the Maps JS API: restrict it
// by HTTP referrer in Google Cloud. Gemini and Places keys never reach the client.

export interface RuntimeConfig {
  apiBase?: string
  mapsKey?: string
}

declare global {
  interface Window {
    DOORWAY_CONFIG?: RuntimeConfig
  }
}

export function apiBase(): string {
  const v = window.DOORWAY_CONFIG?.apiBase ?? import.meta.env.VITE_API_BASE ?? ''
  return String(v).replace(/\/+$/, '')
}

export function mapsKey(): string | null {
  const k = window.DOORWAY_CONFIG?.mapsKey
  return typeof k === 'string' && k.trim() ? k.trim() : null
}

export interface Params {
  sim: boolean
  record: boolean
  door: string
  track: string
  speed: number
}

export const DEFAULT_SIM_DOOR = 'node/10795939972' // Hauptbahnhof step-free door, see CONTRACT fixture
export const DEFAULT_TRACK = 'tracks/hbf-approach-synthetic.json'

export function readParams(search = location.search): Params {
  const q = new URLSearchParams(search)
  const speed = Number(q.get('speed'))
  const track = q.get('track') ?? DEFAULT_TRACK
  return {
    sim: q.get('sim') === '1',
    record: q.get('record') === '1',
    door: q.get('door') ?? DEFAULT_SIM_DOOR,
    // Only same-origin relative track paths: never load an arbitrary URL from the query string.
    track: /^[\w./-]+\.json$/.test(track) && !track.includes('..') ? track : DEFAULT_TRACK,
    speed: Number.isFinite(speed) && speed > 0 && speed <= 20 ? speed : 1,
  }
}
