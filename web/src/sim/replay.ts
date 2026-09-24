// ?sim=1: replay a recorded {t, lat, lon, heading}[] track against a still photo.
// ?record=1: record a real walk on the phone and hand back the JSON.
//
// t is seconds from the start of the walk. Optional extra fields per point:
// accuracy (metres), headingSource (core/heading HeadingSource). heading may be null
// when no compass was available while recording.

import { normalize360, relativeBearing } from '../core/geo'
import { requestHeadingPermission, startHeading, type Heading, type HeadingSource } from '../core/heading'
import { announce } from '../session'
import { lang, t as str } from '../strings'
import { h, mount } from '../ui/dom'
import type { Fix, Sensors } from '../ui/LiveView'
import './recorder.css'

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

/** How far out the ?demo=1 walk starts, and how fast it walks (m/s). */
export const DEMO_WALK_M = 9
export const DEMO_WALK_MPS = 1.5

/**
 * The ?demo=1 walk: a straight line to the door along its approach bearing, DEMO_WALK_M
 * long, then a minute standing at the door (so "Wiedergabe beendet" does not talk over the
 * arrival sheet). Arrives (core/beacon ARRIVE_M) after about 4 s; the sheet follows 1.5 s later.
 */
export function demoWalkTrack(door: { lat: number; lon: number; approachBearing: number | null }): TrackPoint[] {
  const heading = door.approachBearing ?? 0
  const back = ((heading + 180) * Math.PI) / 180
  const mLat = 111_195
  const mLon = mLat * Math.cos((door.lat * Math.PI) / 180)
  const at = (m: number) => ({ lat: door.lat + (Math.cos(back) * m) / mLat, lon: door.lon + (Math.sin(back) * m) / mLon })
  const walkS = DEMO_WALK_M / DEMO_WALK_MPS
  const pt = (t: number, m: number): TrackPoint => ({ t, ...at(m), heading, accuracy: 5, headingSource: 'ios-webkit' })
  return [pt(0, DEMO_WALK_M), pt(walkS / 2, DEMO_WALK_M / 2), pt(walkS, 0), pt(walkS + 60, 0)]
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
    replay: true,
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

// Labels only this screen needs. Everything else comes from strings.ts.
const REC = lang === 'de'
  ? { gps: 'GPS-Genauigkeit', gpsWait: 'Wartet auf GPS', compassOff: 'Kein Kompass', compassOn: 'Kompass aktiv', compassGps: 'Richtung aus GPS-Kurs', compassIdle: 'Aus', duration: 'Dauer', done: 'Weg gespeichert', ready: 'Bereit' }
  : { gps: 'GPS accuracy', gpsWait: 'Waiting for GPS', compassOff: 'No compass', compassOn: 'Compass on', compassGps: 'Heading from GPS course', compassIdle: 'Off', duration: 'Duration', done: 'Walk saved', ready: 'Ready' }

const icon = (name: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, name)
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** ?record=1 screen. Samples the latest fix and heading once per second. */
export function Recorder(opts: { onBack?: () => void } = {}): void {
  const points: TrackPoint[] = []
  let heading: Heading | null = null
  let fix: GeolocationPosition | null = null
  let stopHeading: (() => void) | null = null
  let watch: number | null = null
  let timer: number | null = null
  let uiTimer: number | null = null
  let t0 = 0
  let recording = false

  const time = h('div', { class: 'rec-time', role: 'timer', 'aria-label': REC.duration }, '00:00')
  const count = h('p', { class: 'rec-points', 'aria-live': 'polite' }, str.recordPoints(0))
  const gpsVal = h('span', { class: 'rec-row-v' }, REC.compassIdle)
  const gpsRow = h('li', { class: 'rec-row' }, icon('my_location'), h('span', { class: 'rec-row-text' }, h('span', { class: 'rec-row-k' }, REC.gps), gpsVal))
  const compassVal = h('span', { class: 'rec-row-v' }, REC.compassIdle)
  const compassRow = h('li', { class: 'rec-row' }, icon('explore'), h('span', { class: 'rec-row-text' }, h('span', { class: 'rec-row-k' }, str.sensorCompass), compassVal))
  const out = h('div', { class: 'rec-out' })
  const recLabel = h('p', { class: 'rec-btn-label', id: 'rec-btn-label' }, str.recordStart)
  const recBtn = h('button', { class: 'rec-btn', type: 'button', 'aria-pressed': 'false', 'aria-label': str.recordStart }, h('span', { class: 'rec-btn-inner', 'aria-hidden': 'true' }))

  const paint = () => {
    time.textContent = mmss(recording ? performance.now() - t0 : 0)
    time.dataset.live = String(recording)
    if (!recording) {
      gpsVal.textContent = REC.compassIdle
      compassVal.textContent = REC.compassIdle
      gpsRow.dataset.state = compassRow.dataset.state = ''
      return
    }
    if (fix) {
      const acc = Math.round(fix.coords.accuracy)
      gpsVal.textContent = `± ${acc} m`
      gpsRow.dataset.state = acc <= 10 ? 'ok' : 'warn'
    } else {
      gpsVal.textContent = REC.gpsWait
      gpsRow.dataset.state = 'warn'
    }
    const src = heading?.source ?? 'none'
    if (src === 'none') { compassVal.textContent = REC.compassOff; compassRow.dataset.state = 'warn' }
    else if (src === 'gps-course') { compassVal.textContent = REC.compassGps; compassRow.dataset.state = 'warn' }
    else { compassVal.textContent = `${REC.compassOn}, ${Math.round(heading!.deg)}°`; compassRow.dataset.state = 'ok' }
  }

  const setRecording = (on: boolean) => {
    recording = on
    recBtn.setAttribute('aria-pressed', String(on))
    recBtn.setAttribute('aria-label', on ? str.recordStop : str.recordStart)
    recLabel.textContent = on ? str.recordStop : str.recordStart
    paint()
  }

  const stopSensors = () => {
    if (timer !== null) window.clearInterval(timer)
    if (uiTimer !== null) window.clearInterval(uiTimer)
    if (watch !== null) navigator.geolocation.clearWatch(watch)
    stopHeading?.()
    timer = uiTimer = watch = null
  }

  const start = async () => {
    // Opened from the Contribute tab there was no Start screen: ask for the compass inside this tap.
    await requestHeadingPermission()
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
    uiTimer = window.setInterval(paint, 250)
    setRecording(true)
  }

  const stop = () => {
    const elapsed = mmss(performance.now() - t0)
    stopSensors()
    setRecording(false)
    time.textContent = elapsed
    const json = JSON.stringify(points, null, 1)
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const copy = h('button', { class: 'rec-pill', type: 'button' }, icon('content_copy'), str.recordCopy)
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(json)
        announce(str.copied)
      } catch {
        /* clipboard blocked */
      }
    })
    out.replaceChildren(
      h(
        'section',
        { class: 'rec-result', 'aria-labelledby': 'rec-result-title' },
        h('h2', { class: 'rec-result-title', id: 'rec-result-title' }, REC.done),
        h('p', { class: 'rec-result-meta' }, `${str.recordPoints(points.length)}, ${REC.duration} ${elapsed}`),
        h('div', { class: 'rec-actions' }, h('a', { class: 'rec-pill rec-pill-primary', href: url, download: `track-recorded-${stamp}.json` }, icon('download'), str.recordDownload), copy),
      ),
    )
    announce(str.recordPoints(points.length))
  }

  recBtn.addEventListener('click', () => (recording ? stop() : void start()))

  mount(
    h(
      'section',
      { class: 'rec', 'aria-labelledby': 'rec-title' },
      h(
        'header',
        { class: 'rec-top' },
        opts.onBack ? h('button', { class: 'rec-back', type: 'button', 'aria-label': str.back, onclick: () => { stopSensors(); opts.onBack!() } }, icon('arrow_back')) : null,
        h('h1', { class: 'rec-title', id: 'rec-title' }, str.recordTitle),
      ),
      h('p', { class: 'rec-hint' }, str.recordHint),
      h('div', { class: 'rec-counter' }, time, count),
      h('ul', { class: 'rec-card' }, gpsRow, compassRow),
      out,
      h('div', { class: 'rec-control' }, recBtn, recLabel),
    ),
  )
}
