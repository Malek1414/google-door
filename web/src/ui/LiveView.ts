// Screen 4: camera full-bleed, SVG overlay above it.
//
// Accepts only an ArrowTarget (core/target.ts), which can only be minted for tier 1.
// Everything in the hot path is arithmetic. /api/look is called ONLY from the button.

import { arrowPulseHz, ARRIVE_M, beaconFor, cuePan, hapticFor, HAPTIC_ARRIVED, ON_BEARING_DEG, shouldAnnounceApproach, shouldSpeakArrival } from '../core/beacon'
import { bearingDeg, haversineM, relativeBearing } from '../core/geo'
import { startHeading, type Heading } from '../core/heading'
import { snapToGraph } from '../core/match'
import type { OutputConfig } from '../core/profile'
import type { ArrowTarget } from '../core/target'
import { BeaconAudio, playApproachChime } from '../audio'
import { postLook } from '../data'
import { announce, session, speak, vibrate } from '../session'
import { lang, t } from '../strings'
import { glyphPaths, h, mount, s } from './dom'
import './arrival.css'

export interface Fix {
  lat: number
  lon: number
  accuracy: number | null
}

export type Media = { kind: 'stream'; stream: MediaStream } | { kind: 'image'; url: string } | { kind: 'none' }

export interface Sensors {
  media: Media
  banner?: string
  /** Start feeding fixes and headings; onEnd fires when a replay runs out. Returns stop(). */
  start(onFix: (f: Fix) => void, onHeading: (h: Heading) => void, onEnd?: () => void): () => void
}

/** Cone instead of line when GPS is worse than this (metres). */
export const CONE_ACCURACY_M = 25
const HAPTIC_EVERY_MS = 3000
const SPEAK_EVERY_MS = 4000
// 10 m is covered by the one-off approach line (core/beacon.ts APPROACH_M).
const DISTANCE_CALLOUTS = [50, 30, 20]

/** Jitter-tolerant arrival: two still fixes within this radius count as arrived. */
export const ARRIVE_JITTER_M = 4
/** Below this speed (m/s) between the last two fixes the user counts as standing. */
export const STILL_MPS = 0.5
/** Walking this far away again while the arrival card shows resumes guidance. */
export const LEAVE_M = 8
export const ARRIVAL_CARD_DELAY_MS = 1500
export const ARRIVAL_EXIT_S = 20

export interface TimedFix {
  lat: number
  lon: number
  /** Milliseconds, any monotonic clock. */
  t: number
}

/**
 * Pure. Arrived when the newest fix is inside ARRIVE_M, or when the last two fixes are both
 * within ARRIVE_JITTER_M and the user is standing still between them (GPS jitter at the door).
 */
export function isArrived(history: readonly TimedFix[], target: { lat: number; lon: number }): boolean {
  const n = history.length
  if (n === 0) return false
  const b = history[n - 1]
  const db = haversineM(b, target)
  if (!Number.isFinite(db)) return false
  if (db <= ARRIVE_M) return true
  if (n < 2) return false
  const a = history[n - 2]
  if (haversineM(a, target) > ARRIVE_JITTER_M || db > ARRIVE_JITTER_M) return false
  const moved = haversineM(a, b)
  const dt = (b.t - a.t) / 1000
  if (!(dt > 0)) return moved === 0
  return moved / dt <= STILL_MPS
}

/** Arrival card strings; kept local so strings.ts stays untouched. */
const ARR = {
  de: {
    title: 'Angekommen',
    stay: 'Hier bleiben',
    toMap: 'Zur Karte',
    backIn: (s: number) => `Zurück zur Karte in ${s} Sekunden.`,
    staying: 'Du bleibst hier. Zur Karte kommst du mit dem Knopf unten.',
    resumed: 'Du entfernst dich vom Eingang. Die Führung läuft weiter.',
    face: (dir: string) => `Zum Hineingehen nach ${dir} schauen.`,
  },
  en: {
    title: 'Arrived',
    stay: 'Stay here',
    toMap: 'Back to map',
    backIn: (s: number) => `Back to the map in ${s} seconds.`,
    staying: 'You stay here. The button below takes you back to the map.',
    resumed: 'You are moving away from the entrance. Guidance continues.',
    face: (dir: string) => `To enter, face ${dir}.`,
  },
}[lang === 'de' ? 'de' : 'en']

