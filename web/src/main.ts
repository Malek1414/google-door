import './style.css'
import { outputFor, type Profile } from './core/profile'
import { arrowTargetFor, type ArrowTarget } from './core/target'
import { apiBase, readParams } from './config'
import { setServerVoiceFirst } from './core/speech'

// One voice everywhere: if the server has ElevenLabs, every spoken line uses it.
void fetch(`${apiBase()}/api/health`)
  .then((r) => (r.ok ? r.json() : null))
  .then((j: { models?: { speakProvider?: string } } | null) => setServerVoiceFirst(j?.models?.speakProvider === 'elevenlabs'))
  .catch(() => {})
import { findEntrance } from './data'
import { announce, loadProfile, output, session, speak } from './session'
import { demoWalkTrack, loadTrack, Recorder, replaySensors, type TrackPoint } from './sim/replay'
import { t } from './strings'
import { h, mount } from './ui/dom'
import { LiveView, realSensors, applyContrast, arrivalSheet } from './ui/LiveView'
import { computeRoute, liveRouteTo, routeTo } from './ui/Directions'
import { buildPayload, nativeArAvailable, openNativeAr } from './ui/nativeAr'
import { isMuted } from './ui/voiceCalm'
import { pathDoorName } from './ui/doorName'
import type { Route } from './core/route'
import { Approach } from './ui/Approach'
import type { ApproachMode } from './ui/approachPort'
import { startDemoApproach } from './ui/approachDemo'
import type { Entrance } from './core/types'
import { MapView } from './ui/MapView'
import { Onboard } from './ui/Onboard'
import { Start } from './ui/Start'
import { startHealthBanner } from './ui/healthBanner'
// Pixel fixes measured against the Maps recording; loaded last so they win.
import './ui/fix-search.css'
import './ui/fix-sheet.css'
import './ui/fix-card.css'
import './ui/fix-buttons.css'
import './ui/fix-live.css'

// Fail-safe: an error in one feature must never leave a blank screen on stage.
// Log it and show a short note; the current screen stays usable.
function softFail(err: unknown) {
  console.error('[doorway]', err)
  const el = document.getElementById('live')
  if (el) el.textContent = String((err as Error)?.message ?? err).slice(0, 140)
}
window.addEventListener('error', (ev) => {
  // Errors thrown inside Google's scripts (a lazy Maps module that cannot load while
  // offline) are not ours to explain: announcing 'Could not load "poly"' through the
  // live region told a screen-reader user nothing. Log them only.
  if (ev.filename && !ev.filename.startsWith(location.origin)) return console.warn('[doorway] third-party error', ev.message)
  softFail(ev.error ?? ev.message)
})
window.addEventListener('unhandledrejection', (ev) => softFail(ev.reason))

// iOS home-screen mode with a translucent status bar: the window can end above the screen
// bottom. Measure it and, if so, paint the leftover strip in the nav colour and drop the
// nav's own home-indicator padding so bar + strip look like one Maps nav bar.
function fitStandalone() {
  try {
    const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches
    if (!standalone) return
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;top:0;visibility:hidden;padding-top:env(safe-area-inset-top)'
    document.body.append(probe)
    const top = parseFloat(getComputedStyle(probe).paddingTop) || 0
    probe.remove()
    const gap = screen.height - window.innerHeight
    document.documentElement.classList.toggle('ios-gap', top > 0 && gap > 20)
  } catch {
    /* measuring is best effort */
  }
}
fitStandalone()
window.addEventListener('resize', fitStandalone)
startHealthBanner()

const params = readParams()
session.profile = loadProfile()
if (session.profile) applyContrast(outputFor(session.profile).contrast)

function fatal(msg: string) {
  mount(h('section', { class: 'screen' }, h('h1', {}, t.appName), h('p', { role: 'alert' }, msg)))
}

function withProfile(next: (p: Profile) => void) {
  if (session.profile) next(session.profile)
  else Onboard({ onDone: next })
}

// Everyone starts on the map. Without saved settings the default profile applies (any route,
// speech and large visuals); the accessibility button top right opens the three questions.
const DEFAULT_PROFILE: Profile = { stepFreeRequired: false, channels: ['speech', 'visual'] }

function showMap(p: Profile) {
  applyContrast(outputFor(p).contrast)
  MapView({
    profile: p,
    openDoor: params.openDoor,
    onGuide: (target, name) => showLive(target, p, name),
    onSettings: () => Onboard({ initial: p, onDone: showMap }),
    onContribute: () => Recorder({ onBack: () => showMap(p) }),
  })
}

