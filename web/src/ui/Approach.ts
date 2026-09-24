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
import { metresLine, safetyLine } from '../core/instruct'
import type { OutputConfig } from '../core/profile'
import type { Entrance } from '../core/types'
import { announce, keepScreenOn, session } from '../session'
import { lang, t } from '../strings'
import { engine, type ApproachMode, type ApproachView } from './approachPort'
import { playInstruction, playLine, preloadClips, reportMissingClips, stopLines } from './clips'
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
    aim: 'Kamera auf die Tür halten.',
    recheck: 'Nochmal prüfen',
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
    aim: 'Hold the camera on the door.',
    recheck: 'Check again',
    checkTitle: 'The door',
    offline: 'The check is not available right now.',
    noCamera: 'No camera picture.',
  },
}[lang === 'de' ? 'de' : 'en']

/**
 * Pure. Decides WHEN to speak, never what: the engine's instruction is spoken verbatim
 * each time it changes. The engine already opens with the safety line and names the
 * map fallback (core/instruct.ts), so nothing is added here. Nothing interrupts the
 * first line (see next()); only a later safety line may cut off what was playing; the parts of a joined "Links 5 Meter"
 * play in order, and a newer line replaces a stale one that has not started (ui/clips.ts).
 */
export class Narrator {
  private lastInstruction = ''
  private hadAim = false
  private lostAim = false
  private spoke = false

  constructor(private readonly language: string = lang) {}

  next(v: ApproachView): { text: string; interrupt: boolean } | null {
    // Lost fix: the engine keeps the old words on screen and says the band again once a
    // fix is back, often the very same "Links". Dedupe on text would swallow it, so the
    // first view with a direction after a stretch without one always speaks.
    const aim = v.relBearingDeg !== null
    if (aim && this.lostAim) this.lastInstruction = ''
    this.lostAim = aim ? false : this.lostAim || this.hadAim
    this.hadAim = aim
    if (!v.instruction || v.instruction === this.lastInstruction) return null
    this.lastInstruction = v.instruction
    // The first line never interrupts: there is nothing of the approach to cut off, and
    // on iOS the cancel() it would trigger swallows the utterance spoken right after it
    // (the tap's speech primer is still pending then). The arrival card is stopped by
    // Live View's teardown instead.
    const first = !this.spoke
    this.spoke = true
    return { text: v.instruction, interrupt: !first && v.instruction.startsWith(safetyLine(this.language)) }
  }

  /** After "Noch draußen": the engine's next line is spoken even if it repeats an earlier one. */
  reset(): void {
    this.lastInstruction = ''
    this.lostAim = false
  }
}

/**
 * Pure. What the guide screen shows for a view: no decisions of its own, only which
 * parts of the engine's view are drawn. The arrow exists only while the engine has a
 * bearing; with none (vision lost, no surveyed bearing) there is no fake arrow, just the
 * engine's words. "Noch draußen" exists only in `through`.
 */
export function guideLayout(v: ApproachView, language: string = lang) {
  return {
    arrow: v.relBearingDeg !== null,
    noDirection: v.relBearingDeg === null && v.source === null,
    outsideButton: v.phase === 'through',
    fromMap: v.source === 'osm-fallback',
    distance: v.distanceM === null ? '' : metresLine(v.distanceM, language),
    // The big distance line already says the metres; the words under it drop a repeat of it.
    instruction: withoutMetres(v.instruction, v.distanceM === null ? '' : metresLine(v.distanceM, language)),
    // The disclaimer stays readable for the whole approach, except while it IS the instruction.
    safety: !v.instruction.startsWith(safetyLine(language)),
  }
}

