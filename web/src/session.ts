// Shared runtime state across screens, plus the output helpers (speech, vibration, live region).

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

/** iOS Safari has no Vibration API: this degrades to a no-op there. */
export function vibrate(pattern: number[]): void {
  if (!canVibrate()) return
  try {
    navigator.vibrate(pattern)
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
