// Screen 4: camera full-bleed, SVG overlay above it.
//
// Accepts only an ArrowTarget (core/target.ts), which can only be minted for tier 1.
// Everything in the hot path is arithmetic. /api/look is called ONLY from the button.

import { arrowPulseHz, ARRIVE_M, beaconFor, cuePan, hapticFor, HAPTIC_ARRIVED, ON_BEARING_DEG, shouldAnnounceApproach, shouldSpeakArrival } from '../core/beacon'
import { bearingDeg, haversineM, relativeBearing } from '../core/geo'
import { distanceKey, stopSpeech } from '../core/speech'
import { SteadyAngle } from './arrowSteady'
import { CalmWord, isMuted, LineGate, muteButton } from './voiceCalm'
import { connected, tailLength, instructionLine, maneuverGlyph, nextManeuver, progressAlong, type Route } from '../core/route'
import { cachedRoute, computeRoute, D } from './Directions'
import { chevronStack, destinationPin, stackTransform, type ArPhase } from './ar'
import './ar.css'
import { startHeading, startPitch, type Heading } from '../core/heading'
import { snapToGraph } from '../core/match'
import type { OutputConfig, Profile } from '../core/profile'
import type { ArrowTarget } from '../core/target'
import { BeaconAudio, playApproachChime } from '../audio'
import { postLook } from '../data'
import { announce, primeSpeech, session, speak, vibrate } from '../session'
import { preloadClips } from './clips'
import { lang, t } from '../strings'
import { h, mount, s } from './dom'
import './arrival.css'
import { APPROACH_TRIGGER, approachModeFor, type ApproachMode } from './approachPort'
import './approach.css'
import { pathDoorName } from './doorName'

export interface Fix {
  lat: number
  lon: number
  accuracy: number | null
}

export type Media = { kind: 'stream'; stream: MediaStream } | { kind: 'image'; url: string } | { kind: 'none' }

export interface Sensors {
  media: Media
  banner?: string
  /**
   * True for the ?sim=1 replay. Its track is a straight line to the door, so a real walking
   * route would make distance, turns and "direkt vor dir" disagree with where it walks.
   */
  replay?: boolean
  /** Start feeding fixes and headings; onEnd fires when a replay runs out. Returns stop(). */
  start(onFix: (f: Fix) => void, onHeading: (h: Heading) => void, onEnd?: () => void): () => void
}

/** Cone instead of line when GPS is worse than this (metres). */
export const CONE_ACCURACY_M = 25
const HAPTIC_EVERY_MS = 3000
// 10 m is covered by the one-off approach line (core/beacon.ts APPROACH_M).
const DISTANCE_CALLOUTS = [50, 20]

/** Jitter-tolerant arrival: two still fixes within this radius count as arrived. */
export const ARRIVE_JITTER_M = 4
/** Below this speed (m/s) between the last two fixes the user counts as standing. */
export const STILL_MPS = 0.5
/** Walking this far away again while the arrival card shows resumes guidance. */
export const LEAVE_M = 8
export const ARRIVAL_CARD_DELAY_MS = 1500
/** The red Maps pin takes over from the chevrons this close in, as Google's does. */
export const APPROACH_PIN_M = 25

/**
 * Pure. Is "Zum Eingang führen" offered in the Live View panel? From APPROACH_PIN_M in,
 * with the same 1.3x hysteresis as the pin, so a jittering fix does not flash it.
 * Real GPS next to a building is off by 5 to 30 m, so waiting for the 3 m arrival card
 * alone can mean the button never appears at all.
 */
export function nearTriggerShown(distM: number, shown: boolean): boolean {
  if (!Number.isFinite(distM)) return shown
  return distM <= (shown ? APPROACH_PIN_M * 1.3 : APPROACH_PIN_M)
}
export const ARRIVAL_EXIT_S = 20
/** Worse GPS than this never announces arrival: a 60 m circle cannot tell "at the door" from "across the square". */
export const ARRIVE_MAX_ACCURACY_M = 30
/** No position for this long while guiding: say so (a frozen arrow is a lie). */
export const GPS_LOST_MS = 5000
/** How often an explained wait (no position yet, position lost) is said again. The
 *  beacon is off while it lasts, so a single line would leave a blind user in silence
 *  that reads as a crash; 45 s (Sami's voice calm) keeps it from nagging. */
export const WAIT_REPEAT_MS = 45000

/** Pure. May this fix announce arrival? Unknown accuracy counts as good (replays, desktop). */
export function arrivalTrusted(accuracy: number | null): boolean {
  return accuracy === null || !(accuracy > ARRIVE_MAX_ACCURACY_M)
}

/** Pure. Has the user really walked away from the arrival point? A poor fix must move
 *  further than its own error circle before the arrival card is taken away. */
export function walkedAway(distM: number, accuracy: number | null): boolean {
  return distM > Math.max(LEAVE_M, accuracy ?? 0)
}

/** Pure. The one line Live View opens with: the safety line first, then where to. */
export function openingLine(name: string): string {
  return `${t.arSafeSub ?? ''} ${t.guidingTo(name)}`.trim()
}

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

