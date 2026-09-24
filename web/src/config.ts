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
  /** ?demo=1: View on the map plays a short simulated walk, the arrival sheet, then the
   *  scripted approach (ui/approachDemo.ts), and returns to the map. Also with ?sim=1. */
  demo: boolean
  record: boolean
  door: string
  track: string
  speed: number
  /** ?door=node/123 without sim: open that door's card on the map. */
  openDoor: string | null
}

export const DEFAULT_SIM_DOOR = 'node/10795939972' // Hauptbahnhof step-free door, see CONTRACT fixture
export const DEFAULT_TRACK = 'tracks/hbf-approach-synthetic.json'

export function readParams(search = location.search): Params {
  const q = new URLSearchParams(search)
  const speed = Number(q.get('speed'))
  const track = q.get('track') ?? DEFAULT_TRACK
  return {
    sim: q.get('sim') === '1',
    demo: q.get('demo') === '1',
    record: q.get('record') === '1',
    door: q.get('door') ?? DEFAULT_SIM_DOOR,
    // Only same-origin relative track paths: never load an arbitrary URL from the query string.
    track: /^[\w./-]+\.json$/.test(track) && !track.includes('..') ? track : DEFAULT_TRACK,
    speed: Number.isFinite(speed) && speed > 0 && speed <= 20 ? speed : 1,
    // ?demo=1 alone opens the demo door, so the stage URL cannot be typed wrong.
    openDoor: /^(node|way)\/\d+$/.test(q.get('door') ?? '') ? q.get('door') : q.get('demo') === '1' ? DEFAULT_SIM_DOOR : null,
  }
}
