// The last 10 metres: the screen. Starts where Maps says "arrived", ends at the door.
//
// Two screens behind one button (see approachPort.approachModeFor):
//   guide  camera full-bleed, renders ApproachView from the engine. No guidance logic
//          here: no angle bands, no phase decisions, no wording. Those live in core/.
//   check  one /api/door-check call, one card (Stufe / Breite / Öffnet), no loop.
//
// GPS does not participate. The compass is started with the GPS fallback switched off.

import { BeaconAudio } from '../audio'
import { apiBase } from '../config'
import { startHeading } from '../core/heading'
import type { OutputConfig } from '../core/profile'
import type { Entrance } from '../core/types'
import { announce, session, speak } from '../session'
import { lang, t } from '../strings'
import {
  engine,
  postDoorCheck,
  postDoorFix,
  type ApproachMode,
  type ApproachView,
  type DoorCheck,
  type DoorFixSource,
} from './approachPort'
import { h, mount, s } from './dom'
import { grabFrame } from './LiveView'
import './approach.css'

export const AP = {
  de: {
    title: 'Zum Eingang',
    exit: 'Beenden',
    safety: 'Ich führe dich nur zur Tür. Achte weiter selbst auf deine Umgebung.',
    fromMap: 'Richtung aus der Karte, nicht aus der Kamera.',
    stillOutside: 'Noch draußen',
    checking: 'Ich prüfe die Tür.',
    checkTitle: 'Die Tür',
    step: 'Stufe',
    width: 'Breite',
    opens: 'Öffnet',
    unclear: 'unklar',
    yes: 'ja',
    no: 'nein',
    widthCm: (cm: number) => `ca. ${cm} cm`,
    open: { automatic: 'automatisch', push: 'drücken', pull: 'ziehen', revolving: 'Drehtür', unclear: 'unklar' },
    offline: 'Die Prüfung ist gerade nicht erreichbar.',
    noCamera: 'Kein Kamerabild.',
  },
  en: {
    title: 'To the entrance',
    exit: 'Stop',
    safety: 'I only guide you to the door. Keep paying attention to your surroundings.',
    fromMap: 'Direction from the map, not the camera.',
    stillOutside: 'Still outside',
    checking: 'Checking the door.',
    checkTitle: 'The door',
    step: 'Step',
    width: 'Width',
    opens: 'Opens',
    unclear: 'unclear',
    yes: 'yes',
    no: 'no',
    widthCm: (cm: number) => `about ${cm} cm`,
    open: { automatic: 'automatic', push: 'push', pull: 'pull', revolving: 'revolving door', unclear: 'unclear' },
    offline: 'The check is not available right now.',
    noCamera: 'No camera picture.',
  },
}[lang === 'de' ? 'de' : 'en']

/**
 * Pure. Decides WHAT TO SAY ALOUD from the engine's views, never what the words are:
 * the safety line exactly once, at mode start, then each instruction only when it
 * changes, plus the source note when the direction starts coming from the map.
 */
export class Narrator {
  private started = false
  private lastInstruction = ''
  private lastSource: DoorFixSource | null = null

  next(v: ApproachView): string[] {
    const out: string[] = []
    if (!this.started) {
      this.started = true
      out.push(AP.safety)
    }
    if (v.source === 'osm-fallback' && this.lastSource !== 'osm-fallback') out.push(AP.fromMap)
    this.lastSource = v.source
    if (v.instruction && v.instruction !== this.lastInstruction) out.push(v.instruction)
    this.lastInstruction = v.instruction
    return out
  }
}

/** Card rows for a verdict. 'unclear' everywhere the model was not sure. */
export function checkRows(c: DoorCheck): [string, string][] {
  const step = c.step === 'yes' ? AP.yes : c.step === 'no' ? AP.no : AP.unclear
  // Round to 5 cm: the model estimates from a picture, the card must not look like a tape measure.
  const width = c.widthCm === null ? AP.unclear : AP.widthCm(Math.round(c.widthCm / 5) * 5)
  return [
    [AP.step, step],
    [AP.width, width],
    [AP.opens, AP.open[c.opens]],
  ]
}

function cameraEl(): HTMLVideoElement {
  const v = h('video', { class: 'apr-cam', playsinline: true, muted: true, autoplay: true, 'aria-hidden': 'true' }) as HTMLVideoElement
  v.muted = true
  const attach = (st: MediaStream) => {
    v.srcObject = st
    void v.play().catch(() => {})
  }
  if (session.stream) attach(session.stream)
  else if (navigator.mediaDevices?.getUserMedia) {
    // Opened without the Start screen (e.g. ?approach=demo): ask for the camera only.
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((st) => {
        session.stream = st
        attach(st)
      })
      .catch(() => {})
  }
  return v
}

/** Resolve with a frame as soon as the video has one, or null after `ms`. */
function frameWhenReady(v: HTMLVideoElement, ms = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const poll = () => {
      const f = v.videoWidth ? grabFrame(v) : null
      if (f || performance.now() - t0 > ms) resolve(f)
      else window.setTimeout(poll, 150)
    }
    poll()
  })
}

function bigArrow(): SVGSVGElement {
  return s(
    'svg',
    { class: 'apr-arrow', viewBox: '-50 -50 100 100', 'aria-hidden': 'true' },
    s('path', { d: 'M0 -40 L30 -4 L11 -4 L11 38 L-11 38 L-11 -4 L-30 -4 Z', 'stroke-linejoin': 'round' }),
  )
}

export function Approach(opts: { door: Entrance; mode: ApproachMode; config: OutputConfig; onExit: () => void }): () => void {
  return opts.mode === 'check' ? DoorCheckScreen(opts) : GuideScreen(opts)
}

