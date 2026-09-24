// Approach voice: pre-synthesised clips first, the device voice for what has no clip. (Q9)
//
// The TTS tier allows 100 requests a day, the server retries 429 for up to a minute and
// the street has patchy signal, so nothing on this path goes to /api/speak. A part with
// no clip is spoken by speechSynthesis: zero latency, offline, in the UI language.
//
// The engine hands the screen one joined instruction ("Ich sehe den Eingang nicht. ...
// Links 5 Meter"). splitInstruction() takes it apart into the lines it was built from,
// using the same wording functions the engine used, so every part gets its own clip key.
//
// Latest wins: every line gets a sequence number and nothing older than the newest line
// ever plays. The parts of one line play in order; a newer line replaces whatever is
// still waiting. Only an interrupting line (the safety line) also cuts off what is
// sounding, clip sources and speechSynthesis alike.

import { approachClipBank, bandClipKey, bandText, clipKeyFor, type Band } from '../core/instruct'
import { session } from '../session'
import { isServerVoiceFirst, stopSpeech } from '../core/speech'
import { apiBase } from '../config'

export interface SpokenPart {
  text: string
  key: string | null
}

const BANDS: Band[] = ['straight', 'slight-left', 'slight-right', 'left', 'right', 'sharp-left', 'sharp-right', 'turn-around']

/** Every line the approach can speak, with its clip key. Bank first, then the bands. */
export function knownLines(lang: string): SpokenPart[] {
  return [
    ...approachClipBank(lang),
    ...BANDS.map((band) => ({ key: bandClipKey(band), text: bandText(band, lang) })),
  ]
}

const METRES = /^(\d+) (Meter|metres?)$/

/** Band and metres lines: only the newest one is worth saying. (The player's newest-line-wins
 *  queue already drops them; this names the class of line for tests and callers.) */
export function isTransient(part: SpokenPart, lang: string): boolean {
  return METRES.test(part.text) || /^(Ein Meter|One metre)$/.test(part.text) || BANDS.some((b) => bandText(b, lang) === part.text)
}

/**
 * Split a joined instruction back into its lines. Longest known line wins at each
 * position, and only on a word boundary ("1 Meter" never matches inside "10 Meter").
 * Text that matches no known line is kept, in order, with key null.
 */
export function splitInstruction(text: string, lang: string): SpokenPart[] {
  const known = knownLines(lang).sort((a, b) => b.text.length - a.text.length)
  const out: SpokenPart[] = []
  let unknown = ''
  const flush = () => {
    const t = unknown.trim()
    if (t) {
      const m = METRES.exec(t)
      out.push({ text: t, key: m ? clipKeyFor({ kind: 'metres', m: Number(m[1]) }) : null })
    }
    unknown = ''
  }
  let rest = text.trim()
  while (rest) {
    const hit = known.find((k) => rest.startsWith(k.text) && (rest.length === k.text.length || /[\s.,!?]/.test(rest[k.text.length])))
    if (hit) {
      flush()
      out.push({ text: hit.text, key: hit.key })
      rest = rest.slice(hit.text.length).replace(/^[.,!?]?\s*/, '')
    } else {
      const sp = rest.indexOf(' ')
      unknown += (unknown ? ' ' : '') + (sp < 0 ? rest : rest.slice(0, sp))
      rest = sp < 0 ? '' : rest.slice(sp + 1).trimStart()
    }
  }
  flush()
  return out
}

/** What the player needs from the outside world; injectable so the queue is testable. */
export interface ClipDeps {
  /**
   * Synchronous: is there a clip for this key? false = known missing (speak on the device
   * at once, still inside the tap that started the approach); undefined = not known yet.
   */
  hasClip?(key: string): boolean | undefined
  /**
   * Play the clip to the end. Resolves false when no clip exists for the key. `live()`
   * turns false when a newer line took over while the clip was loading: then it must
   * not start.
   */
  playClip(key: string, live: () => boolean): Promise<boolean>
  /** Speak on the device (speechSynthesis). Resolves when it is done. */
  speakLive(text: string): Promise<void>
  /** Cut off whatever is sounding now: clip sources and speechSynthesis. */
  stop(): void
}

interface Queued extends SpokenPart {
  seq: number
}

export class ClipPlayer {
  private queue: Queued[] = []
  private running = false
  private gen = 0
  /** Sequence number of the newest line accepted. Nothing older ever plays. */
  private latest = 0

  constructor(private readonly deps: ClipDeps) {}

