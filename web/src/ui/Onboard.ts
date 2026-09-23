// Screen 2: three steps. Step-free? Output channels? Test it.
// Profile persists to localStorage 'doorway.profile' (see session.saveProfile).

import { beaconFor } from '../core/beacon'
import { outputFor, type Channel, type Profile } from '../core/profile'
import { BeaconAudio } from '../audio'
import { announce, canVibrate, saveProfile, session, speak, vibrate } from '../session'
import { t } from '../strings'
import { h, mount, s } from './dom'
import { arrowShape, applyContrast } from './LiveView'

export function Onboard(opts: { initial?: Profile | null; onDone: (p: Profile) => void }): void {
  const draft: Profile = {
    stepFreeRequired: opts.initial?.stepFreeRequired ?? false,
    channels: [...(opts.initial?.channels ?? ['speech', 'visual'])],
  }

  const frame = (step: number, title: string, ...body: (Node | null)[]) =>
    mount(
      h(
        'section',
        { class: 'screen screen-onboard', 'aria-labelledby': 'ob-title' },
        h('p', { class: 'step' }, t.stepOf(step, 3)),
        h('h1', { id: 'ob-title' }, title),
        ...body,
      ),
    )

  function step1() {
    const pick = (v: boolean) => () => {
      draft.stepFreeRequired = v
      step2()
    }
    frame(
      1,
      t.onboardStepFree,
      h(
        'div',
        { class: 'choices' },
        h('button', { class: 'btn btn-big', type: 'button', onclick: pick(true) }, t.yes),
        h('button', { class: 'btn btn-big', type: 'button', onclick: pick(false) }, t.no),
      ),
    )
  }

  function step2() {
    const opt = (c: Channel, label: string) => {
      const b = h('button', { class: 'btn btn-toggle', type: 'button', 'aria-pressed': String(draft.channels.includes(c)) }, h('span', { class: 'check', 'aria-hidden': 'true' }), label)
      b.addEventListener('click', () => {
        const on = draft.channels.includes(c)
        draft.channels = on ? draft.channels.filter((x) => x !== c) : [...draft.channels, c]
        b.setAttribute('aria-pressed', String(!on))
      })
      return b
    }
    frame(
      2,
      t.onboardChannels,
      h('p', { class: 'hint' }, t.onboardChannelsHint),
      h('div', { class: 'choices', role: 'group', 'aria-label': t.onboardChannels }, opt('speech', t.chSpeech), opt('visual', t.chVisual), opt('haptic', t.chHaptic)),
      h('button', { class: 'btn', type: 'button', onclick: step3 }, t.next),
    )
  }

  function step3() {
    saveProfile(draft)
    const cfg = outputFor(draft)
    applyContrast(cfg.contrast)
    const arrow = s('g', { class: 'arrow pulse-demo' }, arrowShape())
    const svg = s('svg', { viewBox: '-50 -50 100 100', class: 'demo-arrow', 'aria-hidden': 'true' }, arrow)
    const note = h('p', { class: 'hint' }, t.onboardTestHint)
    const vibNote = canVibrate() ? null : h('p', { class: 'hint' }, t.noVibration)

    const test = async () => {
      announce(t.testPlaying)
      arrow.classList.add('pulsing')
      vibrate([200])
      if (session.audio) {
        if (session.audio.state === 'suspended') await session.audio.resume().catch(() => {})
        const b = new BeaconAudio(session.audio)
        b.start()
        const t0 = performance.now()
        await new Promise<void>((done) => {
          const tick = () => {
            const f = Math.min(1, (performance.now() - t0) / 2500)
            // Sweep left to right while closing in: exercises pan, pitch and pulse at once.
            b.update(beaconFor(40 - 36 * f, -90 + 180 * f))
            if (f < 1) requestAnimationFrame(tick)
            else done()
          }
          tick()
        })
        b.stop()
      }
      if (cfg.speak) speak(t.testDone)
      arrow.classList.remove('pulsing')
      announce(t.testDone)
    }

    frame(
      3,
      t.onboardTest,
      svg,
      note,
      vibNote,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: test }, t.onboardTest), h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => opts.onDone({ ...draft }) }, t.done)),
    )
  }

  step1()
}
