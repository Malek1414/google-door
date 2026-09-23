// Screen 1: ONE tap unlocks compass, camera and sound. Highest-risk code in the project.
//
// iOS needs a user gesture for DeviceOrientationEvent.requestPermission() and for
// AudioContext. Order per BRIEF-APP, each awaited:
//   1. requestHeadingPermission()   first, so it is the first await inside the gesture
//   2. getUserMedia(environment camera)
//   3. new AudioContext() + silent buffer
// If the gesture has lapsed by step 3 on some iOS version, session.resumeAudioOnTap()
// resumes the context on the next tap (the onboarding "Test it" tap covers this).

import { initSpeech, preload } from '../core/speech'
import { requestHeadingPermission } from '../core/heading'
import { unlockAudio } from '../audio'
import { resumeAudioOnTap, session, announce } from '../session'
import { t } from '../strings'
import { h, mount } from './dom'

export interface UnlockResult {
  compass: boolean
  camera: boolean
  sound: boolean
}

export async function unlockAll(opts: { camera: boolean }): Promise<UnlockResult> {
  // Sound first and synchronously: iOS only unlocks an AudioContext inside the tap, and
  // after the first await below the gesture may be gone. No await happens before
  // requestHeadingPermission(), so the compass prompt still sees the tap too.
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (Ctx) {
      session.audio ??= new Ctx()
      unlockAudio(session.audio)
    }
  } catch {
    /* no Web Audio */
  }
  const compass = await requestHeadingPermission()
  session.headingGranted = compass

  let camera = false
  if (opts.camera && navigator.mediaDevices?.getUserMedia) {
    try {
      session.stream?.getTracks().forEach((tr) => tr.stop())
      session.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      camera = true
    } catch {
      session.stream = null
    }
  }

  let sound = false
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (Ctx) {
      session.audio ??= new Ctx()
      unlockAudio(session.audio)
      if (session.audio.state === 'suspended') await session.audio.resume().catch(() => {})
      sound = session.audio.state === 'running'
    }
  } catch {
    sound = false
  }
  resumeAudioOnTap()

  // Load the Gemini TTS clip manifest on the same gesture and warm the lines the
  // walking loop will need, so the first turn is not the slow one. Failure here is
  // not fatal: say() falls through to /api/speak and then speechSynthesis.
  if (session.audio) {
    const lang = document.documentElement.lang || 'de'
    void initSpeech(lang, session.audio, import.meta.env.BASE_URL)
      .then((ok) =>
        ok
          ? preload(['turn_left', 'turn_right', 'straight', 'arrived', 'warn_revolving', 'confirmed', 'dist_10', 'dist_20', 'dist_30'])
          : undefined,
      )
      .catch(() => undefined)
  }

  return { compass, camera, sound }
}

export function Start(opts: { sim: boolean; onDone: (r: UnlockResult) => void }): void {
  const status = h('ul', { class: 'sensor-list', 'aria-label': 'Sensor status' })
  const extra = h('div', { class: 'start-extra' })
  let busy = false

  const btn = h(
    'button',
    {
      class: 'btn btn-start',
      type: 'button',
      'aria-describedby': 'start-hint',
      onclick: async () => {
        if (busy) return
        busy = true
        btn.setAttribute('aria-busy', 'true')
        announce(t.startWorking)
        // Nothing may be awaited before unlockAll: the gesture must reach requestPermission.
        const r = await unlockAll({ camera: !opts.sim })
        busy = false
        btn.removeAttribute('aria-busy')
        render(r)
      },
    },
    t.startButton,
  )

  const row = (label: string, ok: boolean, note?: string) =>
    h('li', { class: ok ? 'ok' : 'bad' }, h('span', { class: 'mark', 'aria-hidden': 'true' }, ok ? '✓' : '✕'), `${label}: ${ok ? t.on : t.off}`, note ? ` (${note})` : '')

  function render(r: UnlockResult) {
    status.replaceChildren(
      row(t.sensorCompass, r.compass || opts.sim),
      opts.sim ? row(t.sensorCamera, true, t.simCameraNote) : row(t.sensorCamera, r.camera),
      row(t.sensorSound, r.sound),
    )
    const parts: string[] = [
      `${t.sensorCompass} ${r.compass || opts.sim ? t.on : t.off}`,
      `${t.sensorCamera} ${opts.sim || r.camera ? t.on : t.off}`,
      `${t.sensorSound} ${r.sound ? t.on : t.off}`,
    ]
    extra.replaceChildren()
    if (!r.compass && !opts.sim) {
      extra.append(h('p', { class: 'safari', role: 'alert' }, h('strong', {}, t.openInSafari), h('br'), t.openInSafariWhy))
      parts.push(t.openInSafari)
    }
    extra.append(
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => opts.onDone(r) }, t.continue), h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => btn.click() }, t.tryAgain)),
    )
    announce(parts.join('. '))
    btn.hidden = true
    extra.querySelector<HTMLButtonElement>('button')?.focus()
  }

  mount(
    h(
      'section',
      { class: 'screen screen-start', 'aria-labelledby': 'start-title' },
      opts.sim ? h('p', { class: 'banner' }, t.simBanner) : null,
      h('h1', { id: 'start-title' }, t.appName),
      h('p', { class: 'lede' }, t.tagline),
      btn,
      h('p', { id: 'start-hint', class: 'hint' }, t.startHint),
      status,
      extra,
    ),
  )
}
