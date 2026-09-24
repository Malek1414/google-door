// Bridge to the native ARCore Live View of the iOS app (ios/Doorway/Sources/ArLiveView*.swift).
//
// Inside the Doorway iOS app the wrapper injects window.doorwayNative = { arLiveView: true }
// on devices that can run ARKit. Live View then opens a native camera screen with Google's
// Geospatial API: arrows anchored on the real street, a maneuver banner, and at the door
// the web app takes over again with its arrival sheet and the last-10-metres engine.
//
// Everywhere else (a browser, the simulator, a phone without ARKit) nativeArAvailable() is
// false and nothing here runs: Live View stays the web one. When the native screen cannot
// start after all (no ARCore credentials, no VPS coverage, location denied), it answers
// with an `error` event and the caller opens the web Live View instead.
//
// Pure apart from the window it is handed, so the fallback logic is unit-tested.

import type { Route } from '../core/route'
import { instructionLine } from '../core/route'
import type { ArrowTarget } from '../core/target'

export const HANDLER = 'doorwayAr'
/** The global the native side calls with each event. */
export const EVENT_HOOK = '__doorwayArEvent'
/** No first event from native within this long: treat the native screen as failed. */
export const OPEN_TIMEOUT_MS = 5000

export interface NativeArStep {
  /** The instruction as shown in the list, first line only. */
  text: string
  /** Where the instruction applies: the start of the step. */
  lat: number
  lng: number
  maneuver: string | null
}

export interface NativeArPayload {
  route: [number, number][]
  door: { lat: number; lng: number; name: string; approachBearing: number | null }
  steps: NativeArStep[]
}

export type NativeArEvent =
  | { type: 'localizing' }
  | { type: 'tracking' }
  | { type: 'arrived'; via?: 'distance' | 'button' }
  | { type: 'closed' }
  | { type: 'error'; reason: string }

interface MessageHandler {
  postMessage(body: unknown): void
}

export interface NativeWindow {
  doorwayNative?: { arLiveView?: unknown }
  webkit?: { messageHandlers?: Record<string, MessageHandler | undefined> }
  [EVENT_HOOK]?: (ev: unknown) => void
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
}

const win = (): NativeWindow => window as unknown as NativeWindow

/** True only inside the iOS app on a device that can run the native AR screen. */
export function nativeArAvailable(w: NativeWindow = win()): boolean {
  return w.doorwayNative?.arLiveView === true && typeof w.webkit?.messageHandlers?.[HANDLER]?.postMessage === 'function'
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * What the native screen needs: the path, the door, and each instruction pinned to the
 * point where it applies (a step's instruction is said at its start, which is where the
 * previous step ended). Null when the route cannot carry arrows.
 */
export function buildPayload(route: Route, target: ArrowTarget, name: string): NativeArPayload | null {
  const path = route.path.filter((p) => finite(p[0]) && finite(p[1]))
  if (!route.found || path.length < 2 || !finite(target.lat) || !finite(target.lon)) return null
  const steps: NativeArStep[] = []
  let at: [number, number] = path[0]
  for (const st of route.steps) {
    const text = instructionLine(st)
    if (text) steps.push({ text, lat: at[0], lng: at[1], maneuver: st.maneuver ?? null })
    if (finite(st.endLat) && finite(st.endLon)) at = [st.endLat, st.endLon]
  }
  const bearing = target.entrance.approachBearing
  return {
    route: path.map((p): [number, number] => [p[0], p[1]]),
    door: { lat: target.lat, lng: target.lon, name, approachBearing: finite(bearing) ? bearing : null },
    steps,
  }
}

function parseEvent(raw: unknown): NativeArEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const ev = raw as { type?: unknown; reason?: unknown; via?: unknown }
  switch (ev.type) {
    case 'localizing':
    case 'tracking':
    case 'closed':
      return { type: ev.type }
    case 'arrived':
      return ev.via === 'distance' || ev.via === 'button' ? { type: 'arrived', via: ev.via } : { type: 'arrived' }
    case 'error':
      return { type: 'error', reason: typeof ev.reason === 'string' ? ev.reason : 'unknown' }
    default:
      return null
  }
}

export interface NativeArSession {
  /** Stop listening (does not close the native screen). */
  dispose(): void
}

/**
 * Open the native AR screen. Returns null when it is not available here, so the caller
 * shows the web Live View. Every event goes to `onEvent`; after the last one (arrived,
 * closed, error) the hook is removed. A native side that never answers counts as
 * error('no-response').
 */
export function openNativeAr(payload: NativeArPayload, onEvent: (ev: NativeArEvent) => void, w: NativeWindow = win()): NativeArSession | null {
  if (!nativeArAvailable(w)) return null
  let done = false
  let timer: number | null = null
  const finish = () => {
    done = true
    if (timer !== null) w.clearTimeout(timer)
    timer = null
    if (w[EVENT_HOOK] === hook) delete w[EVENT_HOOK]
  }
  const hook = (raw: unknown) => {
    if (done) return
    const ev = parseEvent(raw)
    if (!ev) return
    if (timer !== null) {
      w.clearTimeout(timer)
      timer = null
    }
    if (ev.type === 'arrived' || ev.type === 'closed' || ev.type === 'error') finish()
    onEvent(ev)
  }
  w[EVENT_HOOK] = hook
  timer = w.setTimeout(() => hook({ type: 'error', reason: 'no-response' }), OPEN_TIMEOUT_MS)
  try {
    w.webkit!.messageHandlers![HANDLER]!.postMessage({ op: 'open', ...payload })
  } catch {
    finish()
    return null
  }
  return { dispose: finish }
}