function shell(title: string, onExit: () => void) {
  const cam = cameraEl()
  const exitBtn = h('button', { class: 'apr-exit', type: 'button', 'aria-label': AP.exit }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'close'))
  exitBtn.addEventListener('click', onExit)
  const root = h('section', { class: 'apr', 'aria-labelledby': 'apr-title' }, h('h1', { id: 'apr-title', class: 'sr-only' }, title), cam, exitBtn)
  return { root, cam }
}

function GuideScreen(opts: { door: Entrance; config: OutputConfig; onExit: () => void }): () => void {
  const name = opts.door.name ?? t.unnamedEntrance
  const { root, cam } = shell(`${AP.title}: ${name}`, () => exit())
  root.classList.add('apr-guide')

  const arrow = bigArrow()
  const angleEl = h('span', { class: 'apr-angle' }, '')
  const distEl = h('p', { class: 'apr-dist' }, '')
  const instrEl = h('p', { class: 'apr-instr' }, '')
  const srcEl = h('p', { class: 'apr-src', hidden: true }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'map'), AP.fromMap)
  const outsideBtn = h('button', { class: 'apr-big', type: 'button', hidden: true }, AP.stillOutside)
  const dirEl = h('div', { class: 'apr-dir' }, arrow, angleEl)
  root.append(h('div', { class: 'apr-panel' }, dirEl, distEl, instrEl, srcEl, outsideBtn))
  mount(root)

  const narrator = new Narrator()
  const beacon = opts.config.beacon && session.audio ? new BeaconAudio(session.audio) : null
  let beaconOn = false

  const render = (v: ApproachView) => {
    root.dataset.phase = v.phase
    root.classList.toggle('apr-unsure', v.unsure)
    // Draw exactly the numbers the engine returns; rounding is display, not guidance.
    dirEl.hidden = v.relBearingDeg === null
    if (v.relBearingDeg !== null) {
      arrow.style.transform = `rotate(${v.relBearingDeg.toFixed(1)}deg)`
      angleEl.textContent = `${Math.abs(Math.round(v.relBearingDeg))}°`
    }
    distEl.textContent = v.distanceM === null ? '' : t.metres(v.distanceM)
    instrEl.textContent = v.instruction
    srcEl.hidden = v.source !== 'osm-fallback'
    outsideBtn.hidden = v.phase !== 'through'

    const lines = narrator.next(v)
    if (lines.length) {
      // Speech AND the live region, so VoiceOver gets it even with speech off. One call
      // each: announce() replaces the region, so separate calls would drop all but the last.
      // Only the opening (with the safety line) cuts off what the arrival card was saying.
      const text = lines.join(' ')
      speak(text, { interrupt: lines[0] === AP.safety })
      announce(text)
    }

    if (beacon) {
      if (v.beaconPitch === undefined) {
        if (beaconOn) beacon.stop()
        beaconOn = false
      } else {
        if (!beaconOn) beacon.start()
        beaconOn = true
        beacon.update({ pitchHz: v.beaconPitch, pulseHz: 4, panLR: 0, volume: 0.3 })
      }
    }
  }

  const stopHeading: (() => void)[] = []
  const run = engine()({
    door: opts.door,
    frame: () => grabFrame(cam),
    onHeading: (cb) => {
      const stop = startHeading((hd) => hd.source !== 'none' && cb({ deg: hd.deg, accuracy: hd.accuracy }), { gpsCourse: false })
      stopHeading.push(stop)
      return stop
    },
    onMotion: (cb) => {
      const on = (e: Event) => cb(e as DeviceMotionEvent)
      window.addEventListener('devicemotion', on)
      return () => window.removeEventListener('devicemotion', on)
    },
    doorFix: postDoorFix,
    apiBase: apiBase(),
  })
  const unsubscribe = run.subscribe(render)
  outsideBtn.addEventListener('click', () => run.stillOutside())

  let done = false
  function teardown() {
    if (done) return
    done = true
    unsubscribe()
    run.stop()
    stopHeading.forEach((f) => f())
    beacon?.stop()
    try {
      speechSynthesis?.cancel()
    } catch {
      /* ignored */
    }
  }
  function exit() {
    teardown()
    opts.onExit()
  }
  return teardown
}

function DoorCheckScreen(opts: { door: Entrance; config: OutputConfig; onExit: () => void }): () => void {
  const name = opts.door.name ?? t.unnamedEntrance
  const { root, cam } = shell(`${AP.checkTitle}: ${name}`, () => exit())
  root.classList.add('apr-check')
  const status = h('p', { class: 'apr-status', role: 'status' }, AP.checking)
  const card = h('div', { class: 'apr-card', hidden: true })
  root.append(h('div', { class: 'apr-panel' }, status, card))
  mount(root)
  announce(AP.checking)

  let closed = false
  // Exactly one request per screen. No retry loop, no beacon, no turn-by-turn.
  void frameWhenReady(cam).then(async (frame) => {
    const { check, reachable } = await postDoorCheck(frame)
    if (closed) return
    const rows = checkRows(check)
    card.replaceChildren(
      h('h2', { class: 'apr-card-title' }, AP.checkTitle),
      h('dl', { class: 'apr-rows' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: v === AP.unclear ? 'is-unclear' : '' }, v)])),
    )
    card.hidden = false
    const note = !frame ? AP.noCamera : !reachable ? AP.offline : ''
    status.textContent = note
    status.hidden = !note
    const spoken = [...rows.map(([k, v]) => `${k}: ${v}.`), note].filter(Boolean).join(' ')
    if (opts.config.speak) speak(spoken, { interrupt: true })
    announce(spoken)
  })

  function teardown() {
    closed = true
    try {
      speechSynthesis?.cancel()
    } catch {
      /* ignored */
    }
  }
  function exit() {
    teardown()
    opts.onExit()
  }
  return teardown
}
