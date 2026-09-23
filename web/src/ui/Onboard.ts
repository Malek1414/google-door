// Accessibility settings as one Google Maps style settings page: app bar with back arrow,
// list rows (segmented Ja/Nein, switches per output channel), a Testen row. Back and Fertig save.
// Profile persists to localStorage 'doorway.profile' (see session.saveProfile).

import { beaconFor } from '../core/beacon'
import { outputFor, type Channel, type Profile } from '../core/profile'
import { BeaconAudio } from '../audio'
import { announce, canVibrate, saveProfile, session, speak, vibrate } from '../session'
import { lang, t } from '../strings'
import { h, mount, s } from './dom'
import { arrowShape, applyContrast } from './LiveView'
import './onboard.css'
import { loadMode, saveMode } from '../core/mode'
import { modeSheetRow } from './ModeSwitch'

const S =
  lang === 'de'
    ? { title: 'Barrierefreiheit', stepFree: 'Stufenlose Wege nötig', stepFreeHint: 'Routen ohne Stufen und Treppen', output: 'Ausgabe', vibration: 'Vibration und Ton', save: 'Speichern und zurück' }
    : { title: 'Accessibility', stepFree: 'Step-free routes required', stepFreeHint: 'Routes without steps or stairs', output: 'Output', vibration: 'Vibration and sound', save: 'Save and go back' }

const icon = (name: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, name)

export function Onboard(opts: { initial?: Profile | null; onDone: (p: Profile) => void }): void {
  const draft: Profile = {
    stepFreeRequired: opts.initial?.stepFreeRequired ?? false,
    channels: [...(opts.initial?.channels ?? ['speech', 'visual'])],
  }

  const commit = () => {
    saveProfile(draft)
    applyContrast(outputFor(draft).contrast)
  }
  const done = () => {
    commit()
    opts.onDone({ ...draft })
  }

  // Segmented Ja / Nein for step-free routes (radiogroup).
  function segmented(): HTMLElement {
    const btns: HTMLButtonElement[] = []
    const seg = (v: boolean, label: string) => {
      const b = h('button', { class: 'ob-seg', type: 'button', role: 'radio', 'aria-checked': String(draft.stepFreeRequired === v) }, icon('check'), label)
      b.addEventListener('click', () => {
        draft.stepFreeRequired = v
        for (const x of btns) x.setAttribute('aria-checked', String(x === b))
      })
      btns.push(b)
      return b
    }
    return h('div', { class: 'ob-segmented', role: 'radiogroup', 'aria-labelledby': 'ob-stepfree' }, seg(true, t.yes), seg(false, t.no))
  }

  // One list row per output channel; the whole row is the switch.
  function switchRow(c: Channel, ico: string, label: string, hint?: string | null): HTMLElement {
    const id = `ob-${c}`
    const b = h(
      'button',
      { class: 'ob-row ob-switch-row', type: 'button', role: 'switch', 'aria-checked': String(draft.channels.includes(c)), 'aria-labelledby': `${id}-l`, 'aria-describedby': hint ? `${id}-d` : undefined },
      icon(ico),
      h('div', { class: 'ob-row-text' }, h('span', { class: 'ob-row-title', id: `${id}-l` }, label), hint ? h('span', { class: 'ob-row-meta', id: `${id}-d` }, hint) : null),
      h('span', { class: 'ob-track', 'aria-hidden': 'true' }, h('span', { class: 'ob-thumb' })),
    )
    b.addEventListener('click', () => {
      const on = draft.channels.includes(c)
      draft.channels = on ? draft.channels.filter((x) => x !== c) : [...draft.channels, c]
      b.setAttribute('aria-checked', String(!on))
    })
    return b
  }

  // Testen: same sweep as before (pan, pitch and pulse at once), arrow pulses in the row.
  const arrow = s('g', { class: 'arrow pulse-demo' }, arrowShape())
  const svg = s('svg', { viewBox: '-50 -50 100 100', class: 'ob-demo-arrow', 'aria-hidden': 'true' }, arrow)
  let running = false
  const test = async () => {
    if (running) return
    running = true
    testRow.setAttribute('aria-busy', 'true')
    commit()
    const cfg = outputFor(draft)
    announce(t.testPlaying)
    arrow.classList.add('pulsing')
    vibrate([200])
    if (session.audio) {
      if (session.audio.state === 'suspended') await session.audio.resume().catch(() => {})
      const b = new BeaconAudio(session.audio)
      b.start()
      const t0 = performance.now()
      await new Promise<void>((finish) => {
        const tick = () => {
          const f = Math.min(1, (performance.now() - t0) / 2500)
          // Sweep left to right while closing in: exercises pan, pitch and pulse at once.
          b.update(beaconFor(40 - 36 * f, -90 + 180 * f))
          if (f < 1) requestAnimationFrame(tick)
          else finish()
        }
        tick()
      })
      b.stop()
    }
    if (cfg.speak) speak(t.testDone)
    arrow.classList.remove('pulsing')
    announce(t.testDone)
    testRow.removeAttribute('aria-busy')
    running = false
  }
  const testRow = h(
    'button',
    { class: 'ob-row', type: 'button', onclick: test, 'aria-describedby': 'ob-test-d' },
    icon('play_circle'),
    h('div', { class: 'ob-row-text' }, h('span', { class: 'ob-row-title' }, t.onboardTest), h('span', { class: 'ob-row-meta', id: 'ob-test-d' }, t.onboardTestHint)),
    svg,
  )

  mount(
    h(
      'section',
      { class: 'gm ob', 'aria-labelledby': 'ob-title' },
      h(
        'header',
        { class: 'ob-bar' },
        h('button', { class: 'ob-back', type: 'button', 'aria-label': S.save, onclick: done }, icon('arrow_back')),
        h('h1', { id: 'ob-title', class: 'ob-title' }, S.title),
      ),
      h(
        'div',
        { class: 'ob-body' },
        h(
          'div',
          { class: 'ob-row ob-row-static' },
          icon('stairs'),
          h('div', { class: 'ob-row-text' }, h('span', { class: 'ob-row-title', id: 'ob-stepfree' }, S.stepFree), h('span', { class: 'ob-row-meta' }, S.stepFreeHint), segmented()),
        ),
        h('h2', { class: 'ob-sub' }, S.output),
        h(
          'div',
          { role: 'group', 'aria-label': S.output },
          switchRow('speech', 'record_voice_over', t.chSpeech),
          switchRow('visual', 'zoom_in', t.chVisual),
          switchRow('haptic', 'vibration', S.vibration, canVibrate() ? null : t.noVibration),
        ),
        // Accessibility mode for the map (door markers, entrance cards). Off = plain Google Maps.
        h('h2', { class: 'ob-sub' }, lang === 'de' ? 'Karte' : 'Map'),
        modeSheetRow(loadMode(), (m) => saveMode(m)),
        testRow,
        h('div', { class: 'ob-actions' }, h('button', { class: 'ob-primary', type: 'button', onclick: done }, t.done)),
      ),
    ),
  )
}
