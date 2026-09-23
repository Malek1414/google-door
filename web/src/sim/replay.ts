// ?sim=1: replay a recorded {t, lat, lon, heading}[] track against a still photo.
// ?record=1: record a real walk on the phone and hand back the JSON.
//
// t is seconds from the start of the walk. Optional extra fields per point:
// accuracy (metres), headingSource (core/heading HeadingSource). heading may be null
// when no compass was available while recording.

import { normalize360, relativeBearing } from '../core/geo'
import { startHeading, type Heading, type HeadingSource } from '../core/heading'
import { announce } from '../session'
import { t as str } from '../strings'
import { h, mount } from '../ui/dom'
import type { Fix, Sensors } from '../ui/LiveView'

export interface TrackPoint {
  t: number
  lat: number
  lon: number
  heading: number | null
  accuracy?: number
  headingSource?: HeadingSource
}

const SOURCES: HeadingSource[] = ['ios-webkit', 'android-absolute', 'gps-course', 'none']
const TICK_MS = 100

export function parseTrack(raw: unknown): TrackPoint[] {
  const arr = Array.isArray(raw) ? raw : (raw as { points?: unknown })?.points
  if (!Array.isArray(arr)) throw new Error('track is not an array')
  const pts = arr
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => ({
      t: Number(p.t),
      lat: Number(p.lat),
      lon: Number(p.lon),
      heading: Number.isFinite(p.heading) ? Number(p.heading) : null,
      accuracy: Number.isFinite(p.accuracy) ? Number(p.accuracy) : undefined,
      headingSource: SOURCES.includes(p.headingSource) ? p.headingSource : undefined,
    }))
    .sort((a, b) => a.t - b.t)
  if (pts.length < 2) throw new Error('track needs at least two points')
  return pts
}

/** Linear interpolation at time `at` (seconds); heading takes the short way round. */
export function sampleTrack(track: TrackPoint[], at: number): TrackPoint {
  if (at <= track[0].t) return track[0]
  const last = track[track.length - 1]
  if (at >= last.t) return last
  let i = 1
  while (track[i].t < at) i++
  const a = track[i - 1]
  const b = track[i]
  const f = (at - a.t) / (b.t - a.t || 1)
  let heading: number | null = null
  if (a.heading !== null && b.heading !== null) heading = normalize360(a.heading + relativeBearing(b.heading, a.heading) * f)
  else heading = a.heading ?? b.heading
  return {
    t: at,
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    heading,
    accuracy: a.accuracy !== undefined && b.accuracy !== undefined ? a.accuracy + (b.accuracy - a.accuracy) * f : (a.accuracy ?? b.accuracy),
    headingSource: f < 0.5 ? a.headingSource : b.headingSource,
  }
}

export async function loadTrack(path: string): Promise<TrackPoint[]> {
  const r = await fetch(`${import.meta.env.BASE_URL}${path}`)
  if (!r.ok) throw new Error(`track ${path}: HTTP ${r.status}`)
  return parseTrack(await r.json())
}

export function replaySensors(track: TrackPoint[], opts: { speed: number; imageUrl: string; label: string }): Sensors {
  return {
    media: { kind: 'image', url: opts.imageUrl },
    banner: opts.label,
    start(onFix: (f: Fix) => void, onHeading: (h: Heading) => void, onEnd?: () => void) {
      const t0 = performance.now()
      const end = track[track.length - 1].t
      const timer = window.setInterval(() => {
        const at = ((performance.now() - t0) / 1000) * opts.speed + track[0].t
        const p = sampleTrack(track, at)
        onHeading(p.heading === null ? { deg: 0, accuracy: null, source: 'none' } : { deg: p.heading, accuracy: null, source: p.headingSource ?? 'ios-webkit' })
        onFix({ lat: p.lat, lon: p.lon, accuracy: p.accuracy ?? 5 })
        if (at >= end) {
          window.clearInterval(timer)
          onEnd?.()
        }
      }, TICK_MS)
      return () => window.clearInterval(timer)
    },
  }
}

/** ?record=1 screen. Samples the latest fix and heading once per second. */
export function Recorder(): void {
  const points: TrackPoint[] = []
  let heading: Heading | null = null
  let fix: GeolocationPosition | null = null
  let stopHeading: (() => void) | null = null
  let watch: number | null = null
  let timer: number | null = null
  let t0 = 0

  const count = h('p', { class: 'distance', 'aria-live': 'polite' }, str.recordPoints(0))
  const out = h('div', { class: 'row' })
  const startBtn = h('button', { class: 'btn', type: 'button' }, str.recordStart)
  const stopBtn = h('button', { class: 'btn btn-secondary', type: 'button', disabled: true }, str.recordStop)

  startBtn.addEventListener('click', () => {
    points.length = 0
    out.replaceChildren()
    t0 = performance.now()
    stopHeading = startHeading((hd) => (heading = hd))
    watch = navigator.geolocation.watchPosition((p) => (fix = p), () => {}, { enableHighAccuracy: true, maximumAge: 0 })
    timer = window.setInterval(() => {
      if (!fix) return
      points.push({
        t: Math.round((performance.now() - t0) / 100) / 10,
        lat: fix.coords.latitude,
        lon: fix.coords.longitude,
        heading: heading && heading.source !== 'none' ? Math.round(heading.deg * 10) / 10 : null,
        accuracy: Math.round(fix.coords.accuracy * 10) / 10,
        headingSource: heading?.source ?? 'none',
      })
      count.textContent = str.recordPoints(points.length)
    }, 1000)
    startBtn.disabled = true
    stopBtn.disabled = false
  })

  stopBtn.addEventListener('click', () => {
    if (timer !== null) window.clearInterval(timer)
    if (watch !== null) navigator.geolocation.clearWatch(watch)
    stopHeading?.()
    startBtn.disabled = false
    stopBtn.disabled = true
    const json = JSON.stringify(points, null, 1)
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const copy = h('button', { class: 'btn btn-secondary', type: 'button' }, str.recordCopy)
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(json)
        announce(str.copied)
      } catch {
        /* clipboard blocked */
      }
    })
    out.replaceChildren(h('a', { class: 'btn', href: url, download: `track-recorded-${stamp}.json` }, str.recordDownload), copy)
    announce(str.recordPoints(points.length))
  })

  mount(
    h(
      'section',
      { class: 'screen screen-record', 'aria-labelledby': 'rec-title' },
      h('h1', { id: 'rec-title' }, str.recordTitle),
      h('p', { class: 'hint' }, str.recordHint),
      count,
      h('div', { class: 'row' }, startBtn, stopBtn),
      out,
    ),
  )
}
