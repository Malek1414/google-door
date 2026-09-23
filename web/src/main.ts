import './style.css'
import { outputFor, type Profile } from './core/profile'
import { arrowTargetFor, type ArrowTarget } from './core/target'
import { readParams } from './config'
import { findEntrance } from './data'
import { loadProfile, output, session } from './session'
import { loadTrack, Recorder, replaySensors } from './sim/replay'
import { t } from './strings'
import { h, mount } from './ui/dom'
import { LiveView, realSensors, applyContrast } from './ui/LiveView'
import { MapView } from './ui/MapView'
import { Onboard } from './ui/Onboard'
import { Start } from './ui/Start'

// Fail-safe: an error in one feature must never leave a blank screen on stage.
// Log it and show a short note; the current screen stays usable.
function softFail(err: unknown) {
  console.error('[doorway]', err)
  const el = document.getElementById('live')
  if (el) el.textContent = String((err as Error)?.message ?? err).slice(0, 140)
}
window.addEventListener('error', (ev) => softFail(ev.error ?? ev.message))
window.addEventListener('unhandledrejection', (ev) => softFail(ev.reason))

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
    onGuide: (target) => showLive(target, p),
    onSettings: () => Onboard({ initial: p, onDone: showMap }),
    onContribute: () => Recorder({ onBack: () => showMap(p) }),
  })
}

function showLive(target: ArrowTarget, p: Profile) {
  LiveView({ target, sensors: realSensors(), config: outputFor(p), onExit: () => showMap(p) })
}

async function startSim(p: Profile) {
  const [door, track] = await Promise.all([findEntrance(params.door), loadTrack(params.track)])
  if (!door) return fatal(`Simulation door ${params.door} not found in data.`)
  const target = arrowTargetFor(door, p)
  // The safety gate applies in simulation too: no arrow for a door that may not carry one.
  if (!target) return fatal(`Simulation door ${params.door} cannot carry an arrow for this profile (tier ${door.tier}, stepFree ${String(door.stepFree)}).`)
  const run = () =>
    LiveView({
      target,
      sensors: replaySensors(track, { speed: params.speed, imageUrl: `${import.meta.env.BASE_URL}sim/placeholder-facade.svg`, label: `${t.simBanner} ${params.track}` }),
      config: output(),
      onExit: () => showMap(p),
      onReplay: run,
    })
  run()
}

if (params.record) {
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
