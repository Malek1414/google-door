// One position source for the whole app.
//
// Inside the iOS wrapper, navigator.geolocation is already CoreLocation: the wrapper's
// GeoBridge (ios/Doorway/Sources/WebViewController.swift) replaces it at document start in
// the main frame of our own origins. So watchPosition here is the native stream there and
// the browser's everywhere else, with one code path.
//
// ?sim=1 replays the recorded track (sim/replay.ts) instead. Without ?sim=1 no sim data is
// ever used.

import { bearingDeg, haversineM, type LatLon } from './geo'
import type { TrackPoint } from '../sim/replay'

export interface Fix {
  lat: number
  lng: number
  accuracy: number
  headingDeg: number | null
  speed: number | null
  t: number
}

/** Fixes worse than this are dropped, except the very first one. */
export const MAX_ACCURACY_M = 80
/** Movement below this while standing is GPS jitter and is ignored. */
export const JITTER_M = 2
/** Above this speed (m/s) the fix's own course is trusted as heading. */
export const COURSE_MIN_MPS = 0.5
/** Two fixes at least this far apart give a bearing when there is no course. */
export const BEARING_MIN_M = 5
/** A step backwards along the walking direction shorter than this is held (m). */
export const BACKSTEP_M = 8

type Raw = { lat: number; lng: number; accuracy: number; heading: number | null; speed: number | null; t: number }

/**
 * The filter behind watchFixes, separate so it can be tested without a geolocation.
 * push() returns the fix to emit, or null to drop the raw one.
 */
export function createFixFilter() {
  let emitted: Fix | null = null
  let prevRaw: Raw | null = null
  let anchor: LatLon | null = null // last raw point a 5 m bearing was measured from
  let trackBearing: number | null = null

  return {
    push(r: Raw): Fix | null {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return null
      const acc = Number.isFinite(r.accuracy) && r.accuracy >= 0 ? r.accuracy : MAX_ACCURACY_M
      if (emitted && acc > MAX_ACCURACY_M) return null

      const here = { lat: r.lat, lon: r.lng }
      // Speed: the fix's own, else distance over time since the last raw fix.
      let speed: number | null = r.speed !== null && Number.isFinite(r.speed) && r.speed >= 0 ? r.speed : null
      if (speed === null && prevRaw && r.t > prevRaw.t) {
        speed = haversineM({ lat: prevRaw.lat, lon: prevRaw.lng }, here) / ((r.t - prevRaw.t) / 1000)
      }
      prevRaw = { ...r, accuracy: acc }

      // Bearing between the last raw fixes at least 5 m apart.
      if (!anchor) anchor = here
      else if (haversineM(anchor, here) >= BEARING_MIN_M) {
        trackBearing = bearingDeg(anchor, here)
        anchor = here
      }

      const course = r.heading !== null && Number.isFinite(r.heading) && r.heading >= 0 ? r.heading % 360 : null
      const headingDeg = speed !== null && speed > COURSE_MIN_MPS && course !== null ? course : trackBearing

      let lat = r.lat
      let lng = r.lng
      if (emitted) {
        const last = { lat: emitted.lat, lon: emitted.lng }
        const d = haversineM(last, here)
        const standing = speed === null || speed <= COURSE_MIN_MPS
        if (standing && d < JITTER_M) {
          lat = emitted.lat
          lng = emitted.lng
        } else if (headingDeg !== null && d < BACKSTEP_M) {
          // Component of the step along the walking direction; negative is backwards.
          const along = d * Math.cos(((bearingDeg(last, here) - headingDeg) * Math.PI) / 180)
          if (along < 0) {
            lat = emitted.lat
            lng = emitted.lng
          }
        }
      }
      emitted = { lat, lng, accuracy: acc, headingDeg, speed, t: r.t }
      return emitted
    },
  }
}

let simTrackOverride: TrackPoint[] | null = null

/** ?sim=1 only: replay this track instead of the one named by ?track=. null resets. */
export function setSimTrack(track: TrackPoint[] | null): void {
  simTrackOverride = track
}

function isSim(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('sim') === '1'
  } catch {
    return false
  }
}

/** Live fixes until the returned stop() is called. stop() clears every watch it started. */
export function watchFixes(onFix: (f: Fix) => void, onError?: (msg: string) => void): () => void {
  const filter = createFixFilter()
  const feed = (r: Raw) => {
    const f = filter.push(r)
    if (f) onFix(f)
  }
  return isSim() ? watchSim(feed, onError) : watchGeo(feed, onError)
}

function watchGeo(feed: (r: Raw) => void, onError?: (msg: string) => void): () => void {
  const geo = globalThis.navigator?.geolocation
  if (!geo) {
    onError?.('Standort ist auf diesem Gerät nicht verfügbar')
    return () => {}
  }
  let id: number | null = geo.watchPosition(
    (p) =>
      feed({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy: p.coords.accuracy,
        heading: p.coords.heading ?? null,
        speed: p.coords.speed ?? null,
        t: p.timestamp || Date.now(),
      }),
    (e) => onError?.(e.code === 1 ? 'Standortzugriff verweigert' : e.message || 'Standort nicht verfügbar'),
    { enableHighAccuracy: true, maximumAge: 0 },
  )
  return () => {
    if (id !== null) geo.clearWatch(id)
    id = null
  }
}

function watchSim(feed: (r: Raw) => void, onError?: (msg: string) => void): () => void {
  let stopped = false
  let stopReplay: (() => void) | null = null
  void (async () => {
    try {
      const [{ loadTrack, replaySensors }, { readParams }] = await Promise.all([import('../sim/replay'), import('../config')])
      const params = readParams()
      const track = simTrackOverride ?? (await loadTrack(params.track))
      if (stopped) return
      let heading: number | null = null
      let prev: { lat: number; lng: number; t: number } | null = null
      const sensors = replaySensors(track, { speed: params.speed, imageUrl: '', label: '' })
      stopReplay = sensors.start(
        (f) => {
          const t = Date.now()
          const speed = prev && t > prev.t ? haversineM({ lat: prev.lat, lon: prev.lng }, f) / ((t - prev.t) / 1000) : null
          prev = { lat: f.lat, lng: f.lon, t }
          feed({ lat: f.lat, lng: f.lon, accuracy: f.accuracy ?? 5, heading, speed, t })
        },
        (h) => {
          heading = h.source === 'none' ? null : h.deg
        },
      )
    } catch (e) {
      if (!stopped) onError?.(e instanceof Error ? e.message : String(e))
    }
  })()
  return () => {
    stopped = true
    stopReplay?.()
    stopReplay = null
  }
}