export function realSensors(): Sensors {
  return {
    media: session.stream ? { kind: 'stream', stream: session.stream } : { kind: 'none' },
    start(onFix, onHeading) {
      const stopHeading = startHeading(onHeading)
      const id =
        'geolocation' in navigator
          ? navigator.geolocation.watchPosition(
              (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy ?? null }),
              () => {},
              { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
            )
          : null
      return () => {
        stopHeading()
        if (id !== null) navigator.geolocation.clearWatch(id)
      }
    },
  }
}

export function applyContrast(c: OutputConfig['contrast']): void {
  document.documentElement.dataset.contrast = c
}

/** Thick arrow pointing up (0 degrees = straight ahead). Heavy dark outline over bright fill. */
export function arrowShape(): SVGElement {
  return s('path', {
    class: 'arrow-shape',
    d: 'M0 -34 L22 -6 L8 -6 L8 26 L-8 26 L-8 -6 L-22 -6 Z',
    'stroke-linejoin': 'round',
  })
}

function coneShape(halfDeg: number): SVGElement {
  const r = 38
  const a = (halfDeg * Math.PI) / 180
  const x = r * Math.sin(a)
  const y = -r * Math.cos(a)
  return s('path', { class: 'cone-shape', d: `M0 8 L${-x} ${y + 8} A${r} ${r} 0 0 1 ${x} ${y + 8} Z`, 'stroke-linejoin': 'round' })
}

export function directionWord(rel: number): string {
  const a = Math.abs(rel)
  if (a <= ON_BEARING_DEG) return t.ahead
  if (a <= 45) return rel < 0 ? t.slightLeft : t.slightRight
  if (a <= 135) return rel < 0 ? t.turnLeft : t.turnRight
  return t.behind
}

/** Material Symbols turn glyph for the green instruction card, same bands as directionWord. */
function turnGlyph(rel: number): string {
  const a = Math.abs(rel)
  if (a <= ON_BEARING_DEG) return 'straight'
  if (a <= 45) return rel < 0 ? 'turn_slight_left' : 'turn_slight_right'
  if (a <= 135) return rel < 0 ? 'turn_left' : 'turn_right'
  return 'u_turn_left'
}

function compassWord(deg: number): string {
  return t.compass[Math.round(deg / 45) % 8]
}

function lookTargetText(target: ArrowTarget): string {
  const e = target.entrance
  const parts: string[] = []
  parts.push(e.stepFree === true ? 'step-free entrance' : 'entrance')
  if (e.door) parts.push(t.door[e.door]?.toLowerCase() ?? 'door')
  if (e.name) parts.push(`named ${e.name}`)
  return parts.join(', ')
}

function grabFrame(el: HTMLVideoElement | HTMLImageElement | null): string | null {
  if (!el) return null
  const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth || 1024
  const hgt = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight || 768
  if (!w || !hgt) return null
  const scale = Math.min(1, 768 / w)
  const c = document.createElement('canvas')
  c.width = Math.round(w * scale)
  c.height = Math.round(hgt * scale)
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(el, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.7).split(',')[1] ?? null
}