// The map navigation screen (ui/NavMode.ts). Looked up with a glob so the app still
// builds and falls back to the camera Live View while that screen does not exist.
type NavFixLike = { lat: number; lng: number }
type OpenNav = (opts: {
  route: Route
  destination: { lat: number; lng: number; name: string }
  onArrive: () => void
  onExit: () => void
  onLiveView?: () => void
  onOffRoute?: (fix: NavFixLike) => void
  onStepChange?: (text: string) => void
  parent?: HTMLElement
}) => () => void
const navModule = import.meta.glob<{ openNav: OpenNav }>('./ui/NavMode.ts')['./ui/NavMode.ts']

/** Re-route at most this often while off the route. */
const NAV_REROUTE_EVERY_MS = 20000

/**
 * Start: the map navigation along the route the preview drew, driven by the device's real
 * position. Off the route it asks for a new one from where the user is. At the door the
 * arrival sheet asks, and "Ja" opens the approach with the real engine. No route (routing
 * failed) or no nav screen: the camera Live View, as before.
 */
function showLive(target: ArrowTarget, p: Profile, name?: string) {
  if (params.demo) return showDemoLive(target, p, name, demoWalkTrack(target.entrance))
  const first = routeTo(target)
  if (!first || !navModule) return showCameraLive(target, p, name)
  const destName = name ?? pathDoorName(target.entrance)
  const cfg = outputFor(p)
  void navModule()
    .then(({ openNav }) => {
      // A host in #app replaces the map, so the screen reader does not reach it underneath.
      const host = h('section', { class: 'nav-host', 'aria-label': destName })
      mount(host)
      let closed = false
      let closeNav: () => void = () => {}
      let closeSheet: (() => void) | null = null
      let lastReroute = 0
      const leave = () => {
        if (closed) return
        closed = true
        closeSheet?.()
        closeNav()
        // A step sentence still being said must not run on into the next screen.
        try {
          window.speechSynthesis?.cancel()
        } catch {
          /* no speech engine */
        }
      }
      const open = (route: Route) => {
        closeNav = openNav({
          route,
          destination: { lat: target.lat, lng: target.lon, name: destName },
          parent: host,
          onArrive: () => {
            if (closed || closeSheet) return
            closeSheet = arrivalSheet({
              door: target.entrance,
              name: destName,
              profile: p,
              speak: cfg.speak,
              parent: host,
              onYes: (mode) => {
                leave()
                showApproach(target.entrance, p, mode)
              },
              onNo: () => {
                leave()
                showMap(p)
              },
            })
          },
          onExit: () => {
            leave()
            showMap(p)
          },
          onLiveView: () => {
            leave()
            showCameraLive(target, p, name)
          },
          // Event-only voice: a new step is said once, nothing repeats it.
          onStepChange: (text) => {
            if (closed) return
            if (cfg.speak && !isMuted()) speak(text)
            announce(text)
          },
          onOffRoute: (fix) => {
            const now = Date.now()
            if (closed || now - lastReroute < NAV_REROUTE_EVERY_MS) return
            lastReroute = now
            void computeRoute({ lat: fix.lat, lon: fix.lng }, target).then((out) => {
              if (closed || !out.ok) return
              closeNav()
              open(out.route)
            })
          },
        })
      }
      open(first)
    })
    .catch((err) => {
      console.warn('[doorway] nav screen failed, camera Live View instead', err)
      showCameraLive(target, p, name)
    })
}

/** The camera Live View with the real sensors (GPS, compass, camera). Inside the iOS app
 *  on an AR-capable phone the native ARCore Live View opens instead; when that cannot
 *  start, this web one does. */
function showCameraLive(target: ArrowTarget, p: Profile, name?: string, allowNative = true) {
  if (allowNative && showNativeLive(target, p, name)) return
  LiveView({
    target,
    ...(name ? { name } : {}),
    sensors: realSensors(),
    config: outputFor(p),
    onExit: () => showMap(p),
    profile: p,
    onApproach: (mode) => showApproach(target.entrance, p, mode),
  })
}

/**
 * The native AR Live View (ui/nativeAr.ts). False when it is not available here or has
 * no route to follow, so the caller shows the web Live View. The native screen covers
 * this page; at the door it closes and the web arrival sheet takes over, and "Ja" leads
 * into the approach engine for the last metres.
 */