/**
 * Pure. How the arrival card behaves for an approach mode. A speech (guide) user must
 * not be bounced back to the map while still finding the door: focus lands on
 * "Zum Eingang führen", there is no auto-exit, and the spoken line names the button.
 * Everyone else keeps "Hier bleiben" focused and the countdown to the map.
 */
export function arrivalPlan(mode: ApproachMode | null): { focus: 'approach' | 'stay'; exitAfterS: number | null; nameTrigger: boolean } {
  return mode === 'guide'
    ? { focus: 'approach', exitAfterS: null, nameTrigger: true }
    : { focus: 'stay', exitAfterS: ARRIVAL_EXIT_S, nameTrigger: false }
}

/** Arrival card strings; kept local so strings.ts stays untouched. */
const ARR = {
  de: {
    title: 'Angekommen',
    stay: 'Hier bleiben',
    toMap: 'Zur Karte',
    backIn: (s: number) => `Zurück zur Karte in ${s} Sekunden.`,
    staying: 'Du bleibst hier. Zur Karte kommst du mit dem Knopf unten.',
    gpsLost: 'Kein GPS-Signal. Die Richtung ist gerade nicht sicher. Bleib kurz stehen.',
    gpsBack: 'GPS ist wieder da.',
    resumed: 'Du entfernst dich vom Eingang. Die Führung läuft weiter.',
    face: (dir: string) => `Zum Hineingehen nach ${dir} schauen.`,
  },
  en: {
    title: 'Arrived',
    stay: 'Stay here',
    toMap: 'Back to map',
    backIn: (s: number) => `Back to the map in ${s} seconds.`,
    staying: 'You stay here. The button below takes you back to the map.',
    gpsLost: 'No GPS signal. The direction is not reliable right now. Stop for a moment.',
    gpsBack: 'GPS is back.',
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


export function directionWord(rel: number): string {
  const a = Math.abs(rel)
  if (a <= ON_BEARING_DEG) return t.ahead
  if (a <= 45) return rel < 0 ? t.slightLeft : t.slightRight
  if (a <= 135) return rel < 0 ? t.turnLeft : t.turnRight
  return t.behind
}

/** Clip key for a turn, on the same bands as turnGlyph and directionWord. */
function turnKey(rel: number): string {
  const a = Math.abs(rel)
  if (a <= ON_BEARING_DEG) return 'straight'
  return rel < 0 ? 'turn_left' : 'turn_right'
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

export function grabFrame(el: HTMLVideoElement | HTMLImageElement | null): string | null {
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
  /** Distinguishable door name from the map (doorName); never "Eingang ohne Namen". */
  name?: string
  sensors: Sensors
  config: OutputConfig
  onExit: () => void
  onReplay?: () => void
  /** Decides whether the arrival card offers "Zum Eingang führen" (never for deaf-only). */
  profile?: Profile | null
  /** Opens the last-10-metres screen. LiveView tears itself down first. */
  onApproach?: (mode: ApproachMode) => void
}): () => void {
  const { target, config: cfg } = opts
  const e = target.entrance
  applyContrast(cfg.contrast)
  const name = opts.name ?? pathDoorName(e)

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

  // ── Live View, measured from a Google Maps Live View recording ─────────────
  // Phases: scanning -> ready -> guiding -> approach -> arrived.
  // Chevrons are extruded solids (see ui/ar.ts); the red pin replaces them close in.
  const stack = chevronStack()
  const stackG = s('g', { class: 'ar-stack-wrap' }, stack)
  const pinG = s('g', { class: 'ar-pin-wrap', visibility: 'hidden' }, destinationPin())
  const coneG = s('g', { class: 'cone' })
  const svg = s('svg', { class: 'ar-svg', viewBox: '0 0 393 760', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true' }, coneG, stackG, pinG)

  const ms = (n: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, n)

  // scanning
  const scanText = h('p', { class: 'ar-scan-text' }, t.arScan ?? 'Richte die Kamera auf Gebäude, Geschäfte und Schilder um dich herum.')
  const scanArt = s('svg', { class: 'ar-scan-art', viewBox: '0 0 120 120', 'aria-hidden': 'true' },
    s('rect', { x: '44', y: '18', width: '32', height: '58', rx: '6', fill: 'none', stroke: '#a8c7fa', 'stroke-width': '4' }),
    s('rect', { x: '50', y: '26', width: '20', height: '38', rx: '2', fill: '#a8c7fa', opacity: '0.35' }),
    s('path', { d: 'M28 92 q32 -16 64 0', fill: 'none', stroke: '#a8c7fa', 'stroke-width': '4', 'stroke-linecap': 'round' }),
  ) as unknown as HTMLElement
  const pill = h('div', { class: 'ar-pill' }, t.arScanning ?? 'Scanning …')
  const follow = h('p', { class: 'ar-follow', hidden: true }, t.arFollow ?? 'Folge dem Pfeil')

  // destination strip
  const distEl = h('span', { class: 'ar-dest-m' }, '')
  const dirEl = h('span', { class: 'sr-only' }, t.waitingGps)
  const destStrip = h('div', { class: 'ar-dest' },
    h('div', { class: 'ar-dest-pin' }, ms('location_on'), distEl),
    h('span', { class: 'ar-dest-name' }, name),
  )

  // safety interstitial
  const safeEl = h('div', { class: 'ar-safe', hidden: true, role: 'note' },
    ms('warning'),
    h('p', { class: 'ar-safe-t' }, t.arSafe ?? 'Pass auf dich auf'),
    h('p', { class: 'ar-safe-s' }, t.arSafeSub ?? 'Achte beim Gehen auf deine Umgebung.'),
  )

  // Manoeuvre banner. Maps puts the next turn at the top of the screen and this app
  // built it sr-only, so the one element everybody recognises from navigation was
  // never drawn. aria-hidden: dirEl below is still the element screen readers read,
  // so adding pixels here changes nothing that is spoken.
  const manGlyph = h('span', { class: 'ms ar-man-ic', 'aria-hidden': 'true' }, 'straight')
  const manDist = h('span', { class: 'ar-man-d' }, '')
  const manText = h('span', { class: 'ar-man-t' }, '')
  const manBanner = h(
    'div',
    { class: 'ar-man', hidden: true, 'aria-hidden': 'true' },
    manGlyph,
    h('span', { class: 'ar-man-body' }, manDist, manText),
  )

  const accEl = h('p', { class: 'ar-meta' }, '')
  const lookOut = h('p', { class: 'ar-look-out', 'aria-live': 'polite' }, '')
  const lookBtn = h('button', { class: 'ar-look', type: 'button' }, ms('visibility'), t.look)
  // The last 10 metres, offered as soon as the door is close, not only after GPS says
  // "arrived". An ordinary button: VoiceOver's own double-tap activates it.
  const approachMode = opts.onApproach ? approachModeFor(opts.profile) : null
  const nearBtn = approachMode
    ? h('button', { class: 'apr-trigger ar-near', type: 'button', hidden: true }, ms('door_front'), APPROACH_TRIGGER)
    : null
  const stopBtn = h('button', { class: 'ar-round', type: 'button', 'aria-label': t.stop }, ms('close'))
  const muteBtn = muteButton((m) => {
    if (!m) return
    beacon?.stop()
    beaconOn = false
    stopSpeech() // clips and the pending device-voice fallback of an /api/speak line
    try {
      speechSynthesis?.cancel()
    } catch {
      /* ignored */
    }
  })
  const fbBtn = h('button', { class: 'ar-round', type: 'button', 'aria-label': t.feedback }, ms('feedback'))
  const endRow = h('div', { class: 'ar-endrow' })
  const turnIcon = h('span', { class: 'sr-only' }, '')
  // Said on screen when guidance has no route: the arrow then aims straight at the
  // door, and pretending that is a route is how people get sent into a wall.
  // The route note: a one-line strip under the top buttons. It folds into a 44 px info
  // button after NOTE_FOLD_MS so it never sits over the arrow; a tap unfolds it again.
  const noRouteEl = h('button', { class: 'ar-noroute', type: 'button', hidden: true }, '') as HTMLButtonElement
  const NOTE_FOLD_MS = 8000
  let noteTimer = 0
  const unfoldNote = (fold: boolean) => {
    clearTimeout(noteTimer)
    noRouteEl.classList.remove('is-folded')
    noRouteEl.removeAttribute('aria-label')
    noRouteEl.setAttribute('aria-expanded', 'true')
    if (fold)
      noteTimer = window.setTimeout(() => {
        if (closed || noRouteEl.hidden) return
        noRouteEl.classList.add('is-folded')
        noRouteEl.setAttribute('aria-label', lang === 'de' ? 'Hinweis zur Route anzeigen' : 'Show route note')
        noRouteEl.setAttribute('aria-expanded', 'false')
      }, NOTE_FOLD_MS)
  }
  noRouteEl.addEventListener('click', () => {
    if (!noRouteEl.classList.contains('is-folded')) return
    unfoldNote(!gpsLost)
    announce(noRouteEl.textContent ?? '')
  })

  const warnEl =
    e.warnings.length > 0
      ? h('div', { class: 'warning', role: 'note' }, ...e.warnings.map((w) => h('p', {}, h('strong', {}, `${t.warningPrefix}: `), t.warning[w] ?? w)))
      : null

  const root = h(
    'section',
    { class: `ar${cfg.dimScreen ? ' dim' : ''}`, 'aria-labelledby': 'live-title' },
    h('h1', { id: 'live-title', class: 'sr-only' }, `${t.liveTitle}: ${name}`),
    mediaEl,
    svg,
    muteBtn,
    h('div', { class: 'ar-top' }, fbBtn, stopBtn),
    manBanner,
    noRouteEl,
    scanText, scanArt, pill, follow,
    opts.sensors.banner ? h('p', { class: 'banner' }, opts.sensors.banner) : null,
    warnEl,
    accEl, lookOut, lookBtn, nearBtn, endRow,
    destStrip, safeEl, dirEl,
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
  let lastWord = ''
  let calloutIdx = 0
  let lookBusy = false
  let nearShown = false
  // Know which approach clips exist before the tap, so a missing one is spoken at once.
  if (approachMode === 'guide') preloadClips(lang)
  let saidNear = false
  /** Backgrounded: no voice, no beacon, no countdown; coming back says the direction again. */
  let hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  let saidNoCompass = false
  const voiceOn = () => cfg.speak && !isMuted()
  const gate = new LineGate()
  const calmWord = new CalmWord(directionWord)
  // A magnetometer jitters several degrees at rest and fires ~60 Hz, so the raw
  // heading is fed through a circular low-pass with a deadband. Without it the
  // arrow renders sensor noise and visibly vibrates.
  // Google re-shows a safety reminder periodically while you walk.
  const SAFE_EVERY_MS = 45000
  const SAFE_SHOW_MS = 4000
  let arPhase: ArPhase = 'scanning'
  // Device pitch (beta), low-passed. null until the first orientation event: then the
  // chevrons keep today's fixed screen placement.
  let pitch: number | null = null
  let lastSafe = 0

  // Walking route to the door. Until it arrives (or if none exists) guidance falls
  // back to a straight-line bearing, which points through buildings — so the UI says
  // "direkt" in that case rather than pretending it is a route.
  let route: Route | null = null
  /** The route's path plus the connector from where it was asked to where it starts. */
  let followPath: [number, number][] = []
  let routeAsked = false
  let routeBusy = false
  /** Set by teardown: a reply that lands after the approach took over must not speak. */
  let closed = false
  let lastRouteAt = 0
  let offRouteSince = 0
  /** Re-route after this long off the path, and never more often than REROUTE_EVERY_MS. */
  const OFF_ROUTE_GRACE_MS = 6000
  const REROUTE_EVERY_MS = 20000

  function askRoute(from: { lat: number; lon: number }) {
    if (routeBusy) return
    routeBusy = true
    lastRouteAt = performance.now()
    void computeRoute(from, target).then((out) => {
      routeBusy = false
      if (closed) return
      if (out.ok) {
        route = out.route
        followPath = connected(from, out.route.path, target)
        noRouteEl.hidden = true
        lastWord = ''
      } else if (!route) {
        // Short, no technical reason (the key/quota detail helps nobody on the pavement).
        noRouteEl.textContent = lang === 'de' ? 'Keine Route. Der Pfeil zeigt direkt zum Eingang.' : 'No route. The arrow points straight at the entrance.'
        noRouteEl.hidden = false
        unfoldNote(true)
        announce(noRouteEl.textContent)
      }
      update()
    })
  }

  // Smooth the RELATIVE bearing, not only the heading: close to the door the GPS makes
  // the bearing to it jump as much as the magnetometer does. Wide deadband: small
  // noise produces no motion at all (ui/arrowSteady.ts).
  const steady = new SteadyAngle()
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

  /** scanning -> ready -> guiding, then approach once the pin takes over. */
  function setPhase(next: ArPhase) {
    if (next === arPhase) return
    arPhase = next
    root.dataset.phase = next
    const scanning = next === 'scanning'
    const ready = next === 'ready'
    scanText.hidden = !scanning
    // scanArt is an SVGElement: .hidden is not reflected there, so set the attribute.
    if (scanning) scanArt.removeAttribute('hidden')
    else scanArt.setAttribute('hidden', '')
    pill.hidden = !(scanning || ready)
    pill.textContent = ready ? (t.arReady ?? 'Bereit') : (t.arScanning ?? 'Wird gescannt …')
    pill.classList.toggle('ar-pill-ready', ready)
    follow.hidden = !ready
    destStrip.hidden = scanning
    if (ready) {
      // "Ready" holds briefly, then the chevrons take the screen, as in the recording.
      timers.push(window.setTimeout(() => setPhase('guiding'), 1400))
    }
  }

  /** Google re-surfaces a safety reminder every so often; it dims everything behind it. */
  function maybeSafety(now: number) {
    if (arPhase !== 'guiding' || safeEl.hidden === false) return
    if (now - lastSafe < SAFE_EVERY_MS) return
    lastSafe = now
    safeEl.hidden = false
    root.dataset.safe = '1'
    timers.push(window.setTimeout(() => {
      safeEl.hidden = true
      delete root.dataset.safe
    }, SAFE_SHOW_MS))
  }

  /** Show or hide the panel trigger; announced once per Live View, never focus-stealing. */
  function setNear(show: boolean) {
    if (!nearBtn || show === nearShown) return
    nearShown = show
    nearBtn.hidden = !show
    if (show) root.dataset.near = '1'
    else delete root.dataset.near
    if (show && !saidNear) {
      saidNear = true
      announce(t.nearTrigger(APPROACH_TRIGGER))
    }
  }

  /** Both triggers (panel and arrival card) open the approach the same way. */
  function startApproach() {
    // Twice in a row (panel and card, or a double tap) would open two approach screens.
    if (closed || !approachMode || !opts.onApproach) return
    teardown() // stops the arrival card's speech, so the unlock comes after it
    // Still synchronous inside the tap: iOS only unlocks speech and audio here.
    primeSpeech()
    opts.onApproach(approachMode)
  }

  function arrive() {
    arrived = true
    setNear(false)
    if (cfg.haptics || cfg.beacon) vibrate(HAPTIC_ARRIVED) // one long cue; iOS gets the sound
    beacon?.stop()
    beaconOn = false
    dirEl.textContent = t.arrived
    turnIcon.textContent = 'where_to_vote'
    manBanner.hidden = true
    stackG.setAttribute('visibility', 'hidden')
    coneG.replaceChildren()
    pinG.setAttribute('visibility', 'hidden')
    root.dataset.phase = 'arrived'
    if (!spokeArrival && voiceOn()) speak(t.arrived, { interrupt: true })
    spokeArrival = true
    announce(t.arrived)
    timers.push(window.setTimeout(showArrivalCard, ARRIVAL_CARD_DELAY_MS))
  }

  function showArrivalCard() {
    const lines: string[] = []
    const doorType = e.door ? t.door[e.door] ?? null : null
    const face = e.approachBearing !== null ? ARR.face(compassWord(e.approachBearing)) : null
    const warns = e.warnings.map((w) => t.warning[w] ?? w)
    const plan = arrivalPlan(approachMode)
    const secsEl = h('p', { class: 'arrival-count', hidden: plan.exitAfterS === null }, plan.exitAfterS === null ? '' : ARR.backIn(plan.exitAfterS))
    const stayBtn = h('button', { class: 'gm-pill gm-pill-primary', type: 'button' }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'pan_tool'), ARR.stay)
    const mapBtn = h('button', { class: 'gm-pill', type: 'button' }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'map'), ARR.toMap)
    // The last 10 metres. An ordinary button: VoiceOver's own double-tap activates it,
    // a custom double-tap handler would be swallowed by VoiceOver.
    const mode = approachMode
    const approachBtn = mode
      ? h('button', { class: 'apr-trigger', type: 'button' }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'door_front'), APPROACH_TRIGGER)
      : null
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
        approachBtn,
        secsEl,
        h('div', { class: 'nav-row' }, mapBtn, stayBtn),
      ),
    )
    root.classList.add('is-arrived') // camera and overlay leave the screen
    root.append(cardEl)
    if (plan.focus === 'approach' && approachBtn) approachBtn.focus({ preventScroll: true })
    else stayBtn.focus({ preventScroll: true })

    lines.push(`${ARR.title}. ${name}.`)
    if (doorType) lines.push(`${doorType}.`)
    for (const w of warns) lines.push(`${t.warningPrefix}. ${w}`)
    if (face) lines.push(face)
    if (plan.nameTrigger && approachBtn) lines.push(t.triggerSelected(APPROACH_TRIGGER))
    if (voiceOn()) speak(lines.join(' '))
    if (plan.exitAfterS !== null) {
      announce(ARR.backIn(plan.exitAfterS)) // once, not every second
      let left = plan.exitAfterS
      countdown = window.setInterval(() => {
        if (hidden) return // backgrounded: the countdown waits for the user
        left--
        secsEl.textContent = ARR.backIn(Math.max(0, left))
        if (left <= 0) exit()
      }, 1000)
    }
    stayBtn.addEventListener('click', () => {
      if (countdown) clearInterval(countdown)
      countdown = 0
      secsEl.hidden = false
      secsEl.textContent = ARR.staying
      announce(ARR.staying)
      stayBtn.remove()
    })
    mapBtn.addEventListener('click', exit)
    approachBtn?.addEventListener('click', startApproach)
  }

  function cancelArrival() {
    clearTimers()
    arrived = false
    spokeArrival = false
    history = history.slice(-1)
    cardEl?.remove()
    cardEl = null
    root.classList.remove('is-arrived')
    root.dataset.phase = arPhase // 'arrived' would otherwise stick and hide the guidance
    safeEl.hidden = true
    delete root.dataset.safe
    // Focus was on the card that just went away; put it somewhere a finger can find.
    lookBtn.focus({ preventScroll: true })
    lastWord = ''
    gate.forget() // a deliberate re-say skips the gap and the no-repeat rule
    if (voiceOn()) speak(ARR.resumed, { interrupt: true })
    announce(ARR.resumed)
  }

  function update() {
    if (closed || hidden || !fix) return
    // CONTRACT v1 has no footway graph: snapToGraph passes the fix through (see core/match.ts).
    const pos = snapToGraph(fix, []).pos

    // One request, on the first real fix. Re-routing on every frame would burn quota
    // and make the arrow jitter between slightly different paths.
    // The route drawn in the preview is reused, so Start follows exactly what was shown.
    // A replay walks a straight line: follow that line, never a route it does not walk.
    if (!routeAsked && opts.sensors.replay) routeAsked = true
    if (!routeAsked) {
      routeAsked = true
      const hit = cachedRoute(pos, target)
      if (hit) {
        route = hit.route
        followPath = connected(hit.from, hit.route.path, target)
      } else askRoute(pos)
    }
    // Straight line as the floor; the route overrides both bearing and distance.
    dist = haversineM(pos, target)
    let toDoor = bearingDeg(pos, target)
    let onRoute = false
    if (route && followPath.length > 1) {
      const p = progressAlong(pos, followPath)
      if (p && !p.offRoute) {
        toDoor = p.bearing          // aim along the path, not through the building
        dist = p.remainingM         // metres still to WALK, not as the crow flies
        onRoute = true
        offRouteSince = 0
      } else if (p) {
        // Left the path: after a grace period, ask for a new route from here.
        const nowMs = performance.now()
        if (!offRouteSince) offRouteSince = nowMs
        if (nowMs - offRouteSince > OFF_ROUTE_GRACE_MS && nowMs - lastRouteAt > REROUTE_EVERY_MS) {
          dirEl.textContent = D.rerouting
          askRoute(pos)
        }
      }
    }
    // What to do next, from the route alone. Needs GPS, not a compass.
    const ahead = onRoute && route ? nextManeuver(dist, route, tailLength(route.path, followPath)) : null
    const aheadText = ahead ? instructionLine(ahead.step) ?? D.thenArrive(name) : null
    const hasHeading = heading !== null && heading.source !== 'none'
    // GPS gone: freeze the arrow where it is rather than let a stale fix steer it.
    if (hasHeading && !gpsLost) {
      steady.push(relativeBearing(toDoor, heading!.deg), performance.now())
      rel = steady.rel
    } else if (!hasHeading) rel = 0
    // "Roughly this way" is for poor GPS only, and only when there is no route to follow.
    const cone = (fix.accuracy ?? 0) > CONE_ACCURACY_M
    const softHeading = heading?.source === 'gps-course'
    const now = performance.now()
    if (dist > LEAVE_M) spokeArrival = false

    if (arPhase === 'scanning' && hasHeading) setPhase('ready')
    if (arPhase === 'guiding' && dist <= APPROACH_PIN_M) setPhase('approach')
    else if (arPhase === 'approach' && dist > APPROACH_PIN_M * 1.3) setPhase('guiding')
    maybeSafety(now)

    distEl.textContent = t.metres(dist)
    // Good GPS needs no note; poor GPS is worth reading (fix-live.css: 16 px, 7:1).
    accEl.textContent = fix.accuracy !== null && fix.accuracy > 10 ? t.accuracy(fix.accuracy) : ''

    if (arrived) {
      // Walked away again before leaving: cancel arrival and guide on.
      if (walkedAway(dist, fix.accuracy)) cancelArrival()
      else return
    }
    setNear(nearTriggerShown(dist, nearShown))
    if (isArrived(history, target) && arrivalTrusted(fix.accuracy)) {
      arrive()
      return
    }

    const showBanner = (glyph: string) => {
      // GPS gone: the next turn is stale, and the banner would cover the status saying so.
      if (gpsLost) {
        manBanner.hidden = true
        return
      }
      if (ahead && aheadText && arPhase !== 'approach' && arPhase !== 'scanning') {
        manGlyph.textContent = ahead.step ? glyph : 'location_on'
        manDist.textContent = t.inMetres(ahead.toManeuverM)
        manText.textContent = aheadText
        manBanner.hidden = false
      } else {
        manBanner.hidden = true
      }
    }

    if (!hasHeading) {
      // No compass: the route still says what to do and how far away it is.
      dirEl.textContent = aheadText ? `${t.inMetres(ahead!.toManeuverM)}. ${aheadText}` : t.noCompass
      if (!aheadText && !saidNoCompass) {
        // Without a compass and without a route there is nothing to point with: say
        // so once instead of leaving the user in silence.
        saidNoCompass = true
        if (voiceOn()) speak(t.noCompass)
        announce(t.noCompass)
      }
      const glyph = maneuverGlyph(ahead?.step?.maneuver ?? null) ?? 'straight'
      if (arPhase === 'scanning' && aheadText) setPhase('ready')
      showBanner(glyph)
      if (aheadText && aheadText !== lastWord && gate.allow(aheadText, now)) {
        lastWord = aheadText
        const line = `${t.inMetres(ahead!.toManeuverM)}. ${aheadText}`
        if (voiceOn()) speak(line)
        else announce(line)
      }
      stackG.setAttribute('visibility', 'hidden')
      coneG.replaceChildren()
      beacon?.update(beaconFor(dist, 0))
    } else {
      const word = aheadText
        ? aheadText
        : cone
          ? `${t.roughly}. ${calmWord.propose(rel, now)}`
          : calmWord.propose(rel, now)
      dirEl.textContent = aheadText ? `${t.inMetres(ahead!.toManeuverM)}. ${aheadText}` : word
      const glyph = maneuverGlyph(ahead?.step?.maneuver ?? null) ?? turnGlyph(rel)
      turnIcon.textContent = glyph
      // The banner only claims a manoeuvre while we are actually following a route.
      // Off route it would be inventing turns, and inventing turns is the one thing
      // a blind user cannot check.
      showBanner(glyph)
      // Chevrons foreshorten as they swing away, the way an extruded plate would.
      // Attribute rather than CSS transform: the group lives in the SVG user space.
      stackG.setAttribute('transform', stackTransform(rel, 393, 760, pitch))
      if (cone || softHeading) {
        // Poor localisation dims the chevrons rather than hiding them: Google keeps
        // guidance on screen and softens the wording, and an empty screen tells a
        // partially-sighted user nothing at all.
        coneG.replaceChildren()
        stackG.setAttribute('visibility', 'visible')
        stackG.setAttribute('opacity', '0.88')
      } else {
        coneG.replaceChildren()
        stackG.setAttribute('opacity', '1')
        stackG.setAttribute('visibility', 'visible')
      }
      // The pin marks "the door is ahead" when roughly aimed at it. Centred above the
      // arrow, never sliding sideways: direction comes from the arrow's rotation only.
      // It grows slowly as the door gets closer.
      if (Math.abs(rel) <= 35 && arPhase === 'approach') {
        pinG.setAttribute('visibility', 'visible')
        pinG.setAttribute('transform', `translate(196.5 ${(760 * 0.2).toFixed(0)}) scale(${(0.7 + 0.3 * Math.max(0, APPROACH_PIN_M - dist) / APPROACH_PIN_M).toFixed(2)})`)
      } else pinG.setAttribute('visibility', 'hidden')

      if (beacon && !gpsLost && !isMuted()) {
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
      if (word !== lastWord && gate.allow(word, now)) {
        lastWord = word
        // A route line carries street names, so it goes to speech in full; the short
        // pre-generated clips only cover the compass words.
        if (aheadText) {
          const line = `${t.inMetres(ahead!.toManeuverM)}. ${aheadText}`
          if (voiceOn()) speak(line)
          else announce(line)
        } else if (voiceOn()) speak(word, { key: turnKey(rel) })
        else announce(word)
      }
    }

    let crossed = false
    while (calloutIdx < DISTANCE_CALLOUTS.length && dist <= DISTANCE_CALLOUTS[calloutIdx]) {
      calloutIdx++
      crossed = true
    }
    if (crossed && voiceOn() && !shouldSpeakArrival(dist)) speak(t.metres(dist), { key: distanceKey(dist) ?? undefined })

    // One-off at 10 m: he is in the vicinity of the entrance.
    if (!spokeApproach && shouldAnnounceApproach(dist)) {
      spokeApproach = true
      if ((cfg.beacon || cfg.haptics) && session.audio) playApproachChime(session.audio)
      // No clip: the 'arrived' clip says "Sie haben den Eingang erreicht.", which is wrong
      // ~10 m out and in the wrong register; the device voice reads the real sentence.
      if (voiceOn()) speak(t.approaching, { interrupt: true })
      announce(t.approaching)
    }

    // Spoken arrival line fires 2.5 m early to hide speech latency.
    if (!spokeArrival && shouldSpeakArrival(dist)) {
      spokeArrival = true
      const parts = [t.arrivingSoon]
      if (e.approachBearing !== null) parts.push(t.faceToEnter(compassWord(e.approachBearing)))
      for (const w of e.warnings) parts.push(`${t.warningPrefix}. ${t.warning[w] ?? w}`)
      if (voiceOn()) speak(parts.join(' '), { interrupt: true })
      announce(parts.join(' '))
    }
  }

  // Continuous pulse: rate rises as |rel| falls. Render loop does arithmetic only.
  let phase = 0
  const calmMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  let last = performance.now()
  let raf = 0
  const frame = (now: number) => {
    const dt = (now - last) / 1000
    last = now
    // A breath, not a throb: at 4 Hz and 12 % the chevrons read as shaking. Still faster
    // the better the aim, but at most ~1.2 Hz and 4 %; none with reduced motion.
    phase = (phase + dt * arrowPulseHz(rel) * 0.3) % 1
    const k = calmMotion ? 1 : 1 + 0.04 * Math.sin(phase * Math.PI * 2) ** 2
    stack.setAttribute('transform', `scale(${k.toFixed(3)})`)
    coneG.setAttribute('opacity', (0.65 + 0.35 * Math.sin(phase * Math.PI) ** 2).toFixed(2))
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  // The safety line is the first thing said, on speech and on the live region alike.
  if (voiceOn()) speak(openingLine(name), { interrupt: true })
  announce(openingLine(name))

  // Position watchdog: before the first fix and whenever fixes stop, say why nothing
  // moves. Its own interval, not in `timers`, because an arrival cancel clears those.
  const startedAt = performance.now()
  let lastFixAt = 0
  let gpsLost = false
  let lastWaitSaid = 0
  const sayWait = (text: string, now: number) => {
    lastWaitSaid = now
    if (voiceOn()) speak(text)
    announce(text)
  }
  const gpsWatch = window.setInterval(() => {
    if (closed || hidden || arrived) return
    const now = performance.now()
    if (!lastFixAt) {
      if (now - startedAt >= GPS_LOST_MS && now - lastWaitSaid >= WAIT_REPEAT_MS) sayWait(t.waitingGps, now)
      return
    }
    if (now - lastFixAt < GPS_LOST_MS) return
    if (!gpsLost) {
      gpsLost = true
      noRouteEl.dataset.prev = noRouteEl.hidden ? '' : (noRouteEl.textContent ?? '')
      noRouteEl.textContent = ARR.gpsLost
      noRouteEl.hidden = false
      unfoldNote(false) // GPS lost stays open until the fix is back
      beacon?.stop()
      beaconOn = false
      sayWait(ARR.gpsLost, now)
    } else if (now - lastWaitSaid >= WAIT_REPEAT_MS) sayWait(ARR.gpsLost, now)
  }, 1000)

  // Ground plane: re-project the chevrons as the phone tilts. Transform only, no redraw.
  const stopPitch = startPitch((b) => {
    pitch = pitch === null ? b : pitch + 0.25 * (b - pitch)
    if (heading && heading.source !== 'none') stackG.setAttribute('transform', stackTransform(rel, 393, 760, pitch))
  })

  const stopSensors = opts.sensors.start(
    (f) => {
      if (closed) return
      lastFixAt = performance.now()
      if (gpsLost) {
        gpsLost = false
        const prev = noRouteEl.dataset.prev ?? ''
        noRouteEl.textContent = prev
        noRouteEl.hidden = !prev
        if (prev) unfoldNote(true)
        lastWord = '' // say the direction again right away
        gate.forget() // a deliberate re-say skips the gap and the no-repeat rule
        if (voiceOn()) speak(ARR.gpsBack)
        announce(ARR.gpsBack)
      }
      fix = f
      history.push({ lat: f.lat, lon: f.lon, t: performance.now() })
      if (history.length > 5) history = history.slice(-5)
      update()
    },
    (hd) => {
      if (closed) return
      heading = hd
      update()
    },
    () => {
      if (closed) return
      endRow.replaceChildren(h('p', { class: 'hint' }, t.replayDone))
      if (opts.onReplay) {
        const again = opts.onReplay
        endRow.append(
          h('button', { class: 'gm-pill gm-pill-primary', type: 'button', onclick: () => { if (closed) return; teardown(); again() } }, t.replayAgain),
        )
      }
      announce(t.replayDone)
    },
  )

  lookBtn.addEventListener('click', async () => {
    if (lookBusy) return
    const frame64 = grabFrame(mediaEl)
    const fail = (msg: string) => {
      lookOut.textContent = msg
      // The live region reaches VoiceOver; speech users without it must hear it too.
      if (voiceOn()) speak(msg, { interrupt: true })
    }
    if (!frame64) {
      fail(t.lookError)
      return
    }
    lookBusy = true
    lookBtn.setAttribute('aria-busy', 'true')
    lookOut.textContent = t.lookBusy
    try {
      const say = await postLook({ frame: frame64, heading: heading?.deg ?? 0, distanceM: Number.isFinite(dist) ? dist : 0, target: lookTargetText(target) })
      if (closed) return
      lookOut.textContent = say
      // Unpredictable text: worth waiting a little longer for the network voice.
      if (voiceOn()) speak(say, { interrupt: true, apiTimeoutMs: 8000 })
    } catch (err) {
      if (closed) return
      fail((err as { status?: number }).status === 503 ? t.lookNotConfigured : t.lookError)
    } finally {
      lookBusy = false
      lookBtn.removeAttribute('aria-busy')
    }
  })

  function exit() {
    // Stop, "Zur Karte" and the countdown can all land at once; the map opens once.
    if (closed) return
    teardown()
    opts.onExit()
  }

  // Backgrounded: beacon and voice stop at once. Back: the next update says the
  // direction again, since the user may have turned while the screen was away.
  const onVisibility = () => {
    const nowHidden = document.visibilityState === 'hidden'
    if (nowHidden === hidden) return
    hidden = nowHidden
    if (hidden) {
      beacon?.stop()
      beaconOn = false
      stopSpeech() // and the pending device-voice fallback of an /api/speak line
      try {
        speechSynthesis?.cancel()
      } catch {
        /* ignored */
      }
    } else {
      const a = session.audio
      if (a && a.state !== 'running') void a.resume().catch(() => {})
      lastWord = ''
      gate.forget() // a deliberate re-say skips the gap and the no-repeat rule
      if (lastFixAt) lastFixAt = performance.now() // the gap was ours, not the GPS's
      update()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  function teardown() {
    if (closed) return
    closed = true
    clearTimeout(noteTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    clearInterval(gpsWatch)
    clearTimers()
    cancelAnimationFrame(raf)
    stopSensors()
    stopPitch()
    beacon?.stop()
    // The arrival card goes through /api/speak with a device-voice fallback 2 s later;
    // without this that late fallback queues the whole card ahead of the approach.
    stopSpeech()
    try {
      // Only when something is queued: WebKit drops an utterance spoken right after a
      // needless cancel(), and the approach's speech primer comes straight after this.
      if (speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel()
    } catch {
      /* ignored */
    }
  }
  stopBtn.addEventListener('click', exit)
  nearBtn?.addEventListener('click', startApproach)
  return teardown
}
