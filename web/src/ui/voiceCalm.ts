// The voice speaks when something changes, not all the time (Sami: "it plays all the
// time"). Two pure pieces, shared by Live View and the last 10 metres, plus the mute
// switch both screens show.

/** Minimum gap between two spoken guidance lines. */
export const MIN_GAP_MS = 10000
/** The same line is never said again within this window. */
export const NO_REPEAT_MS = 20000
/** A new turn word must hold this long before it is said. */
export const WORD_HOLD_MS = 2000
/** ... and the angle must sit this far inside the new word's range. */
export const WORD_MARGIN_DEG = 10

/**
 * Hysteresis on the turn word. `wordOf` maps a relative bearing to a word; a new word
 * is accepted only when the angle is WORD_MARGIN_DEG inside its range (half that for a
 * narrow range such as "straight ahead") and it has held for WORD_HOLD_MS.
 */
export class CalmWord {
  private word: string | null = null
  private cand: string | null = null
  private candSince = 0

  constructor(private readonly wordOf: (rel: number) => string, private readonly holdMs = WORD_HOLD_MS) {}

  propose(rel: number, nowMs: number): string {
    const w = this.wordOf(rel)
    if (this.word === null) return (this.word = w)
    if (w === this.word) {
      this.cand = null
      return this.word
    }
    const inside = (m: number) => this.wordOf(rel - m) === w && this.wordOf(rel + m) === w
    // A narrow range (straight ahead, ±8°) cannot hold a 10° margin: use 4° there.
    if (!inside(narrow(this.wordOf, rel, w) ? 4 : WORD_MARGIN_DEG)) {
      this.cand = null
      return this.word
    }
    if (this.cand !== w) {
      this.cand = w
      this.candSince = nowMs
    }
    if (nowMs - this.candSince >= this.holdMs) {
      this.word = w
      this.cand = null
    }
    return this.word
  }

  reset(): void {
    this.word = this.cand = null
  }
}

/** A word whose whole range is narrower than two margins (e.g. "ahead", ±8°). */
function narrow(wordOf: (rel: number) => string, rel: number, w: string): boolean {
  let lo = rel
  let hi = rel
  while (hi - rel < 40 && wordOf(hi + 1) === w) hi++
  while (rel - lo < 40 && wordOf(lo - 1) === w) lo--
  return hi - lo < 2 * WORD_MARGIN_DEG
}

/** Rate limit for spoken lines: a minimum gap, and no repeat of the same line. */
export class LineGate {
  private last = -Infinity
  private said = new Map<string, number>()

  constructor(private readonly minGapMs = MIN_GAP_MS, private readonly noRepeatMs = NO_REPEAT_MS) {}

  /** May `text` be spoken now? `urgent` (safety, arrival, lost signal) skips the gap, never the repeat rule. */
  allow(text: string, nowMs: number, opts: { urgent?: boolean } = {}): boolean {
    const prev = this.said.get(text)
    if (prev !== undefined && nowMs - prev < this.noRepeatMs) return false
    if (!opts.urgent && nowMs - this.last < this.minGapMs) return false
    this.last = nowMs
    this.said.set(text, nowMs)
    return true
  }

  /** The user asked for it ("Noch draußen"): the next line may repeat and skips the gap. */
  forget(): void {
    this.said.clear()
    this.last = -Infinity
  }
}

// ── mute ────────────────────────────────────────────────────────────────────

const MUTE_KEY = 'doorway.muted'
let muted: boolean | null = null

export function isMuted(): boolean {
  if (muted === null) {
    try {
      muted = localStorage.getItem(MUTE_KEY) === '1'
    } catch {
      muted = false
    }
  }
  return muted
}

export function setMuted(on: boolean): void {
  muted = on
  try {
    localStorage.setItem(MUTE_KEY, on ? '1' : '0')
  } catch {
    /* storage blocked: the switch still holds for this session */
  }
}

import { lang } from '../strings'
import { h } from './dom'

/** "Ton aus" toggle, aria-pressed = muted. Big (56 px) for one thumb. `onChange` stops what is sounding. */
export function muteButton(onChange: (muted: boolean) => void, cls = ''): HTMLButtonElement {
  const label = lang === 'de' ? 'Ton aus' : 'Sound off'
  const ic = h('span', { class: 'ms', 'aria-hidden': 'true' }, isMuted() ? 'volume_off' : 'volume_up')
  const b = h('button', { class: `mute-btn ${cls}`.trim(), type: 'button', 'aria-pressed': String(isMuted()) }, ic, h('span', { class: 'mute-t' }, label)) as HTMLButtonElement
  b.addEventListener('click', () => {
    const on = !isMuted()
    setMuted(on)
    b.setAttribute('aria-pressed', String(on))
    ic.textContent = on ? 'volume_off' : 'volume_up'
    onChange(on)
  })
  return b
}
