// Three-tier speech. Pure-ish: the only I/O is fetch and an AudioContext.
//
//   1. cached WAV   — data/audio/<lang>/<key>.wav, pre-synthesised with Gemini TTS at
//                     build time. Zero latency, works with no signal. The normal path.
//   2. POST /api/speak — only for text nobody could predict (the /api/look reply).
//   3. speechSynthesis — last resort.
//
// Why so much machinery for "say a word": a network round-trip per spoken line puts
// most of a second between "turn left" and hearing it, and goes silent the moment
// signal drops — on a street, next to a station. So nothing predictable is synthesised
// live.
//
// A blind user who hears nothing cannot tell "you are on course" from "the app died",
// so failure is reported to the caller rather than swallowed.

export type ClipKey = string

interface Manifest {
  lang: string
  clips: Record<ClipKey, { file: string; text: string }>
}

let manifest: Manifest | null = null
let ctx: AudioContext | null = null
const buffers = new Map<ClipKey, AudioBuffer>()
let base = ''

/** Call once, inside the Start tap handler, alongside the camera and compass unlock. */
export async function initSpeech(lang: string, audioCtx: AudioContext, baseUrl = ''): Promise<boolean> {
  ctx = audioCtx
  base = baseUrl
  try {
    const r = await fetch(`${baseUrl}audio/manifest.${lang}.json`)
    if (!r.ok) return false
    manifest = (await r.json()) as Manifest
    return true
  } catch {
    return false
  }
}

/** Warm the clips that the walking loop will need, so the first turn is not the slow one. */
export async function preload(keys: ClipKey[]): Promise<void> {
  await Promise.all(keys.map((k) => load(k).catch(() => null)))
}

async function load(key: ClipKey): Promise<AudioBuffer | null> {
  if (!manifest || !ctx) return null
  const hit = buffers.get(key)
  if (hit) return hit
  const entry = manifest.clips[key]
  if (!entry) return null
  const r = await fetch(`${base}${entry.file}`)
  if (!r.ok) return null
  const buf = await ctx.decodeAudioData(await r.arrayBuffer())
  buffers.set(key, buf)
  return buf
}

function play(buf: AudioBuffer): void {
  if (!ctx) return
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(ctx.destination)
  src.start()
}

/** Distances are spoken from a fixed ladder of clips; pick the nearest one we have. */
const DISTANCE_STEPS = [5, 10, 15, 20, 30, 40, 50, 75, 100]
export function distanceKey(m: number): ClipKey | null {
  if (!Number.isFinite(m)) return null
  const step = DISTANCE_STEPS.reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a))
  return Math.abs(step - m) <= 12 ? `dist_${step}` : null
}

export type SpeechTier = 'clip' | 'api' | 'synth' | 'failed'

/**
 * Say something. `key` selects a pre-synthesised clip; `text` is both the fallback
 * and what tiers 2 and 3 speak. Returns which tier actually produced sound, so the
 * caller can make a failure audible rather than leaving silence.
 */
export async function say(key: ClipKey | null, text: string, apiBase = ''): Promise<SpeechTier> {
  if (key) {
    try {
      const buf = await load(key)
      if (buf) {
        play(buf)
        return 'clip'
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const r = await fetch(`${apiBase}/api/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (r.ok && ctx) {
      const buf = await ctx.decodeAudioData(await r.arrayBuffer())
      play(buf)
      return 'api'
    }
  } catch {
    /* fall through */
  }
  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = document.documentElement.lang || 'de'
      u.rate = 1.05
      speechSynthesis.speak(u)
      return 'synth'
    }
  } catch {
    /* nothing left */
  }
  return 'failed'
}