function withoutMetres(instruction: string, metres: string): string {
  if (!metres) return instruction
  if (instruction === metres) return ''
  return instruction.endsWith(` ${metres}`) ? instruction.slice(0, -metres.length - 1) : instruction
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
  // The phone is held up for the whole approach: the screen must not lock under it.
  const releaseScreen = keepScreenOn()
  let released = false
  const release = () => {
    if (released) return
    released = true
    releaseScreen()
  }
  const onExit = () => {
    release()
    opts.onExit()
  }
  const teardown = opts.mode === 'check' ? DoorCheckScreen({ ...opts, onExit }) : GuideScreen({ ...opts, onExit })
  return () => {
    release()
    teardown()
  }
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
  // Distance and direction are already spoken via #live; a bare "64°" adds nothing.
  const angleEl = h('span', { class: 'apr-angle', 'aria-hidden': 'true' }, '')
  const distEl = h('p', { class: 'apr-dist' }, '')
  const instrEl = h('p', { class: 'apr-instr' }, '')
  const srcEl = h('p', { class: 'apr-src', hidden: true }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'map'), AP.fromMap)
  const outsideBtn = h('button', { class: 'apr-big apr-outside', type: 'button', hidden: true }, AP.stillOutside)
  const safetyEl = h('p', { class: 'apr-safety', hidden: true }, safetyLine(lang))
  const dirEl = h('div', { class: 'apr-dir' }, arrow, angleEl)
  root.append(h('div', { class: 'apr-panel' }, dirEl, distEl, instrEl, srcEl, outsideBtn, safetyEl))
  mount(root)

  const narrator = new Narrator()
  preloadClips(lang)
  reportMissingClips(lang)
  const beacon = opts.config.beacon && session.audio ? new BeaconAudio(session.audio) : null
  let beaconOn = false

  const render = (v: ApproachView) => {
    const lay = guideLayout(v)
    const enteringThrough = lay.outsideButton && outsideBtn.hidden
    root.dataset.phase = v.phase
    root.classList.toggle('apr-unsure', v.unsure)
    root.classList.toggle('apr-nodir', lay.noDirection)
    // Draw exactly the numbers the engine returns; rounding is display, not guidance.
    dirEl.hidden = !lay.arrow
    if (v.relBearingDeg !== null) {
      arrow.style.transform = `rotate(${v.relBearingDeg.toFixed(1)}deg)`
      angleEl.textContent = `${Math.abs(Math.round(v.relBearingDeg))}°`
    } else {
      angleEl.textContent = ''
    }
    distEl.textContent = lay.distance
    instrEl.textContent = lay.instruction
    srcEl.hidden = !lay.fromMap
    outsideBtn.hidden = !lay.outsideButton
    safetyEl.hidden = !lay.safety
    // VoiceOver: land on the only thing there is to do in `through`.
    if (enteringThrough) outsideBtn.focus()

    const say = narrator.next(v)
    if (say) {
      // Speech AND the live region, so VoiceOver gets it even with speech off.
      // Each part of the instruction plays its pre-synthesised clip; a part with no
      // clip is spoken by the device voice, never /api/speak (Q9).
      if (opts.config.speak) playInstruction(say.text, { interrupt: say.interrupt, lang })
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
  outsideBtn.addEventListener('click', () => {
    // Hide at once so a double tap cannot fire twice; the engine's next view redraws.
    outsideBtn.hidden = true
    narrator.reset()
    run.stillOutside()
  })

  let done = false
  function teardown() {
    if (done) return
    done = true
    unsubscribe()
    run.stop()
    stopHeading.forEach((f) => f())
    beacon?.stop()
    stopLines(lang)
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

/** Time to lift the phone from the button to the door before the frame is taken. */
export const AIM_DELAY_MS = 1500

function DoorCheckScreen(opts: { door: Entrance; config: OutputConfig; onExit: () => void }): () => void {
  const name = opts.door.name ?? t.unnamedEntrance
  const { root, cam } = shell(`${AP.checkTitle}: ${name}`, () => exit())
  root.classList.add('apr-check')
  const status = h('p', { class: 'apr-status', role: 'status' }, AP.aim)
  const card = h('div', { class: 'apr-card', hidden: true })
  const again = h('button', { class: 'apr-big apr-recheck', type: 'button', hidden: true }, h('span', { class: 'ms', 'aria-hidden': 'true' }, 'refresh'), AP.recheck)
  root.append(h('div', { class: 'apr-panel' }, status, card, again))
  mount(root)

  let closed = false
  let timer = 0
  let run = 0

  // Device voice, like the guide: no /api/speak (quota, 2 s timeout, and a newer line
  // voided the pending one, so the aim prompt was often never heard). Only a line from a
  // user's tap interrupts; the rest queue behind what is sounding.
  const say = (text: string, interrupt = false) => {
    if (opts.config.speak) playLine(text, null, { interrupt, lang })
    announce(text)
  }

  // One request per tap: on open (after the aim pause) and on "Nochmal prüfen".
  // No retry loop, no beacon, no turn-by-turn.
  const check = () => {
    const mine = ++run
    status.textContent = AP.checking
    status.hidden = false
    say(AP.checking)
    let frame: string | null = null
    void runDoorCheckOnce(
      frameWhenReady(cam).then((f) => (frame = f)),
      checkDoor,
    ).then((result) => {
      if (closed || mine !== run) return
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
      again.hidden = false
      again.disabled = false
      say([...rows.map((r) => `${r.label}: ${r.value}.`), modelNote, note].filter(Boolean).join(' '))
    })
  }

  // The phone is still pointed at the button that opened this screen: ask the user to
  // aim first, and take the frame only after a pause.
  // The first prompt interrupts nothing: the tap's speech primer may still be pending,
  // and WebKit drops a line spoken right after cancel(). "Nochmal prüfen" cuts the verdict.
  const aimThenCheck = (interrupt = false) => {
    status.textContent = AP.aim
    status.hidden = false
    say(AP.aim, interrupt)
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      if (!closed) check()
    }, AIM_DELAY_MS)
  }
  again.addEventListener('click', () => {
    // Disabled, not hidden: VoiceOver focus stays on the button for the next tap.
    if (again.disabled) return
    again.disabled = true
    aimThenCheck(true)
  })
  aimThenCheck()

  function teardown() {
    closed = true
    window.clearTimeout(timer)
    // Drops the queued verdict too, so it never plays on the map after exit.
    stopLines(lang)
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