  /** Queue a line. `interrupt` drops the queue and cuts off the current line first. Never throws. */
  playLine(text: string, key: string | null, opts: { interrupt?: boolean; seq?: number } = {}): Promise<void> {
    return this.enqueue([{ text, key }], opts)
  }

  /** Queue every part of a joined engine instruction, in order. */
  playInstruction(text: string, lang: string, opts: { interrupt?: boolean; seq?: number } = {}): Promise<void> {
    return this.enqueue(splitInstruction(text, lang), opts)
  }

  stop(): void {
    this.gen += 1
    this.queue = []
    this.running = false
    try {
      this.deps.stop()
    } catch {
      /* silent-but-safe */
    }
  }

  /**
   * Latest wins. A line whose `seq` is not newer than one already accepted is dropped
   * (a stale direction must never play after a newer one). A new line replaces what is
   * still waiting; the part sounding now finishes unless the line interrupts.
   */
  private enqueue(parts: SpokenPart[], opts: { interrupt?: boolean; seq?: number }): Promise<void> {
    const seq = opts.seq ?? this.latest + 1
    if (seq <= this.latest) return Promise.resolve()
    this.latest = seq
    if (opts.interrupt) this.stop()
    else this.queue = []
    this.queue.push(...parts.map((p) => ({ ...p, seq })))
    return this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    const gen = this.gen
    while (this.queue.length && gen === this.gen) {
      const part = this.queue.shift()!
      const live = () => gen === this.gen && part.seq === this.latest
      if (!live()) continue
      let played = false
      // A clip known to be missing goes straight to the device voice, with no await in
      // between: the first line then still runs inside the tap (iOS speech unlock).
      if (part.key && this.deps.hasClip?.(part.key) !== false) {
        try {
          played = await this.deps.playClip(part.key, live)
        } catch {
          played = false
        }
      }
      if (gen !== this.gen) return
      if (!played && live()) {
        try {
          await this.deps.speakLive(part.text)
        } catch {
          /* nothing left to try */
        }
      }
    }
    if (gen === this.gen) this.running = false
  }
}

// ── browser wiring ──────────────────────────────────────────────────────────

interface Manifest {
  clips: Record<string, { file: string; text: string }>
}

const BASE: string = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
const manifests = new Map<string, Promise<Manifest | null>>()
const loaded = new Map<string, Manifest | null>()
const buffers = new Map<string, AudioBuffer>()
const sounding = new Set<AudioBufferSourceNode>()

const langKey = (lang: string) => (lang.startsWith('de') ? 'de' : 'en')

function manifestFor(lang: string): Promise<Manifest | null> {
  const l = langKey(lang)
  let m = manifests.get(l)
  if (!m) {
    m = fetch(`${BASE}audio/manifest.${l}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
      .catch(() => null)
      .then((v) => {
        loaded.set(l, v)
        return v
      })
    manifests.set(l, m)
  }
  return m
}

/** Fetch the clip manifest ahead of the approach, so "no clip" is known synchronously. */
export function preloadClips(lang: string): void {
  void manifestFor(lang)
}

/** BCP 47 tag for the device voice. */
export const voiceLang = (lang: string): string => (lang.startsWith('de') ? 'de-DE' : 'en-US')

/** On-device speech: no network, no quota, native queue. Resolves when it has finished. */
export function speakOnDevice(text: string, lang: string): Promise<void> {
  return new Promise((resolve) => {
    const synth = typeof speechSynthesis === 'undefined' ? null : speechSynthesis
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return resolve()
    let cap = 0
    const done = () => {
      clearTimeout(cap)
      resolve()
    }
    // onend can go missing (WebKit, a cancelled utterance); never hold the queue forever.
    cap = window.setTimeout(done, Math.min(12000, 1500 + text.length * 90))
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = voiceLang(lang)
      u.rate = 1.05
      u.onend = done
      u.onerror = done
      synth.speak(u)
    } catch {
      done()
    }
  })
}

/** The server's premium voice (ElevenLabs via /api/speak); the device voice if it fails. */
async function speakViaServer(text: string, lang: string): Promise<void> {
  const ctx = session.audio
  if (!ctx || ctx.state !== 'running') return speakOnDevice(text, lang)
  const abort = new AbortController()
  const t = setTimeout(() => abort.abort(), 4000)
  try {
    const r = await fetch(`${apiBase()}/api/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang: langKey(lang) }),
      signal: abort.signal,
    })
    if (!r.ok) return speakOnDevice(text, lang)
    const buf = await ctx.decodeAudioData(await r.arrayBuffer())
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    sounding.add(src)
    await new Promise<void>((done) => {
      const cap = setTimeout(done, buf.duration * 1000 + 500)
      src.onended = () => {
        clearTimeout(cap)
        done()
      }
      src.start()
    })
    sounding.delete(src)
  } catch {
    return speakOnDevice(text, lang)
  } finally {
    clearTimeout(t)
  }
}

