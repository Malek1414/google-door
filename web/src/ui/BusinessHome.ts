// Top of the "Unternehmen" page, 1:1 after the Google Maps "Mein Unternehmen" screen:
// centred title with a bell, business switcher row (store circle, name, chevron menu),
// a row of round tonal action buttons and the "Leistung" section with three stat circles.
// Real local counts only, nothing is estimated. Pure view: it never writes.

import './business-home.css'
import { loadSurvey, visibilityScore, type BusinessProfile } from '../core/survey'
import { lang } from '../strings'
import type { FeatureCtx } from './ctx'
import { h } from './dom'

export interface BusinessHomeActions {
  onEdit(): void
  onEntrances(): void
  onRecord(): void
  onPhotos(): void
  onPreview(): void
  onNewBusiness(): void
  onSwitch(id: string): void
  /** Opens "Gesammelte Daten" — everything stored about this business, with export
   *  and full delete. The info button only appears when this is provided. */
  onData?(): void
}

export interface BusinessHomeOptions {
  /** Other stored businesses the owner can switch to. */
  others: { id: string; name: string }[]
  /** Labels of the open tasks, shown under the bell. */
  openTasks: string[]
}

const S = {
  de: {
    collectedData: 'Gesammelte Daten',
  title: 'Mein Unternehmen',
    bell: (n: number) => (n ? `Mitteilungen, ${n} offene Aufgaben` : 'Mitteilungen, keine offenen Aufgaben'),
    bellHead: 'Offene Aufgaben',
    bellEmpty: 'Alles erledigt. Keine offenen Aufgaben.',
    switcher: (name: string) => `${name}, Unternehmen wechseln oder bearbeiten`,
    editBiz: 'Unternehmen bearbeiten',
    newBiz: 'Neues Unternehmen',
    switchTo: (name: string) => `Zu ${name} wechseln`,
    noAddress: 'Keine Adresse angegeben',
    actionsLabel: 'Aktionen',
    edit: 'Profil bearbeiten',
    entrances: 'Eingänge',
    record: 'Weg filmen',
    photos: 'Fotos',
    preview: 'Vorschau',
    perf: 'Leistung',
    perfSub: 'Zahlen von diesem Gerät',
    statEntrances: 'Eingänge',
    statPhotos: 'mit Foto',
    profileScore: 'Profil vollständig',
    statScore: 'Vollständig',
    of: (a: number, b: number) => `${a} von ${b}`,
  },
  en: {
    collectedData: 'Collected data',
  title: 'My business',
    bell: (n: number) => (n ? `Notifications, ${n} open tasks` : 'Notifications, no open tasks'),
    bellHead: 'Open tasks',
    bellEmpty: 'All done. No open tasks.',
    switcher: (name: string) => `${name}, switch or edit business`,
    editBiz: 'Edit business',
    newBiz: 'New business',
    switchTo: (name: string) => `Switch to ${name}`,
    noAddress: 'No address given',
    actionsLabel: 'Actions',
    edit: 'Edit profile',
    entrances: 'Entrances',
    record: 'Film the way',
    photos: 'Photos',
    preview: 'Preview',
    perf: 'Performance',
    perfSub: 'Counts from this device',
    statEntrances: 'Entrances',
    statPhotos: 'with photo',
    profileScore: 'Profile complete',
    statScore: 'Complete',
    of: (a: number, b: number) => `${a} of ${b}`,
  },
}
const L = S[lang === 'en' ? 'en' : 'de']

/** Score from which the profile counts as "checked". */
export const VERIFIED_MIN_SCORE = 70

let uid = 0
const icon = (name: string, filled = false) => h('span', { class: `ms${filled ? ' ms-fill' : ''}`, 'aria-hidden': 'true' }, name)

/** Counts shown in "Leistung". All derived from local data, nothing estimated. */
export function businessHomeStats(b: BusinessProfile): { entrances: number; withPhoto: number; tasksDone: number; tasksTotal: number; score: number } {
  const survey = loadSurvey()
  const linked = survey.filter((e) => b.entranceIds.includes(e.id) || e.businessId === b.id)
  return {
    entrances: linked.length,
    withPhoto: linked.filter((e) => typeof e.photo === 'string' && e.photo.length > 0).length,
    tasksDone: b.tasks.filter((t) => t.done).length,
    tasksTotal: b.tasks.length,
    score: visibilityScore(b, survey),
  }
}

/** Disclosure popover: button toggles, Escape and outside taps close, focus returns to the button. */
function popover(btn: HTMLButtonElement, panel: HTMLElement): void {
  const outside = (ev: Event) => {
    if (!panel.contains(ev.target as Node) && !btn.contains(ev.target as Node)) close()
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      close()
      btn.focus()
    }
  }
  function close() {
    panel.hidden = true
    btn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', onKey)
  }
  btn.addEventListener('click', () => {
    if (!panel.hidden) return close()
    panel.hidden = false
    btn.setAttribute('aria-expanded', 'true')
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', onKey)
    panel.querySelector<HTMLElement>('button')?.focus()
  })
  panel.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('button')) close()
  })
}

