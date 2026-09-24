import { say, stopSpeech } from './core/speech'
import { apiBase } from './config'
// Shared runtime state across screens, plus the output helpers (speech, vibration, live region).

import { playCue } from './audio'
import { outputFor, parseProfile, PROFILE_KEY, type OutputConfig, type Profile } from './core/profile'

export interface Session {
  audio: AudioContext | null
  stream: MediaStream | null
  headingGranted: boolean
  profile: Profile | null
}

export const session: Session = { audio: null, stream: null, headingGranted: false, profile: null }

export function loadProfile(): Profile | null {
  try {
    return parseProfile(localStorage.getItem(PROFILE_KEY))
  } catch {
    return null // private mode, blocked storage
  }
}

export function saveProfile(p: Profile): void {
  session.profile = p
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable: profile still lives for this session */
  }
}

export function output(): OutputConfig {
  return outputFor(session.profile ?? { stepFreeRequired: false, channels: [] })
}

/** Polite live region for status text; VoiceOver reads it without stealing focus. */
export function announce(text: string): void {
  const el = document.getElementById('live')
  if (!el) return
  el.textContent = ''
  // Next frame, so an identical repeated message is still announced.
  requestAnimationFrame(() => (el.textContent = text))
}

export function speak(text: string, opts: { interrupt?: boolean; key?: string; apiTimeoutMs?: number } = {}): void {
  // Routes through the three-tier chain (cached Gemini clip -> /api/speak ->
  // speechSynthesis). Callers keep passing text; `key` upgrades a line to its
  // pre-synthesised clip, which is the zero-latency, works-offline path.
  // Interrupt cuts off both voices: a playing clip as well as speechSynthesis.
  if (opts.interrupt) {
    stopSpeech()
    if ('speechSynthesis' in window) {
      try {
        speechSynthesis.cancel()
      } catch {
        /* ignore */
      }
    }
  }
  void say(opts.key ?? null, text, apiBase(), { apiTimeoutMs: opts.apiTimeoutMs }).then((tier) => {
    if (tier === 'failed') announce(text) // at minimum it reaches the screen reader
  })
}


/**
 * Call synchronously inside a tap that is about to start speech (the approach trigger).
 * iOS only lets speechSynthesis talk after a call made inside a user gesture, and the
 * approach's first line may come after an await; a silent utterance here unlocks it.
 * Also resumes the AudioContext for the clips.
 */
export function primeSpeech(): void {
  setPlaybackSession()
  const a = session.audio
  if (a && a.state === 'suspended') void a.resume().catch(() => {})
  try {
    if (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined') {
      const u = new SpeechSynthesisUtterance(' ')
      u.volume = 0
      speechSynthesis.speak(u)
    }
  } catch {
    /* no synth */
  }
}

/**
 * iOS 17+ Safari: play through the silent switch, like a navigation app. Unknown
 * elsewhere, hence the try.
 */
export function setPlaybackSession(): void {
  try {
    ;(navigator as unknown as { audioSession: { type: string } }).audioSession.type = 'playback'
  } catch {
    /* not supported */
  }
}

export const canVibrate = (): boolean => typeof navigator.vibrate === 'function'

/**
 * Haptic cue. Android: Vibration API. iOS has no Vibration API in ANY browser (Chrome,
 * Firefox and Edge on iOS are all WebKit), so there we play the same pattern as a sound
 * cue, panned to the side to turn, and additionally try the iOS 18 switch-control tick.
 */
export function vibrate(pattern: number[], pan = 0): void {
  if (canVibrate()) {
    try {
      navigator.vibrate(pattern)
    } catch {
      /* ignored */
    }
    return
  }
  if (session.audio) playCue(session.audio, pattern, pan)
  iosTick(pattern)
}

let tickLabel: HTMLLabelElement | null = null

/**
 * iOS 18+ Safari fires a Taptic tick when an <input type="checkbox" switch> toggles.
 * Toggling a hidden one once per pulse is the only haptic reachable from a web page on iOS.
 * Unverified on device; older iOS simply ignores it, and the sound cue carries the meaning.
 */
function iosTick(pattern: number[]): void {
  try {
    if (!tickLabel) {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.setAttribute('switch', '')
      input.id = 'haptic-switch'
      input.tabIndex = -1
      input.setAttribute('aria-hidden', 'true')
      tickLabel = document.createElement('label')
      tickLabel.htmlFor = input.id
      tickLabel.setAttribute('aria-hidden', 'true')
      tickLabel.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
      tickLabel.append(input)
      document.body.append(tickLabel)
    }
    let t = 0
    pattern.forEach((ms, i) => {
      if (i % 2 === 0) {
        // One tick per pulse, a long pulse gets a short burst of ticks.
        const ticks = Math.max(1, Math.round(ms / 150))
        for (let k = 0; k < ticks; k++) window.setTimeout(() => tickLabel?.click(), t + k * 60)
      }
      t += ms
    })
  } catch {
    /* ignored */
  }
}

/** Belt and braces: if the Start tap did not leave audio running, any later tap resumes it. */
export function resumeAudioOnTap(): void {
  const resume = () => {
    const a = session.audio
    if (a && a.state === 'suspended') void a.resume()
  }
  document.addEventListener('pointerdown', resume, { passive: true })
  document.addEventListener('keydown', resume)
}
