// Approach voice: pre-synthesised clips first, /api/speak only for what has no clip. (Q9)
//
// The TTS tier allows 100 requests a day and one approach speaks a dozen lines, so a
// line that has a clip must never reach the network. A missing clip is silent-but-safe:
// the line is spoken live instead, it just costs one request.
//
// The engine hands the screen one joined instruction ("Ich sehe den Eingang nicht. ...
// Links 5 Meter"). splitInstruction() takes it apart into the lines it was built from,
// using the same wording functions the engine used, so every part gets its own clip key.
//
// Lines queue: the next one starts when the previous one has finished. Only an
// interrupting line (the safety line) cuts off what is playing and drops the queue.

import { approachClipBank, bandClipKey, bandText, clipKeyFor, type Band } from '../core/instruct'
import { session, speak } from '../session'

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

/** Band and metres lines: only the newest one is worth saying. */
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
  /** Play the clip to the end. Resolves false when no clip exists for the key. */
  playClip(key: string): Promise<boolean>
  /** Speak live (/api/speak, then speechSynthesis). Resolves when it is roughly done. */
  speakLive(text: string): Promise<void>
  /** Cut off whatever is sounding now. */
  stop(): void
}

export class ClipPlayer {
  private queue: SpokenPart[] = []
  private running = false
  private gen = 0

  constructor(private readonly deps: ClipDeps) {}

  /** Queue a line. `interrupt` drops the queue and cuts off the current line first. Never throws. */
  playLine(text: string, key: string | null, opts: { interrupt?: boolean } = {}): Promise<void> {
    if (opts.interrupt) this.stop()
    this.queue.push({ text, key })
    return this.drain()
  }

  /** Queue every part of a joined engine instruction, in order. */
  playInstruction(text: string, lang: string, opts: { interrupt?: boolean } = {}): Promise<void> {
    const parts = splitInstruction(text, lang)
    if (opts.interrupt) this.stop()
    // A direction or a distance still waiting in the queue is stale once a newer view
    // arrives: "Links" after the user already turned sends them the wrong way. One-off
    // lines (unsure, map, through) stay; so does the line playing now. A pending copy
    // of a line that is queued again is dropped too.
    this.queue = this.queue.filter((q) => !isTransient(q, lang) && !parts.some((p) => p.text === q.text))
    this.queue.push(...parts)
    return this.drain()
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

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    const gen = this.gen
    while (this.queue.length && gen === this.gen) {
      const part = this.queue.shift()!
      let played = false
      if (part.key) {
        try {
          played = await this.deps.playClip(part.key)
        } catch {
          played = false
        }
      }
      if (gen !== this.gen) return
      if (!played) {
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
const buffers = new Map<string, AudioBuffer>()
let current: AudioBufferSourceNode | null = null

function manifestFor(lang: string): Promise<Manifest | null> {
  const l = lang.startsWith('de') ? 'de' : 'en'
  let m = manifests.get(l)
  if (!m) {
    m = fetch(`${BASE}audio/manifest.${l}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
      .catch(() => null)
    manifests.set(l, m)
  }
  return m
}

function browserDeps(lang: string): ClipDeps {
  return {
    async playClip(key) {
      const ctx = session.audio
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
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      current = src
      await new Promise<void>((done) => {
        // onended can go missing on a suspended context; never wait longer than the clip.
        const t = setTimeout(done, buf!.duration * 1000 + 500)
        src.onended = () => {
          clearTimeout(t)
          done()
        }
        src.start()
      })
      if (current === src) current = null
      return true
    },
    async speakLive(text) {
      speak(text)
      // speak() does not report the end; hold the queue for roughly the spoken length.
      await new Promise((r) => setTimeout(r, Math.min(8000, 600 + text.length * 65)))
    },
    stop() {
      try {
        current?.stop()
      } catch {
        /* already ended */
      }
      current = null
      try {
        speechSynthesis?.cancel()
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
export function playLine(line: string, key: string | null, opts: { interrupt?: boolean; lang: string }): void {
  void player(opts.lang).playLine(line, key, opts).catch(() => {})
}

/** Speak an engine instruction part by part, each with its own clip key. */
export function playInstruction(text: string, opts: { interrupt?: boolean; lang: string }): void {
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
    if (missing.length) console.info(`[clips] ${lang}: ${missing.length} approach clips not synthesised yet (spoken via /api/speak):`, missing.join(', '))
  })
}