export function businessHomeHeader(_ctx: FeatureCtx, business: BusinessProfile, actions: BusinessHomeActions, opts: BusinessHomeOptions): HTMLElement {
  const id = `bzh${++uid}`
  const stats = businessHomeStats(business)

  // ---------- top bar: centred title, bell ----------
  const bellBtn = h('button', {
    class: 'bzh-bell', type: 'button', 'aria-label': L.bell(opts.openTasks.length),
    'aria-expanded': 'false', 'aria-controls': `${id}-bell`,
  }, icon('notifications'), opts.openTasks.length ? h('span', { class: 'bzh-bell-dot', 'aria-hidden': 'true' }) : null)
  const bellPanel = h('div', { class: 'bzh-pop bzh-pop-bell', id: `${id}-bell`, hidden: true },
    h('p', { class: 'bzh-pop-head' }, L.bellHead),
    opts.openTasks.length
      ? h('ul', { class: 'bzh-pop-list' }, ...opts.openTasks.map((t) => h('li', { class: 'bzh-pop-item' }, icon('radio_button_unchecked'), h('span', {}, t))))
      : h('p', { class: 'bzh-pop-empty' }, L.bellEmpty),
  )
  popover(bellBtn, bellPanel)
  const infoBtn = actions.onData
    ? h('button', { class: 'bzh-info', type: 'button', 'aria-label': L.collectedData, onclick: () => actions.onData?.() }, icon('info'))
    : null
  const top = h('header', { class: `bzh-top${infoBtn ? ' bzh-top-info' : ''}` },
    h('h2', { id: 'sheet-title', class: 'bzh-title', tabindex: '-1' }, L.title),
    infoBtn,
    bellBtn,
    bellPanel,
  )

  // ---------- switcher row ----------
  const menuBtn = h('button', {
    class: 'bzh-switch', type: 'button', 'aria-label': L.switcher(business.name),
    'aria-expanded': 'false', 'aria-controls': `${id}-menu`,
  },
    h('span', { class: 'bzh-store', 'aria-hidden': 'true' }, icon('storefront')),
    h('span', { class: 'bzh-switch-text' },
      h('span', { class: 'bzh-name' }, business.name),
      h('span', { class: 'bzh-addr' }, business.address || L.noAddress),
    ),
    h('span', { class: 'bzh-chev', 'aria-hidden': 'true' }, icon('keyboard_arrow_down')),
  )
  const menuItem = (name: string, label: string, onclick: () => void, aria?: string) =>
    h('li', {}, h('button', { class: 'bzh-pop-btn', type: 'button', onclick, 'aria-label': aria }, icon(name), h('span', {}, label)))
  const menu = h('div', { class: 'bzh-pop bzh-pop-menu', id: `${id}-menu`, hidden: true },
    h('ul', { class: 'bzh-pop-list' },
      ...opts.others.map((o) => menuItem('storefront', o.name, () => actions.onSwitch(o.id), L.switchTo(o.name))),
      menuItem('edit', L.editBiz, actions.onEdit),
      menuItem('add', L.newBiz, actions.onNewBusiness),
    ),
  )
  popover(menuBtn, menu)
  const switcher = h('div', { class: 'bzh-switcher' }, menuBtn, menu)

  // ---------- round tonal action buttons ----------
  const action = (name: string, label: string, onclick: () => void) =>
    h('li', { class: 'bzh-action' },
      h('button', { class: 'bzh-action-btn', type: 'button', onclick },
        h('span', { class: 'bzh-action-circle', 'aria-hidden': 'true' }, icon(name)),
        h('span', { class: 'bzh-action-label' }, label),
      ),
    )
  const row = h('ul', { class: 'bzh-actions', 'aria-label': L.actionsLabel },
    action('edit', L.edit, actions.onEdit),
    action('door_front', L.entrances, actions.onEntrances),
    action('videocam', L.record, actions.onRecord),
    action('photo_camera', L.photos, actions.onPhotos),
    action('visibility', L.preview, actions.onPreview),
  )

  // ---------- "Leistung": three stat circles ----------
  const stat = (label: string, value: string, aria: string, extra = '', style = '') =>
    h('li', { class: `bzh-stat${extra}` },
      h('span', { class: 'bzh-stat-circle', style, 'aria-hidden': 'true' }, h('span', { class: 'bzh-stat-value' }, value)),
      h('span', { class: 'bzh-stat-label', 'aria-hidden': 'true' }, label),
      h('span', { class: 'sr-only bzh-sr' }, aria),
    )
  const perf = h('section', { class: 'bzh-sec', 'aria-labelledby': `${id}-perf` },
    h('h3', { class: 'bzh-h3', id: `${id}-perf` }, L.perf),
    h('p', { class: 'bzh-sub' }, L.perfSub),
    h('ul', { class: 'bzh-stats' },
      stat(L.statEntrances, String(stats.entrances), `${L.statEntrances}: ${stats.entrances}`),
      stat(L.statPhotos, String(stats.withPhoto), `${L.statPhotos}: ${L.of(stats.withPhoto, stats.entrances)}`),
      stat(L.statScore, String(stats.score), `${L.profileScore}: ${L.of(stats.score, 100)}`, ' bzh-stat-score', `--p:${stats.score}`),
    ),
  )

  return h('div', { class: 'bzh' }, top, switcher, h('div', { class: 'bzh-divider', 'aria-hidden': 'true' }), row, h('div', { class: 'bzh-divider', 'aria-hidden': 'true' }), perf)
}