export function LiveView(opts: {
  target: ArrowTarget
  sensors: Sensors
  config: OutputConfig
  onExit: () => void
  onReplay?: () => void
}): () => void {
  const { target, config: cfg } = opts
  const e = target.entrance
  applyContrast(cfg.contrast)
  const name = e.name ?? t.unnamedEntrance

  // ---- DOM ----
  let mediaEl: HTMLVideoElement | HTMLImageElement | null = null
  if (opts.sensors.media.kind === 'stream') {
    const v = h('video', { class: 'cam', playsinline: true, muted: true, autoplay: true, 'aria-hidden': 'true' }) as HTMLVideoElement
    v.muted = true
    v.srcObject = opts.sensors.media.stream
    void v.play().catch(() => {})
    mediaEl = v
  } else if (opts.sensors.media.kind === 'image') {
    mediaEl = h('img', { class: 'cam', src: opts.sensors.media.url, alt: '', 'aria-hidden': 'true' }) as HTMLImageElement
  }

  const arrowG = s('g', { class: 'arrow' }, arrowShape())
  const coneG = s('g', { class: 'cone' })
  const rotor = s('g', {}, coneG, arrowG)
  const scaler = s('g', { transform: `translate(0 16) scale(${cfg.arrowScale * 0.55})` }, rotor)
  // Destination glyph: +40% over the standard 12-unit pin, heavy dark outline over bright fill.
  const PIN = 12 * 1.4
  const destG = s(
    'g',
    { class: 'dest', visibility: 'hidden' },
    s('circle', { r: PIN / 2 + 1.5, class: 'dest-outline' }),
    s('circle', { r: PIN / 2, class: 'dest-fill' }),
    s('g', { transform: `translate(${-PIN / 2} ${-PIN / 2}) scale(${PIN / 32})` }, ...(e.stepFree === true ? glyphPaths('#000') : [s('rect', { x: 10, y: 6, width: 12, height: 20, fill: 'none', stroke: '#000', 'stroke-width': 3 })])),
  )
  const svg = s('svg', { class: 'overlay', viewBox: '-50 -50 100 100', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' }, destG, scaler)

  const distEl = h('p', { class: 'distance' }, '')
  const dirEl = h('p', { class: 'direction' }, t.waitingGps)
  const accEl = h('p', { class: 'accuracy' }, '')
  const warnEl =
    e.warnings.length > 0
      ? h('div', { class: 'warning', role: 'note' }, ...e.warnings.map((w) => h('p', {}, h('strong', {}, `${t.warningPrefix}: `), t.warning[w] ?? w)))
      : null
  const lookOut = h('p', { class: 'look-out', 'aria-live': 'polite' }, '')
  const lookBtn = h('button', { class: 'gm-pill', type: 'button' }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'visibility'), t.look)
  const stopBtn = h('button', { class: 'nav-exit', type: 'button', 'aria-label': t.stop }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'close'))
  const endRow = h('div', { class: 'nav-row' })
  const turnIcon = h('span', { class: 'ms', 'aria-hidden': 'true' }, 'navigation')

  const root = h(
    'section',
    { class: `screen screen-live${cfg.dimScreen ? ' dim' : ''}`, 'aria-labelledby': 'live-title' },
    mediaEl,
    svg,
    h(
      'div',
      { class: 'nav-top' },
      h('div', { class: 'nav-card' }, turnIcon, h('div', {}, h('h1', { id: 'live-title' }, `${t.liveTitle}: ${name}`), distEl, dirEl)),
      opts.sensors.banner ? h('p', { class: 'banner' }, opts.sensors.banner) : null,
      warnEl,
    ),
    h('div', { class: 'nav-bottom' }, accEl, lookOut, endRow, h('div', { class: 'nav-row' }, stopBtn, lookBtn)),
  )
  mount(root)

  // ---- state ----
  let fix: Fix | null = null
  let heading: Heading | null = null
  let rel = 0
  let dist = NaN
  let arrived = false
  let spokeArrival = false
  let spokeApproach = false
  let lastHaptic = 0
  let lastSpoken = 0
  let lastWord = ''
  let calloutIdx = 0
  let lookBusy = false
  const beacon = cfg.beacon && session.audio ? new BeaconAudio(session.audio) : null
  let beaconOn = false

  let history: TimedFix[] = []
  const timers: number[] = []
  let countdown = 0
  let cardEl: HTMLElement | null = null

  const clearTimers = () => {
    timers.splice(0).forEach((id) => clearTimeout(id))
    if (countdown) clearInterval(countdown)
    countdown = 0
  }

  function arrive() {
    arrived = true
    if (cfg.haptics || cfg.beacon) vibrate(HAPTIC_ARRIVED) // one long cue; iOS gets the sound
    beacon?.stop()
    beaconOn = false
    dirEl.textContent = t.arrived
    turnIcon.textContent = 'where_to_vote'
    arrowG.style.visibility = 'hidden'
    coneG.replaceChildren()
    destG.setAttribute('visibility', 'hidden')
    if (!spokeArrival && cfg.speak) speak(t.arrived, { interrupt: true })
    spokeArrival = true
    announce(t.arrived)
    timers.push(window.setTimeout(showArrivalCard, ARRIVAL_CARD_DELAY_MS))
  }

  function showArrivalCard() {
    const lines: string[] = []
    const doorType = e.door ? t.door[e.door] ?? null : null
    const face = e.approachBearing !== null ? ARR.face(compassWord(e.approachBearing)) : null
    const warns = e.warnings.map((w) => t.warning[w] ?? w)
    const secsEl = h('p', { class: 'arrival-count' }, ARR.backIn(ARRIVAL_EXIT_S))
    const stayBtn = h('button', { class: 'gm-pill gm-pill-primary', type: 'button' }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'pan_tool'), ARR.stay)
    const mapBtn = h('button', { class: 'gm-pill', type: 'button' }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'map'), ARR.toMap)
    cardEl = h(
      'div',
      { class: 'arrival', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'arrival-title' },
      h(
        'div',
        { class: 'arrival-head' },
        h('span', { class: 'ms', 'aria-hidden': 'true' }, 'where_to_vote'),
        h('h2', { id: 'arrival-title' }, ARR.title),
        h('p', { class: 'arrival-name' }, name),
      ),
      h(
        'div',
        { class: 'arrival-body' },
        doorType ? h('p', { class: 'arrival-door' }, doorType) : null,
        ...warns.map((w) => h('p', { class: 'arrival-warn', role: 'note' }, h('strong', {}, `${t.warningPrefix}: `), w)),
        face ? h('p', { class: 'arrival-face' }, face) : null,
        secsEl,
        h('div', { class: 'nav-row' }, mapBtn, stayBtn),
      ),
    )
    root.classList.add('is-arrived') // camera and overlay leave the screen
    root.append(cardEl)
    stayBtn.focus({ preventScroll: true })

    lines.push(`${ARR.title}. ${name}.`)
    if (doorType) lines.push(`${doorType}.`)
    for (const w of warns) lines.push(`${t.warningPrefix}. ${w}`)
    if (face) lines.push(face)
    if (cfg.speak) speak(lines.join(' '))
    announce(ARR.backIn(ARRIVAL_EXIT_S)) // once, not every second

    let left = ARRIVAL_EXIT_S
    countdown = window.setInterval(() => {
      left--
      secsEl.textContent = ARR.backIn(Math.max(0, left))
      if (left <= 0) exit()
    }, 1000)
    stayBtn.addEventListener('click', () => {
      if (countdown) clearInterval(countdown)
      countdown = 0
      secsEl.textContent = ARR.staying
      announce(ARR.staying)
      stayBtn.remove()
    })
    mapBtn.addEventListener('click', exit)
  }

  function cancelArrival() {
    clearTimers()
    arrived = false
    spokeArrival = false
    history = history.slice(-1)
    cardEl?.remove()
    cardEl = null
    root.classList.remove('is-arrived')
    lastWord = ''
    lastSpoken = 0
    if (cfg.speak) speak(ARR.resumed, { interrupt: true })
    announce(ARR.resumed)
  }

  function update() {
    if (!fix) return
    // CONTRACT v1 has no footway graph: snapToGraph passes the fix through (see core/match.ts).
    const pos = snapToGraph(fix, []).pos
    dist = haversineM(pos, target)
    const toDoor = bearingDeg(pos, target)
    const hasHeading = heading !== null && heading.source !== 'none'
    rel = hasHeading ? relativeBearing(toDoor, heading!.deg) : 0
    const cone = heading?.source === 'gps-course' || (fix.accuracy ?? 0) > CONE_ACCURACY_M
    const now = performance.now()
    if (dist > LEAVE_M) spokeArrival = false

    distEl.textContent = t.metres(dist)
    accEl.textContent = fix.accuracy !== null ? t.accuracy(fix.accuracy) : ''

    if (arrived) {
      // Walked away again before leaving: cancel arrival and guide on.
      if (dist > LEAVE_M) cancelArrival()
      else return
    }
    if (isArrived(history, target)) {
      arrive()
      return
    }

    if (!hasHeading) {
      dirEl.textContent = t.noCompass
      arrowG.style.visibility = 'hidden'
      coneG.replaceChildren()
      beacon?.update(beaconFor(dist, 0))
    } else {
      const word = cone ? `${t.roughly}. ${directionWord(rel)}` : directionWord(rel)
      dirEl.textContent = word
      turnIcon.textContent = turnGlyph(rel)
      rotor.setAttribute('transform', `rotate(${rel.toFixed(1)})`)
      if (cone) {
        const half = Math.min(60, Math.max(20, (Math.atan2(fix.accuracy ?? CONE_ACCURACY_M, Math.max(dist, 1)) * 180) / Math.PI))
        coneG.replaceChildren(coneShape(half))
        arrowG.style.visibility = 'hidden'
      } else {
        coneG.replaceChildren()
        arrowG.style.visibility = 'visible'
      }
      // Destination glyph where the door should be in the camera frame (about 70 degree FOV).
      if (Math.abs(rel) <= 35 && !cone) {
        destG.setAttribute('visibility', 'visible')
        destG.setAttribute('transform', `translate(${((rel / 35) * 38).toFixed(1)} -27)`)
      } else destG.setAttribute('visibility', 'hidden')

      if (beacon) {
        if (!beaconOn) {
          beacon.start()
          beaconOn = true
        }
        beacon.update(beaconFor(dist, rel))
      }
      if (cfg.haptics && now - lastHaptic > HAPTIC_EVERY_MS) {
        const pat = hapticFor(dist, rel)
        if (pat) {
          vibrate(pat, cuePan(pat))
          lastHaptic = now
        }
      }
      if (word !== lastWord && now - lastSpoken > SPEAK_EVERY_MS) {
        lastWord = word
        lastSpoken = now
        if (cfg.speak) speak(word)
        else announce(word)
      }
    }

    let crossed = false
    while (calloutIdx < DISTANCE_CALLOUTS.length && dist <= DISTANCE_CALLOUTS[calloutIdx]) {
      calloutIdx++
      crossed = true
    }
    if (crossed && cfg.speak && !shouldSpeakArrival(dist)) speak(t.metres(dist))

    // One-off at 10 m: he is in the vicinity of the entrance.
    if (!spokeApproach && shouldAnnounceApproach(dist)) {
      spokeApproach = true
      if ((cfg.beacon || cfg.haptics) && session.audio) playApproachChime(session.audio)
      if (cfg.speak) speak(t.approaching, { interrupt: true })
      announce(t.approaching)
    }

    // Spoken arrival line fires 2.5 m early to hide speech latency.
    if (!spokeArrival && shouldSpeakArrival(dist)) {
      spokeArrival = true
      const parts = [t.arrivingSoon]
      if (e.approachBearing !== null) parts.push(t.faceToEnter(compassWord(e.approachBearing)))
      for (const w of e.warnings) parts.push(`${t.warningPrefix}. ${t.warning[w] ?? w}`)
      if (cfg.speak) speak(parts.join(' '), { interrupt: true })
      announce(parts.join(' '))
    }
  }

  // Continuous pulse: rate rises as |rel| falls. Render loop does arithmetic only.
  let phase = 0
  let last = performance.now()
  let raf = 0
  const frame = (now: number) => {
    const dt = (now - last) / 1000
    last = now
    phase = (phase + dt * arrowPulseHz(rel)) % 1
    const k = 1 + 0.12 * Math.sin(phase * Math.PI * 2) ** 2
    arrowG.setAttribute('transform', `scale(${k.toFixed(3)})`)
    coneG.setAttribute('opacity', (0.65 + 0.35 * Math.sin(phase * Math.PI) ** 2).toFixed(2))
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  if (cfg.speak) speak(t.guidingTo(name),{ interrupt: true })

  const stopSensors = opts.sensors.start(
    (f) => {
      fix = f
      history.push({ lat: f.lat, lon: f.lon, t: performance.now() })
      if (history.length > 5) history = history.slice(-5)
      update()
    },
    (hd) => {
      heading = hd
      update()
    },
    () => {
      endRow.replaceChildren(h('p', { class: 'hint' }, t.replayDone))
      if (opts.onReplay) {
        const again = opts.onReplay
        endRow.append(
          h('button', { class: 'gm-pill gm-pill-primary', type: 'button', onclick: () => { teardown(); again() } }, t.replayAgain),
        )
      }
      announce(t.replayDone)
    },
  )

  lookBtn.addEventListener('click', async () => {
    if (lookBusy) return
    const frame64 = grabFrame(mediaEl)
    if (!frame64) {
      lookOut.textContent = t.lookError
      return
    }
    lookBusy = true
    lookBtn.setAttribute('aria-busy', 'true')
    lookOut.textContent = t.lookBusy
    try {
      const say = await postLook({ frame: frame64, heading: heading?.deg ?? 0, distanceM: Number.isFinite(dist) ? dist : 0, target: lookTargetText(target) })
      lookOut.textContent = say
      if (cfg.speak) speak(say, { interrupt: true })
    } catch (err) {
      lookOut.textContent = (err as { status?: number }).status === 503 ? t.lookNotConfigured : t.lookError
    } finally {
      lookBusy = false
      lookBtn.removeAttribute('aria-busy')
    }
  })

  function exit() {
    teardown()
    opts.onExit()
  }

  function teardown() {
    clearTimers()
    cancelAnimationFrame(raf)
    stopSensors()
    beacon?.stop()
    try {
      speechSynthesis?.cancel()
    } catch {
      /* ignored */
    }
  }
  stopBtn.addEventListener('click', exit)
  return teardown
}
