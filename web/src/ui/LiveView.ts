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
import type { Entrance } from '../core/types'
import { BeaconAudio, playApproachChime } from '../audio'
import { voiceAsk } from './voiceAsk'
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
/** The red pin takes the arrow's place only this close in (and on arrival). Never both. */
export const PIN_SWAP_M = 3

/** Pure. Arrow or pin in the centre? With 1 m hysteresis so a jittering fix does not flip it. */
export function centreMark(distM: number, pinShown: boolean): 'arrow' | 'pin' {
  if (!Number.isFinite(distM)) return pinShown ? 'pin' : 'arrow'
  return distM <= (pinShown ? PIN_SWAP_M + 1 : PIN_SWAP_M) ? 'pin' : 'arrow'
}

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
/** How often an explained wait (no position yet, position lost) is said again. */
export const WAIT_REPEAT_MS = 45000
/** A wait line (no position, GPS lost) is said at most this often per episode. */
export const WAIT_MAX_TIMES = 1

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
 * Pure. Does the arrival sheet ask "Sollen wir dir zeigen, wo du reinkommst?", and which
 * screen does "Ja" open? Every profile is asked, but only at a tier-1 door: the safety rule
 * lets only tier 1 carry arrows. The door is read, never changed (stepFree null stays null).
 * `canApproach` is false when the caller wired no approach screen.
 */
export function arrivalPrompt(
  door: Pick<Entrance, 'tier'>,
  profile: Profile | null | undefined,
  canApproach: boolean,
): { mode: ApproachMode | null } {
  if (!canApproach || door.tier !== 1) return { mode: null }
  // Deaf-only profiles have no approach mode of their own; the guide screen is visual too.
  return { mode: approachModeFor(profile) ?? 'guide' }
}

/**
 * Pure. How the arrival sheet behaves for an approach mode. With the guide question the
 * app waits for the user's answer: focus lands on "Ja, zeig mir den Eingang", there is no
 * auto-exit, and the spoken line ends with the question. Without it "Hier bleiben" is
 * focused and the countdown to the map runs.
 */
export function arrivalPlan(mode: ApproachMode | null): { focus: 'approach' | 'stay'; exitAfterS: number | null; nameTrigger: boolean } {
  return mode !== null
    ? { focus: 'approach', exitAfterS: null, nameTrigger: true }
    : { focus: 'stay', exitAfterS: ARRIVAL_EXIT_S, nameTrigger: false }
}

