// Barrierefrei-Modus toggle: a chip at the start of the chip row and a settings row
// with a Material switch for the avatar menu. Styles in modeswitch.css.

import type { Mode } from '../core/mode'
import { lang } from '../strings'
import { h } from './dom'
import './modeswitch.css'

const S = {
  de: { chip: 'Barrierefrei', row: 'Barrierefrei-Modus', hint: 'Stufenlose Eingänge, Türen auf der Karte und Tonsignal' },
  en: { chip: 'Accessible', row: 'Accessibility mode', hint: 'Step-free entrances, doors on the map and audio beacon' },
}[lang]

const icon = (name: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, name)

/** Chip for the start of the chip row. aria-pressed carries the on/off state. */
export function modeSwitch(current: Mode, onChange: (m: Mode) => void): HTMLElement {
  let mode = current
  const b = h('button', { class: 'gm-chip gm-mode-chip', type: 'button', 'aria-pressed': String(mode === 'access') }, icon('accessible'), S.chip)
  b.addEventListener('click', () => {
    mode = mode === 'access' ? 'standard' : 'access'
    b.setAttribute('aria-pressed', String(mode === 'access'))
    onChange(mode)
  })
  return b
}

/** Settings row "Barrierefrei-Modus" with a Material 3 switch (role=switch). */
export function modeSheetRow(current: Mode, onChange: (m: Mode) => void): HTMLElement {
  let mode = current
  const id = `mode-row-${Math.random().toString(36).slice(2, 8)}`
  const sw = h(
    'button',
    { class: 'gm-switch', type: 'button', role: 'switch', 'aria-checked': String(mode === 'access'), 'aria-labelledby': `${id}-l`, 'aria-describedby': `${id}-d` },
    h('span', { class: 'gm-switch-thumb', 'aria-hidden': 'true' }),
  )
  const row = h(
    'div',
    { class: 'gm-mode-row' },
    icon('accessible'),
    h('div', { class: 'gm-mode-text' }, h('span', { class: 'gm-mode-label', id: `${id}-l` }, S.row), h('span', { class: 'gm-mode-hint', id: `${id}-d` }, S.hint)),
    sw,
  )
  const toggle = () => {
    mode = mode === 'access' ? 'standard' : 'access'
    sw.setAttribute('aria-checked', String(mode === 'access'))
    onChange(mode)
  }
  sw.addEventListener('click', toggle)
  // The whole row is a tap target; clicks on the switch itself are already handled.
  row.addEventListener('click', (e) => { if (!sw.contains(e.target as Node)) toggle() })
  return row
}
