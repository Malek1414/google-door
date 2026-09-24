import './style.css'
import { outputFor, type Profile } from './core/profile'
import { arrowTargetFor, type ArrowTarget } from './core/target'
import { readParams } from './config'
import { findEntrance } from './data'
import { loadProfile, output, session } from './session'
import { demoWalkTrack, loadTrack, Recorder, replaySensors, type TrackPoint } from './sim/replay'
import { t } from './strings'
import { h, mount } from './ui/dom'
import { LiveView, realSensors, applyContrast } from './ui/LiveView'
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
import './ui/fix-nav.css'

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

function showLive(target: ArrowTarget, p: Profile, name?: string) {
  if (params.demo) return showDemoLive(target, p, name, demoWalkTrack(target.entrance))
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