/** Arrival card strings; kept local so strings.ts stays untouched. */
const ARR = {
  de: {
    title: 'Angekommen',
    sheetTitle: 'Du bist angekommen',
    ask: 'Sollen wir dir zeigen, wo du reinkommst?',
    yes: 'Ja, zeig mir den Eingang',
    no: 'Nein, danke',
    noGuide: 'Für diesen Eingang haben wir noch keine genaue Führung.',
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
    sheetTitle: 'You have arrived',
    ask: 'Shall we show you where to get in?',
    yes: 'Yes, show me the entrance',
    no: 'No, thanks',
    noGuide: 'We have no exact guidance for this entrance yet.',
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

  // ── Live View, Google Maps calm: one arrow (or the pin), one sentence, one card ──
  // Everything mounts at once in its final place; only its text changes afterwards.
  // Fixed layout, top to bottom (also the VoiceOver order): close, sound, the instruction
  // line, the one-line status strip, the door card. The centre holds the arrow OR the pin.
  const stack = chevronStack()
  const stackG = s('g', { class: 'ar-stack-wrap' }, stack)
  const pinG = s('g', { class: 'ar-pin-wrap' }, destinationPin())
  pinG.setAttribute('transform', stackTransform(0, 393, 760).replace(/ rotate\([^)]*\)/, ''))
  const coneG = s('g', { class: 'cone' })
  // The outer groups carry the cross-fade (CSS opacity); stackG keeps its own opacity for poor GPS.
  const svg = s('svg', { class: 'ar-svg', viewBox: '0 0 393 760', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true' },
    coneG, s('g', { class: 'ar-mark ar-mark-arrow' }, stackG), s('g', { class: 'ar-mark ar-mark-pin' }, pinG))

  const ms = (n: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, n)

  // The one instruction line ("Geradeaus · 8 m"), at the top under the bar. dirEl is its
  // text and what VoiceOver reads there; changes are spoken through announce(), not here.
  const instrGlyph = h('span', { class: 'ms ar-instr-ic', 'aria-hidden': 'true' }, 'explore')
  const dirEl = h('span', { class: 'ar-instr-t' }, t.waitingGps)
  const instrEl = h('p', { class: 'ar-instr' }, instrGlyph, dirEl)
  const setLine = (text: string, glyph: string) => {
    if (dirEl.textContent !== text) dirEl.textContent = text
    if (instrGlyph.textContent !== glyph) instrGlyph.textContent = glyph
  }

  // The door card: full name (wraps), distance, then Vorlesen and Fragen. Fragen also
  // covers "Was sehe ich?": a question about the surroundings sends a camera frame.
  const distEl = h('span', { class: 'ar-dest-m' }, '')
  const accEl = h('span', { class: 'ar-meta' }, '')
  const va = voiceAsk({
    live: true,
    ctx: () => ({
      entrance: e,
      name,
      distanceM: Number.isFinite(dist) ? dist : null,
      relDeg: heading && heading.source !== 'none' && Number.isFinite(rel) ? rel : null,
      others: null,
      instruction: dirEl.textContent || null,
      routeNote: !noRouteEl.hidden && !noRouteEl.classList.contains('is-folded') ? noRouteEl.textContent : null,
    }),
    frame: () => grabFrame(mediaEl),
    heading: () => (heading && heading.source !== 'none' ? heading.deg : null),
    // An explicit tap wants sound whatever the profile says; only "Ton aus" silences it.
    voiceOn: () => !isMuted(),
  })
  // Only when no arrival sheet can offer it (a real walk whose GPS may never reach the
  // 3 m arrival): a quiet text button inside the card. The demo and ?sim replays always
  // reach the sheet, and "Ja, zeig mir den Eingang" there is the single way in.
  const approachMode = opts.onApproach ? approachModeFor(opts.profile) : null
  const nearBtn = approachMode && !opts.sensors.replay
    ? h('button', { class: 'apr-trigger ar-near', type: 'button', hidden: true }, APPROACH_TRIGGER)
    : null
  const endRow = h('div', { class: 'ar-endrow' })
  const destStrip = h('div', { class: 'ar-dest' },
    h('div', { class: 'ar-dest-pin' }, ms('location_on'), distEl),
    h('div', { class: 'ar-dest-body' }, h('span', { class: 'ar-dest-name' }, name), accEl),
    va.el,
    va.out,
    nearBtn,
    endRow,
  )

  const stopBtn = h('button', { class: 'ar-round', type: 'button', 'aria-label': t.stop }, ms('close'))
  const muteBtn = muteButton((m) => {
    if (!m) return
    beacon?.stop()
    beaconOn = false
    try {
      speechSynthesis?.cancel()
    } catch {
      /* ignored */
    }
  }, 'ar-round ar-mute', true)

  // The status strip: one line under the instruction, never over the arrow. Route note,
  // GPS lost, the periodic safety reminder and the camera answer all take turns here.
  // The route note folds into a 44 px info button after NOTE_FOLD_MS; a tap unfolds it.
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
  const safeEl = h('p', { class: 'ar-safe', hidden: true, role: 'note' }, t.arSafeSub ?? 'Achte beim Gehen auf deine Umgebung.')
  const warnEl =
    e.warnings.length > 0
      ? h('div', { class: 'warning', role: 'note' }, ...e.warnings.map((w) => h('p', {}, h('strong', {}, `${t.warningPrefix}: `), t.warning[w] ?? w)))
      : null
  const statusEl = h('div', { class: 'ar-status' }, noRouteEl, warnEl, safeEl)

  const root = h(
    'section',
    { class: `ar${cfg.dimScreen ? ' dim' : ''}`, 'aria-labelledby': 'live-title', 'data-mark': 'none' },
    h('h1', { id: 'live-title', class: 'sr-only' }, `${t.liveTitle}: ${name}`),
    mediaEl,
    svg,
    h('div', { class: 'ar-top' }, stopBtn, muteBtn),
    instrEl,
    statusEl,
    opts.sensors.banner ? h('p', { class: 'banner sr-only' }, opts.sensors.banner) : null,
    destStrip,
  )

  mount(root)

  // ---- state ----
  let fix: Fix | null = null
  let heading: Heading | null = null
  let rel = 0
  let dist = NaN
  let arrived = false
  let spokeArrival = false
  /** The arrival sheet speaks once per arrival; walking away and back is a new arrival. */
  let spokeSheet = false
  let spokeApproach = false
  let lastHaptic = 0
  let lastWord = ''
  let calloutIdx = 0
  let nearShown = false
  let pinShown = false
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
  /** What the centre shows. One at a time; CSS cross-fades 200 ms (none with reduced motion). */
  const setMark = (m: 'arrow' | 'pin' | 'none') => {
    if (root.dataset.mark !== m) root.dataset.mark = m
  }

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

  /** scanning -> guiding, approach from APPROACH_PIN_M in. Only data-phase changes: no
   *  element appears or moves with it (the old "Bereit" badge and hint text are gone). */
  function setPhase(next: ArPhase) {
    if (next === arPhase) return
    arPhase = next === 'ready' ? 'guiding' : next
    root.dataset.phase = arPhase
  }

  /** Google re-surfaces a safety reminder every so often: here in the status strip, for a
   *  few seconds, and not while another note (route, GPS) holds the strip. The first one
   *  waits a full period, since the opening line already says it. */
  function maybeSafety(now: number) {
    if (arPhase !== 'guiding' || safeEl.hidden === false || !noRouteEl.hidden) return
    if (!lastSafe) lastSafe = now
    if (now - lastSafe < SAFE_EVERY_MS) return
    lastSafe = now
    safeEl.hidden = false
    timers.push(window.setTimeout(() => {
      safeEl.hidden = true
    }, SAFE_SHOW_MS))
  }

  /** Show or hide the panel trigger; announced once per Live View, never focus-stealing. */
  function setNear(show: boolean) {
    if (!nearBtn || show === nearShown) return
    nearShown = show
    nearBtn.hidden = !show
    if (show && !saidNear) {
      saidNear = true
      announce(t.nearTrigger(APPROACH_TRIGGER))
    }
  }

  /** Set by the arrival sheet: the mode its "Ja" opens (every profile at a tier-1 door). */
  let promptMode: ApproachMode | null = null

  /** Both triggers (panel and arrival sheet) open the approach the same way. */
  function startApproach() {
    const mode = promptMode ?? approachMode
    // Twice in a row (panel and card, or a double tap) would open two approach screens.
    if (closed || !mode || !opts.onApproach) return
    teardown() // stops the arrival card's speech, so the unlock comes after it
    // Still synchronous inside the tap: iOS only unlocks speech and audio here.
    primeSpeech()
    opts.onApproach(mode)
  }

  function arrive() {
    arrived = true
    setNear(false)
    if (cfg.haptics || cfg.beacon) vibrate(HAPTIC_ARRIVED) // one long cue; iOS gets the sound
    beacon?.stop()
    beaconOn = false
    setLine(t.arrived, 'where_to_vote')
    coneG.replaceChildren()
    setMark('pin') // until the sheet rises and takes the centre away
    root.dataset.phase = 'arrived'
    // The sheet says it, once, 1.5 s later ("Du bist angekommen" plus the question).
    announce(t.arrived)
    timers.push(window.setTimeout(showArrivalCard, ARRIVAL_CARD_DELAY_MS))
  }

  function showArrivalCard() {
    const lines: string[] = []
    const doorType = e.door ? t.door[e.door] ?? null : null
    const face = e.approachBearing !== null ? ARR.face(compassWord(e.approachBearing)) : null
    const warns = e.warnings.map((w) => t.warning[w] ?? w)
    // Google Maps style: "Du bist angekommen", then one question. Only a tier-1 door gets
    // the guide button; the question is asked for every profile there.
    promptMode = arrivalPrompt(e, opts.profile, !!opts.onApproach).mode
    const plan = arrivalPlan(promptMode)
    const secsEl = h('p', { class: 'arrival-count', hidden: plan.exitAfterS === null }, plan.exitAfterS === null ? '' : ARR.backIn(plan.exitAfterS))
    // An ordinary button: VoiceOver's own double-tap activates it; a custom double-tap
    // handler would be swallowed by VoiceOver.
    const approachBtn = promptMode ? h('button', { class: 'arrival-yes', type: 'button' }, ARR.yes) : null
    const noBtn = promptMode ? h('button', { class: 'arrival-no', type: 'button' }, ARR.no) : null
    const stayBtn = promptMode ? null : h('button', { class: 'gm-pill gm-pill-primary', type: 'button' }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'pan_tool'), ARR.stay)
    const mapBtn = promptMode ? null : h('button', { class: 'gm-pill', type: 'button' }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'map'), ARR.toMap)
    const meta = [doorType, face].filter(Boolean).join(' · ')
    const question = promptMode ? ARR.ask : ARR.noGuide
    cardEl = h(
      'div',
      { class: 'arrival-scrim' },
      h(
        'div',
        { class: 'arrival', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'arrival-title', 'aria-describedby': 'arrival-ask' },
        h('span', { class: 'arrival-handle', 'aria-hidden': 'true' }),
        h('h2', { id: 'arrival-title', class: 'arrival-title' }, ARR.sheetTitle),
        h('p', { class: 'arrival-name' }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'where_to_vote'), name),
        meta ? h('p', { class: 'arrival-door' }, meta) : null,
        ...warns.map((w) => h('p', { class: 'arrival-warn', role: 'note' }, h('strong', {}, `${t.warningPrefix}: `), w)),
        h('p', { id: 'arrival-ask', class: 'arrival-ask' }, question),
        approachBtn,
        noBtn,
        secsEl,
        mapBtn && stayBtn ? h('div', { class: 'nav-row' }, mapBtn, stayBtn) : null,
      ),
    )
    root.classList.add('is-arrived') // camera and overlay leave the screen
    root.append(cardEl)
    if (plan.focus === 'approach' && approachBtn) approachBtn.focus({ preventScroll: true })
    else stayBtn?.focus({ preventScroll: true })

    // Spoken once, when the sheet opens; nothing repeats it. Warnings and the facing line
    // were already said by the early arrival line when that one ran.
    lines.push(`${ARR.sheetTitle}. ${name}.`)
    if (doorType) lines.push(`${doorType}.`)
    if (!spokeArrival) {
      for (const w of warns) lines.push(`${t.warningPrefix}. ${w}`)
      if (face) lines.push(face)
    }
    lines.push(question)
    if (!spokeSheet && voiceOn()) speak(lines.join(' '), { interrupt: true })
    spokeSheet = true
    spokeArrival = true
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
    stayBtn?.addEventListener('click', () => {
      if (countdown) clearInterval(countdown)
      countdown = 0
      secsEl.hidden = false
      secsEl.textContent = ARR.staying
      announce(ARR.staying)
      stayBtn.remove()
    })
    mapBtn?.addEventListener('click', exit)
    noBtn?.addEventListener('click', exit)
    approachBtn?.addEventListener('click', startApproach)
  }

  function cancelArrival() {
    clearTimers()
    arrived = false
    spokeArrival = false
    history = history.slice(-1)
    cardEl?.remove()
    cardEl = null
    promptMode = null
    spokeSheet = false
    root.classList.remove('is-arrived')
    root.dataset.phase = arPhase // 'arrived' would otherwise stick and hide the guidance
    safeEl.hidden = true
    // Focus was on the card that just went away; put it somewhere a finger can find.
    va.readBtn.focus({ preventScroll: true })
    lastWord = ''
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
          setLine(D.rerouting, 'directions')
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
    const mShort = (m: number) => t.metresShort(m)
    // Good GPS needs no note; poor GPS is worth reading (fix-live.css: 16 px, 7:1).
    accEl.textContent = fix.accuracy !== null && fix.accuracy > 10 ? `± ${mShort(fix.accuracy)}` : ''
    accEl.setAttribute('aria-label', accEl.textContent ? t.accuracy(fix.accuracy!) : '')

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

    // The instruction line: the next route step while following one, else the direction
    // word, then the distance ("Geradeaus · 8 m"). GPS lost: the status strip says so and
    // the line keeps the last direction instead of claiming a stale next turn.
    const lineFor = (glyph: string, word: string) => {
      if (gpsLost) return
      if (ahead && aheadText) setLine(`${aheadText} · ${mShort(ahead.toManeuverM)}`, ahead.step ? glyph : 'location_on')
      else setLine(`${word} · ${mShort(dist)}`, glyph)
    }

    if (!hasHeading) {
      // No compass: the route still says what to do and how far away it is.
      if (!aheadText && !saidNoCompass) {
        // Without a compass and without a route there is nothing to point with: say
        // so once instead of leaving the user in silence.
        saidNoCompass = true
        if (voiceOn()) speak(t.noCompass)
        announce(t.noCompass)
      }
      const glyph = maneuverGlyph(ahead?.step?.maneuver ?? null) ?? 'straight'
      if (arPhase === 'scanning' && aheadText) setPhase('ready')
      if (aheadText) lineFor(glyph, aheadText)
      else if (!gpsLost) setLine(t.noCompass, 'explore_off')
      if (aheadText && aheadText !== lastWord && gate.allow(aheadText, now)) {
        lastWord = aheadText
        const line = `${t.inMetres(ahead!.toManeuverM)}. ${aheadText}`
        if (voiceOn()) speak(line)
        else announce(line)
      }
      // Nothing to point with: no arrow. The pin still marks the last metres.
      pinShown = centreMark(dist, pinShown) === 'pin'
      setMark(pinShown ? 'pin' : 'none')
      coneG.replaceChildren()
      beacon?.update(beaconFor(dist, 0))
    } else {
      const word = aheadText
        ? aheadText
        : cone
          ? `${t.roughly}. ${calmWord.propose(rel, now)}`
          : calmWord.propose(rel, now)
      const glyph = maneuverGlyph(ahead?.step?.maneuver ?? null) ?? turnGlyph(rel)
      // The line only claims a manoeuvre while we are actually following a route.
      // Off route it would be inventing turns, and inventing turns is the one thing
      // a blind user cannot check.
      lineFor(glyph, word)
      // Chevrons foreshorten as they swing away, the way an extruded plate would.
      // Attribute rather than CSS transform: the group lives in the SVG user space.
      stackG.setAttribute('transform', stackTransform(rel, 393, 760, pitch))
      if (cone || softHeading) {
        // Poor localisation dims the chevrons rather than hiding them: Google keeps
        // guidance on screen and softens the wording, and an empty screen tells a
        // partially-sighted user nothing at all.
        coneG.replaceChildren()
        stackG.setAttribute('opacity', '0.88')
      } else {
        coneG.replaceChildren()
        stackG.setAttribute('opacity', '1')
      }
      // The pin replaces the arrow in the last metres, in the arrow's own place and size.
      // Never both: the centre shows one thing.
      pinShown = centreMark(dist, pinShown) === 'pin'
      setMark(pinShown ? 'pin' : 'arrow')

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
    if (crossed && cfg.speak && !shouldSpeakArrival(dist)) speak(t.metres(dist), { key: distanceKey(dist) ?? undefined })

    // One-off at 10 m: he is in the vicinity of the entrance.
    if (!spokeApproach && shouldAnnounceApproach(dist)) {
      spokeApproach = true
      if ((cfg.beacon || cfg.haptics) && session.audio) playApproachChime(session.audio)
      if (voiceOn()) speak(t.approaching, { interrupt: true, key: 'arrived' })
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
  let waitTimes = 0
  const sayWait = (text: string, now: number) => {
    lastWaitSaid = now
    if (waitTimes >= WAIT_MAX_TIMES) return
    waitTimes++
    if (voiceOn()) speak(text)
    announce(text)
  }
  const gpsWatch = window.setInterval(() => {
    if (closed || hidden || arrived) return
    const now = performance.now()
    if (!lastFixAt) {
      if (now - startedAt >= GPS_LOST_MS && !lastWaitSaid) sayWait(t.waitingGps, now)
      return
    }
    if (now - lastFixAt < GPS_LOST_MS) return
    if (!gpsLost) {
      gpsLost = true
      waitTimes = 0
      noRouteEl.dataset.prev = noRouteEl.hidden ? '' : (noRouteEl.textContent ?? '')
      noRouteEl.textContent = ARR.gpsLost
      noRouteEl.hidden = false
      unfoldNote(false) // GPS lost stays open until the fix is back
      beacon?.stop()
      beaconOn = false
      sayWait(ARR.gpsLost, now)
    }
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
        waitTimes = 0
        const prev = noRouteEl.dataset.prev ?? ''
        noRouteEl.textContent = prev
        noRouteEl.hidden = !prev
        if (prev) unfoldNote(true)
        lastWord = '' // say the direction again right away
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
      if (lastFixAt) lastFixAt = performance.now() // the gap was ours, not the GPS's
      update()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  function teardown() {
    if (closed) return
    closed = true
    va.stop()
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