function browserDeps(lang: string): ClipDeps {
  return {
    hasClip(key) {
      if (isServerVoiceFirst()) return false // one voice: the server's
      const m = loaded.get(langKey(lang))
      if (m === undefined) return undefined
      return !!m?.clips[key] && !!session.audio
    },
    async playClip(key, live) {
      const ctx = session.audio
      // A suspended or interrupted context (iOS after a call or Siri) starts a clip
      // silently and still reports it played: let the device voice say it, and wake
      // the context for the next line.
      if (ctx && ctx.state !== 'running') {
        void ctx.resume().catch(() => {})
        return false
      }
      const entry = (await manifestFor(lang))?.clips[key]
      if (!ctx || !entry) return false
      const id = `${lang}:${key}`
      let buf = buffers.get(id)
      if (!buf) {
        const r = await fetch(`${BASE}${entry.file}`)
        if (!r.ok) return false
        buf = await ctx.decodeAudioData(await r.arrayBuffer())
        buffers.set(id, buf)
      }
      // A newer line arrived while this one was loading: it must not start now.
      if (!live()) return true
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      sounding.add(src)
      await new Promise<void>((done) => {
        // onended can go missing on a suspended context; never wait longer than the clip.
        const t = setTimeout(done, buf!.duration * 1000 + 500)
        src.onended = () => {
          clearTimeout(t)
          done()
        }
        src.start()
      })
      sounding.delete(src)
      return true
    },
    // Every part without a clip is spoken on the device, never via /api/speak: that is
    // slow (the server retries 429 for up to a minute), capped at 100 a day and silent
    // without signal. (Q9 follow-up)
    speakLive: (text) => (isServerVoiceFirst() ? speakViaServer(text, lang) : speakOnDevice(text, lang)),
    stop() {
      for (const src of sounding) {
        try {
          src.stop()
        } catch {
          /* already ended */
        }
      }
      sounding.clear()
      // Also void a pending /api/speak line (arrival card): its late device-voice
      // fallback would otherwise speak over the approach.
      stopSpeech()
      try {
        // Only when something is queued: WebKit can drop an utterance spoken right after
        // a needless cancel(), and the first approach line comes straight after one.
        if (speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel()
      } catch {
        /* no synth */
      }
    },
  }
}

const players = new Map<string, ClipPlayer>()
function player(lang: string): ClipPlayer {
  let p = players.get(lang)
  if (!p) {
    p = new ClipPlayer(browserDeps(lang))
    players.set(lang, p)
  }
  return p
}

/** Speak one line: its clip if there is one, else live. Queued; never throws. */
export function playLine(line: string, key: string | null, opts: { interrupt?: boolean; seq?: number; lang: string }): void {
  void player(opts.lang).playLine(line, key, opts).catch(() => {})
}

/** Speak an engine instruction part by part, each with its own clip key. */
export function playInstruction(text: string, opts: { interrupt?: boolean; seq?: number; lang: string }): void {
  void player(opts.lang).playInstruction(text, opts.lang, opts).catch(() => {})
}

export function stopLines(lang: string): void {
  players.get(lang)?.stop()
}

/** Keys the approach can ask for that have no file in the manifest yet. */
export function missingClipKeys(lang: string, manifest: Manifest | null): string[] {
  const have = manifest?.clips ?? {}
  return [...new Set(knownLines(lang).map((l) => l.key).filter((k): k is string => k !== null))].filter((k) => !have[k])
}

let reported = false
/** Dev only, once: which clips the TTS watcher still has to generate. */
export function reportMissingClips(lang: string): void {
  if (reported || !(import.meta as { env?: { DEV?: boolean } }).env?.DEV) return
  reported = true
  void manifestFor(lang).then((m) => {
    const missing = missingClipKeys(lang, m)
    if (missing.length) console.info(`[clips] ${lang}: ${missing.length} approach clips not synthesised yet (spoken on the device):`, missing.join(', '))
  })
}
