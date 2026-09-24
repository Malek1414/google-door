// Says out loud when the server is degraded. The "roughly this way" bug was a server
// with no keys answering 200 everywhere while nothing on screen said why. This polls
// /api/health on start and every 60 s and shows a thin snackbar at the top when routes,
// image description or the server itself are unavailable. Screens call health() or
// degradedReason() to explain WHY a feature is not doing its job.

import { apiBase } from '../config'
import { onApiResult } from '../data'
import { lang } from '../strings'
import { h } from './dom'
import './health-banner.css'

export interface DepStatus {
  key: boolean
  keyName?: string
  ok: boolean
  lastError?: string | null
  lastErrorAgeS?: number | null
  lastSuccessAgeS?: number | null
}

export interface Health {
  /** false when /api/health did not answer, or answered with an error. */
  reachable: boolean
  /** Walking directions work (Routes call healthy and the Maps key present). */
  maps: boolean
  /** Gemini works: image description, door check, spoken replies. */
  gemini: boolean
  deps: Record<string, DepStatus>
  checkedAt: number
}

export type Feature = 'route' | 'look'
type Lang = 'de' | 'en'

const TEXT = {
  de: {
    offline: 'Keine Verbindung zum Server',
    route: 'Routen gerade nicht verfügbar',
    look: 'Bildbeschreibung gerade nicht verfügbar',
    both: 'Routen und Bildbeschreibung gerade nicht verfügbar',
    dismiss: 'Ausblenden',
  },
  en: {
    offline: 'No connection to the server',
    route: 'Directions are unavailable right now',
    look: 'Image description is unavailable right now',
    both: 'Directions and image description are unavailable right now',
    dismiss: 'Dismiss',
  },
} as const

export const HEALTH_INTERVAL_MS = 60_000
const TIMEOUT_MS = 5_000

let last: Health | null = null
const listeners = new Set<(h: Health) => void>()

/** The last known server health, or null before the first check has finished. */
export function health(): Health | null {
  return last
}

/** Subscribe to every health result. Returns the unsubscribe function. */
export function onHealth(fn: (h: Health) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const bool = (v: unknown) => v === true

/** Turn a /api/health body into Health. Anything malformed counts as degraded, never as fine. */
export function parseHealth(body: unknown, now = Date.now()): Health {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const deps = (b.deps && typeof b.deps === 'object' ? b.deps : {}) as Record<string, DepStatus>
  return { reachable: bool(b.ok), maps: bool(b.maps), gemini: bool(b.gemini), deps, checkedAt: now }
}

export function unreachable(now = Date.now()): Health {
  return { reachable: false, maps: false, gemini: false, deps: {}, checkedAt: now }
}

/** The snackbar line for a health result, or null when everything works. */
export function bannerText(hl: Health, l: Lang = lang): string | null {
  const s = TEXT[l]
  if (!hl.reachable) return s.offline
  if (!hl.maps && !hl.gemini) return s.both
  if (!hl.maps) return s.route
  if (!hl.gemini) return s.look
  return null
}

/**
 * Why a feature is degraded, for a screen to show next to its fallback, or null when
 * it should work (or health is not known yet). Never names a key value, only its role.
 */
export function degradedReason(feature: Feature, hl: Health | null = last, l: Lang = lang): string | null {
  if (!hl) return null
  const s = TEXT[l]
  if (!hl.reachable) return s.offline
  if (feature === 'route' && !hl.maps) return s.route
  if (feature === 'look' && !hl.gemini) return s.look
  return null
}

/** One /api/health round trip. Never throws: a failure is an unreachable result. */
export async function checkHealth(fetchFn: typeof fetch = fetch, base = apiBase()): Promise<Health> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  let result: Health
  try {
    const r = await fetchFn(`${base}/api/health`, { signal: ctl.signal, cache: 'no-store' })
    result = r.ok ? parseHealth(await r.json()) : unreachable()
  } catch {
    result = unreachable()
  } finally {
    clearTimeout(timer)
  }
  last = result
  for (const fn of listeners) {
    try {
      fn(result)
    } catch {
      /* a listener must not stop the others */
    }
  }
  return result
}

// ---- the snackbar ----

let bar: HTMLElement | null = null
let dismissedText: string | null = null

function render(hl: Health): void {
  const text = bannerText(hl)
  if (text === null) dismissedText = null
  if (text === null || text === dismissedText) {
    bar?.remove()
    bar = null
    return
  }
  if (bar?.dataset.text === text) return
  bar?.remove()
  bar = h(
    'div',
    { class: 'health-banner', role: 'status', 'aria-live': 'polite', 'data-text': text },
    h('span', { class: 'health-banner-text' }, text),
    h(
      'button',
      {
        type: 'button',
        class: 'health-banner-close',
        onclick: () => {
          dismissedText = text
          bar?.remove()
          bar = null
        },
      },
      TEXT[lang].dismiss,
    ),
  )
  document.body.append(bar)
}

/** Fastest re-check after an /api answer contradicts the last health result. */
export const RECHECK_MIN_MS = 4_000

/**
 * Should an /api answer trigger a health check now? Only when it contradicts what the
 * banner shows: a failure while all looked fine, or a success while the server looked
 * unreachable. Everything else is already on screen.
 */
export function contradicts(ok: boolean, hl: Health | null): boolean {
  if (!hl) return !ok
  return ok ? !hl.reachable : hl.reachable
}

/** Check now, then every 60 s, whenever the page comes back, and as soon as an /api call
 *  says the last result is out of date. Returns a stop function. */
export function startHealthBanner(intervalMs = HEALTH_INTERVAL_MS): () => void {
  let inFlight = false
  let lastRun = 0
  let pending: ReturnType<typeof setTimeout> | null = null
  const run = () => {
    if (inFlight) return
    inFlight = true
    lastRun = Date.now()
    void checkHealth()
      .then(render)
      .finally(() => (inFlight = false))
  }
  run()
  const id = setInterval(run, intervalMs)
  const stopWatch = onApiResult((ok) => {
    if (pending || !contradicts(ok, last)) return
    pending = setTimeout(() => {
      pending = null
      run()
    }, Math.max(0, lastRun + RECHECK_MIN_MS - Date.now()))
  })
  const onVisible = () => {
    if (document.visibilityState === 'visible') run()
  }
  window.addEventListener('online', run)
  window.addEventListener('offline', run)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    clearInterval(id)
    stopWatch()
    if (pending) clearTimeout(pending)
    window.removeEventListener('online', run)
    window.removeEventListener('offline', run)
    document.removeEventListener('visibilitychange', onVisible)
    bar?.remove()
    bar = null
  }
}
