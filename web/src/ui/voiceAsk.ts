// "Vorlesen" and "Fragen": two big, separate buttons for Live View and the door card.
//
// Vorlesen reads the current screen in one go; a second tap stops it. Fragen listens
// (SpeechRecognition, de-DE), shows the question, answers from the door data first
// (core/askLocal) and only asks the server for the rest. Without recognition it opens
// a text field. Speech only ever starts from a tap; unlock stays synchronous in it.

import { askLocal, readAloudText, REMOTE_FAILED, type AskCtx } from '../core/askLocal'
import { stopSpeech } from '../core/speech'
import { postAsk } from '../data'
import { announce, primeSpeech, speak } from '../session'
import { h } from './dom'
import './voice-ask.css'

type Rec = {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((ev: { error?: string }) => void) | null
  onend: (() => void) | null
}

function recCtor(): (new () => Rec) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

const L = {
  read: 'Vorlesen',
  readLabel: 'Alles auf dem Bildschirm vorlesen',
  stop: 'Stopp',
  stopLabel: 'Vorlesen stoppen',
  ask: 'Fragen',
  askLabel: 'Eine Frage stellen, zum Beispiel: Ist der Eingang stufenlos?',
  listening: 'Ich höre zu …',
  listeningLabel: 'Ich höre zu. Stell deine Frage.',
  typeLabel: 'Frage eintippen',
  send: 'Senden',
  thinking: 'Ich denke nach.',
  you: 'Frage',
  answer: 'Antwort',
  noHear: 'Ich habe nichts verstanden. Tipp noch einmal auf Fragen.',
}

export interface VoiceAskOpts {
  /** The screen right now: door, distance, instruction line, route note. */
  ctx: () => AskCtx
  /** Live View: true, so the instruction line is read first. */
  live: boolean
  /** Camera frame for a question about the surroundings (Live View only). */
  frame?: () => string | null
  heading?: () => number | null
  /** False when "Ton aus" is on or the profile has no speech: text still shows. */
  voiceOn: () => boolean
  /** Called before an answer is spoken, so the guidance line can step aside. */
  onSpeak?: () => void
}

export interface VoiceAsk {
  /** The two buttons (and the text field when it is open). */
  el: HTMLElement
  /** Where focus goes when a sheet over the card closes. */
  readBtn: HTMLButtonElement
  /** Question and answer, a polite live region. */
  out: HTMLElement
  stop(): void
}

