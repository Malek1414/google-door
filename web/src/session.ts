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

export function speak(text: string, opts: { interrupt?: boolean } = {}): void {
  if (!('speechSynthesis' in window)) return
  try {
    if (opts.interrupt) speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = document.documentElement.lang || 'en'
    u.rate = 1.05
    speechSynthesis.speak(u)
  } catch {
    /* speech unavailable */
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
