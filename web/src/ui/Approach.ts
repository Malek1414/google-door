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
import { beaconFor } from '../core/beacon'
import { startHeading } from '../core/heading'
import { safetyLine } from '../core/instruct'
import type { OutputConfig } from '../core/profile'
import type { Entrance } from '../core/types'
import { announce, session, speak } from '../session'
import { lang, t } from '../strings'
import { engine, type ApproachMode, type ApproachView } from './approachPort'
import { checkDoor, runDoorCheckOnce, verdictNote, verdictRows } from './doorCheck'
import { h, mount, s } from './dom'
import { grabFrame } from './LiveView'
import './approach.css'

// Screen chrome only. Everything spoken during guidance comes from the engine
// (core/instruct.ts); the verdict rows come from doorCheck.verdictRows.
export const AP = {
  de: {
    title: 'Zum Eingang',
    exit: 'Beenden',
    fromMap: 'Richtung aus der Karte, nicht aus der Kamera.',
    stillOutside: 'Noch draußen',
    checking: 'Ich prüfe die Tür.',
    checkTitle: 'Die Tür',
    offline: 'Die Prüfung ist gerade nicht erreichbar.',
    noCamera: 'Kein Kamerabild.',
  },
  en: {
    title: 'To the entrance',
    exit: 'Stop',
    fromMap: 'Direction from the map, not the camera.',
    stillOutside: 'Still outside',
    checking: 'Checking the door.',
    checkTitle: 'The door',
    offline: 'The check is not available right now.',
    noCamera: 'No camera picture.',
  },
}[lang === 'de' ? 'de' : 'en']

/**
 * Pure. Decides WHEN to speak, never what: the engine's instruction is spoken verbatim
 * each time it changes. The engine already opens with the safety line and names the
 * map fallback (core/instruct.ts), so nothing is added here. Only the safety line may
 * cut off what was playing (the arrival card); every later line queues behind the
 * previous one so a joined "Links 5 Meter" is never clipped by the next view.
 */
export class Narrator {
  private lastInstruction = ''

  constructor(private readonly language: string = lang) {}

  next(v: ApproachView): { text: string; interrupt: boolean } | null {
    if (!v.instruction || v.instruction === this.lastInstruction) return null
    this.lastInstruction = v.instruction
    return { text: v.instruction, interrupt: v.instruction.startsWith(safetyLine(this.language)) }
  }
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

    const say = narrator.next(v)
    if (say) {
      // Speech AND the live region, so VoiceOver gets it even with speech off.
      if (opts.config.speak) speak(say.text, { interrupt: say.interrupt })
      announce(say.text)
    }

    if (beacon) {
      if (v.beaconPitch === undefined || v.relBearingDeg === null) {
        if (beaconOn) beacon.stop()
        beaconOn = false
      } else {
        if (!beaconOn) beacon.start()
        beaconOn = true
        // Pitch is the engine's; pan, pulse and volume are the app's shared beacon grammar.
        beacon.update({ ...beaconFor(v.distanceM ?? Number.NaN, v.relBearingDeg), pitchHz: v.beaconPitch })
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
  let frame: string | null = null
  void runDoorCheckOnce(
    frameWhenReady(cam).then((f) => (frame = f)),
    checkDoor,
  ).then((result) => {
    if (closed) return
    const rows = verdictRows(result, lang)
    const modelNote = verdictNote(result)
    card.replaceChildren(
      h('h2', { class: 'apr-card-title' }, AP.checkTitle),
      h('dl', { class: 'apr-rows' }, ...rows.flatMap((r) => [h('dt', {}, r.label), h('dd', { class: r.unclear ? 'is-unclear' : '' }, r.value)])),
      ...(modelNote ? [h('p', { class: 'apr-note' }, modelNote)] : []),
    )
    card.hidden = false
    const note = !frame ? AP.noCamera : !result.reachable ? AP.offline : ''
    status.textContent = note
    status.hidden = !note
    const spoken = [...rows.map((r) => `${r.label}: ${r.value}.`), modelNote, note].filter(Boolean).join(' ')
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