function showNativeLive(target: ArrowTarget, p: Profile, name?: string): boolean {
  if (!nativeArAvailable()) return false
  const route = liveRouteTo(target)
  const destName = name ?? pathDoorName(target.entrance)
  const payload = route ? buildPayload(route, target, destName) : null
  if (!payload) return false
  // ARKit takes the camera; the page's stream would come back frozen. The approach and
  // the web Live View each ask for a fresh one.
  session.stream?.getTracks().forEach((tr) => tr.stop())
  session.stream = null
  const host = h('section', { class: 'nav-host', 'aria-label': destName })
  mount(host)
  const cfg = outputFor(p)
  const opened = openNativeAr(payload, (ev) => {
    if (ev.type === 'arrived') {
      arrivalSheet({
        door: target.entrance,
        name: destName,
        profile: p,
        speak: cfg.speak,
        parent: host,
        onYes: (mode) => showApproach(target.entrance, p, mode),
        onNo: () => showMap(p),
      })
    } else if (ev.type === 'closed') {
      showMap(p)
    } else if (ev.type === 'error') {
      console.warn('[doorway] native Live View unavailable, web Live View instead', ev.reason)
      webLiveAgain(target, p, name)
    }
  })
  if (!opened) webLiveAgain(target, p, name)
  return true
}

function webLiveAgain(target: ArrowTarget, p: Profile, name?: string) {
  void cameraAgain().then(() => showCameraLive(target, p, name, false))
}

/** A fresh camera stream after the native AR screen held the camera. */
async function cameraAgain(): Promise<void> {
  if (session.stream || !navigator.mediaDevices?.getUserMedia) return
  try {
    session.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  } catch {
    session.stream = null
  }
}

function showApproach(door: Entrance, p: Profile, mode: ApproachMode) {
  Approach({ door, mode, config: outputFor(p), onExit: () => showMap(p) })
}

/** After `through` the demo holds this long (the line is said), then the map is back. */
const DEMO_THROUGH_EXIT_MS = 4000

/**
 * ?demo=1: the whole loop in one go. A short simulated walk to the door, the arrival
 * sheet, and "Ja" opens the scripted approach (the same engine as ?approach=demo), which
 * ends at the door and returns to the map, ready for the next run.
 */
function showDemoLive(target: ArrowTarget, p: Profile, name: string | undefined, track: TrackPoint[]) {
  LiveView({
    target,
    ...(name ? { name } : {}),
    sensors: replaySensors(track, { speed: params.speed, imageUrl: `${import.meta.env.BASE_URL}sim/placeholder-facade.svg`, label: t.simBanner }),
    config: outputFor(p),
    onExit: () => showMap(p),
    profile: p,
    onApproach: () =>
      Approach({
        door: target.entrance,
        mode: 'guide',
        config: outputFor(p),
        onExit: () => showMap(p),
        start: startDemoApproach,
        exitAfterThroughMs: DEMO_THROUGH_EXIT_MS,
      }),
  })
}

/** ?approach=demo (guidance, scripted engine) or ?approach=check (wheelchair verdict), straight in. */
async function startApproachDemo(p: Profile, mode: ApproachMode) {
  const door = await findEntrance(params.door)
  if (!door) return fatal(t.doorNotFound(params.door))
  showApproach(door, p, mode)
}

async function startSim(p: Profile) {
  const [door, track] = await Promise.all([findEntrance(params.door), loadTrack(params.track)])
  if (!door) return fatal(t.doorNotFound(params.door))
  const target = arrowTargetFor(door, p)
  // The safety gate applies in simulation too: no arrow for a door that may not carry one.
  if (!target) {
    console.warn('[doorway] sim door without arrow', { door: door.id, tier: door.tier, stepFree: door.stepFree })
    return fatal(t.simNoArrow(params.door))
  }
  if (params.demo) return showDemoLive(target, p, undefined, demoWalkTrack(door))
  const run = () =>
    LiveView({
      target,
      sensors: replaySensors(track, { speed: params.speed, imageUrl: `${import.meta.env.BASE_URL}sim/placeholder-facade.svg`, label: t.simBanner }),
      config: output(),
      onExit: () => showMap(p),
      onReplay: run,
      profile: p,
      onApproach: (mode) => showApproach(target.entrance, p, mode),
    })
  run()
}

const approachParam = new URLSearchParams(location.search).get('approach')
if (approachParam === 'demo' || approachParam === 'check') {
  const p = session.profile ?? DEFAULT_PROFILE
  void startApproachDemo(p, approachParam === 'check' ? 'check' : 'guide').catch((e) => fatal(String(e)))
} else if (params.record) {
  Start({ sim: false, onDone: () => Recorder() })
} else if (params.sim) {
  Start({ sim: true, onDone: () => withProfile((p) => void startSim(p).catch((e) => fatal(String(e)))) })
} else {
  try {
    showMap(session.profile ?? DEFAULT_PROFILE)
  } catch (err) {
    softFail(err)
    fatal(String((err as Error)?.message ?? err))
  }
}