export function voiceAsk(o: VoiceAskOpts): VoiceAsk {
  const ms = (n: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, n)
  const readTxt = h('span', { class: 'va-t' }, L.read)
  const readBtn = h('button', { class: 'va-btn va-read', type: 'button', 'aria-label': L.readLabel, 'aria-pressed': 'false' }, ms('volume_up'), readTxt) as HTMLButtonElement
  const askTxt = h('span', { class: 'va-t' }, L.ask)
  const askBtn = h('button', { class: 'va-btn va-ask', type: 'button', 'aria-label': L.askLabel }, ms('mic'), askTxt) as HTMLButtonElement
  const input = h('input', { class: 'va-input', type: 'text', maxlength: '300', 'aria-label': L.typeLabel, placeholder: L.typeLabel, enterkeyhint: 'send', autocomplete: 'off' }) as HTMLInputElement
  const form = h('form', { class: 'va-form', hidden: true, role: 'search', 'aria-label': L.typeLabel },
    input,
    h('button', { class: 'va-send', type: 'submit' }, ms('send'), L.send),
  ) as HTMLFormElement
  const out = h('div', { class: 'va-out', 'aria-live': 'polite' })
  const el = h('div', { class: 'va' }, h('div', { class: 'va-row' }, readBtn, askBtn), form)

  let reading = false
  let readTimer = 0
  let rec: Rec | null = null
  let gen = 0
  let gone = false

  const hush = () => {
    stopSpeech()
    try {
      speechSynthesis?.cancel()
    } catch {
      /* no synth */
    }
  }
  const setReading = (on: boolean) => {
    reading = on
    clearTimeout(readTimer)
    readBtn.setAttribute('aria-pressed', String(on))
    readBtn.setAttribute('aria-label', on ? L.stopLabel : L.readLabel)
    readTxt.textContent = on ? L.stop : L.read
    readBtn.querySelector('.ms')!.textContent = on ? 'stop' : 'volume_up'
  }
  const say = (text: string, network = false) => {
    if (!o.voiceOn()) return // the live region still carries the text
    o.onSpeak?.()
    speak(text, { interrupt: true, apiTimeoutMs: network ? 8000 : undefined })
  }

  readBtn.addEventListener('click', () => {
    if (reading) {
      hush()
      setReading(false)
      return
    }
    primeSpeech() // synchronous in the tap: iOS unlocks speech only here
    stopListening()
    const text = readAloudText(o.ctx(), { live: o.live })
    if (!o.voiceOn()) {
      announce(text)
      return
    }
    setReading(true)
    say(text)
    // No reliable end event across clip, network and device voice: estimate it.
    readTimer = window.setTimeout(() => setReading(false), 1500 + text.length * 75)
  })

  const showQA = (q: string, a: string | null) => {
    out.replaceChildren(
      h('p', { class: 'va-q' }, h('strong', {}, `${L.you}: `), q),
      h('p', { class: 'va-a' }, h('strong', {}, `${L.answer}: `), a ?? L.thinking),
    )
  }

  async function answer(question: string) {
    const q = question.trim().slice(0, 300)
    if (!q) return
    const my = ++gen
    setReading(false)
    const ctx = o.ctx()
    const res = askLocal(q, ctx)
    if (res.kind === 'local') {
      showQA(q, res.text)
      say(res.text)
      return
    }
    showQA(q, null)
    const e = ctx.entrance
    let text: string
    try {
      text = await postAsk({
        question: q,
        facts: { name: ctx.name, stepFree: e.stepFree, door: e.door, automatic: e.automatic, level: e.level, description: e.description, warnings: [...e.warnings] },
        distanceM: ctx.distanceM !== null && Number.isFinite(ctx.distanceM) ? Math.round(ctx.distanceM) : null,
        heading: o.heading?.() ?? null,
        frame: res.withFrame ? (o.frame?.() ?? null) : null,
      })
    } catch {
      text = REMOTE_FAILED
    }
    if (gone || my !== gen) return
    showQA(q, text)
    say(text, true)
  }

  function stopListening() {
    if (!rec) return
    try {
      rec.stop()
    } catch {
      /* already stopped */
    }
  }
  const setListening = (on: boolean) => {
    askBtn.classList.toggle('is-listening', on)
    askBtn.setAttribute('aria-label', on ? L.listeningLabel : L.askLabel)
    askTxt.textContent = on ? L.listening : L.ask
  }
  const openForm = () => {
    form.hidden = false
    input.focus()
  }

  askBtn.addEventListener('click', () => {
    primeSpeech() // synchronous in the tap, before any await
    if (rec) {
      stopListening()
      return
    }
    hush()
    setReading(false)
    const Ctor = recCtor()
    if (!Ctor) {
      if (form.hidden) openForm()
      else input.focus()
      return
    }
    try {
      const r = new Ctor()
      r.lang = document.documentElement.lang === 'en' ? 'en-US' : 'de-DE'
      r.interimResults = false
      r.maxAlternatives = 1
      let heard = false
      r.onresult = (ev) => {
        const q = (ev.results[0]?.[0]?.transcript ?? '').trim()
        if (!q) return
        heard = true
        void answer(q)
      }
      r.onerror = (ev) => {
        // Permission refused or no mic: typing still works.
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed' || ev.error === 'audio-capture') openForm()
      }
      r.onend = () => {
        rec = null
        setListening(false)
        if (!heard && !gone && form.hidden) announce(L.noHear)
      }
      rec = r
      r.start()
      setListening(true)
      announce(L.listeningLabel)
    } catch {
      rec = null
      setListening(false)
      openForm()
    }
  })

  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    primeSpeech()
    const q = input.value
    input.value = ''
    void answer(q)
  })

  return {
    el,
    readBtn,
    out,
    stop() {
      gone = true
      gen++
      clearTimeout(readTimer)
      stopListening()
    },
  }
}
