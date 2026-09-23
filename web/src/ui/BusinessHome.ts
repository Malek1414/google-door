// Top of the "Unternehmen" page, 1:1 after the Google Maps "Mein Unternehmen" screen:
// centred title with a bell, business row (letter avatar, name, address, profile link,
// chevron menu), the "Profilstärke" card with a progress ring, a 4-column grid of round
// tonal actions with a Weniger/Mehr toggle and "Leistung" with plain numbers.
// Real local counts only, nothing is estimated. Pure view: it never writes business data.

import './business-home.css'
import { loadSurvey, visibilityScore, type BusinessProfile } from '../core/survey'
import { lang } from '../strings'
import { ACCESS_ATTRS, loadDetails } from '../core/businessDetails'
import type { FeatureCtx } from './ctx'
import { h } from './dom'

export interface BusinessHomeActions {
  onEdit(): void
  onEntrances(): void
  onRecord(): void
  onPhotos(): void
  onHours(): void
  onAccess(): void
  onPreview(): void
  /** Opens the ranking explanation (tap on "Profilstärke"). */
  onScore(): void
  onNewBusiness(): void
  onSwitch(id: string): void
  /** Opens "Gesammelte Daten". The info button and grid entry are only shown when set. */
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
    title: 'Mein Unternehmen',
    bell: (n: number) => (n ? `Mitteilungen, ${n} offene Aufgaben` : 'Mitteilungen, keine offenen Aufgaben'),
    info: 'Gesammelte Daten',
    bellHead: 'Offene Aufgaben',
    bellEmpty: 'Alles erledigt. Keine offenen Aufgaben.',
    switcher: (name: string) => `${name}, Unternehmen wechseln oder bearbeiten`,
    editBiz: 'Unternehmen bearbeiten',
    newBiz: 'Neues Unternehmen',
    switchTo: (name: string) => `Zu ${name} wechseln`,
    noAddress: 'Keine Adresse angegeben',
    verified: 'Bestätigt',
    viewProfile: 'Unternehmensprofil ansehen',
    strength: 'Profilstärke',
    strengthSub: 'So lässt sich die Punktzahl verbessern',
    strengthAria: (n: number) => `Profilstärke ${n} Prozent. So lässt sich die Punktzahl verbessern`,
    actionsLabel: 'Aktionen',
    edit: 'Profil bearbeiten',
    entrances: 'Eingänge',
    record: 'Weg filmen',
    photos: 'Foto hinzufügen',
    hours: 'Öffnungszeiten',
    access: 'Barrierefreiheit',
    preview: 'Vorschau',
    data: 'Gesammelte Daten',
    less: 'Weniger',
    more: 'Mehr',
    perf: 'Leistung',
    range: (a: string, b: string) => (a === b ? a : `Von ${a} bis ${b}`),
    statEntrances: 'Eingänge',
    statPhotos: 'mit Foto',
    statAnswered: 'Fragen beantwortet',
  },
  en: {
    title: 'My business',
    bell: (n: number) => (n ? `Notifications, ${n} open tasks` : 'Notifications, no open tasks'),
    info: 'Collected data',
    bellHead: 'Open tasks',
    bellEmpty: 'All done. No open tasks.',
    switcher: (name: string) => `${name}, switch or edit business`,
    editBiz: 'Edit business',
    newBiz: 'New business',
    switchTo: (name: string) => `Switch to ${name}`,
    noAddress: 'No address given',
    verified: 'Verified',
    viewProfile: 'View business profile',
    strength: 'Profile strength',
    strengthSub: 'How to improve the score',
    strengthAria: (n: number) => `Profile strength ${n} percent. How to improve the score`,
    actionsLabel: 'Actions',
    edit: 'Edit profile',
    entrances: 'Entrances',
    record: 'Film the way',
    photos: 'Add photo',
    hours: 'Opening hours',
    access: 'Accessibility',
    preview: 'Preview',
    data: 'Collected data',
    less: 'Less',
    more: 'More',
    perf: 'Performance',
    range: (a: string, b: string) => (a === b ? a : `From ${a} to ${b}`),
    statEntrances: 'Entrances',
    statPhotos: 'with photo',
    statAnswered: 'questions answered',
  },
}
const L = S[lang === 'en' ? 'en' : 'de']

/** Score from which the profile counts as "checked". */
export const VERIFIED_MIN_SCORE = 70

const GRID_KEY = 'doorway.bizGridCollapsed'

let uid = 0
const icon = (name: string, filled = false) => h('span', { class: `ms${filled ? ' ms-fill' : ''}`, 'aria-hidden': 'true' }, name)

export interface BusinessHomeStats {
  entrances: number
  withPhoto: number
  answered: number
  questions: number
  tasksDone: number
  tasksTotal: number
  score: number
  /** Oldest and newest createdAt of the linked entrances, null without entrances. */
  since: Date | null
  until: Date | null
}

/** Counts shown in "Leistung". All derived from local data, nothing estimated. */
export function businessHomeStats(b: BusinessProfile): BusinessHomeStats {
  const survey = loadSurvey()
  const linked = survey.filter((e) => b.entranceIds.includes(e.id) || e.businessId === b.id)
  const d = loadDetails(b.id)
  const answered = d ? ACCESS_ATTRS.filter((a) => d.access[a.id] !== 'unbekannt').length : 0
  const times = linked.map((e) => Date.parse(e.createdAt)).filter((t) => Number.isFinite(t))
  return {
    entrances: linked.length,
    withPhoto: linked.filter((e) => typeof e.photo === 'string' && e.photo.length > 0).length,
    answered,
    questions: ACCESS_ATTRS.length,
    tasksDone: b.tasks.filter((t) => t.done).length,
    tasksTotal: b.tasks.length,
    score: visibilityScore(b, survey, answered / ACCESS_ATTRS.length),
    since: times.length ? new Date(Math.min(...times)) : null,
    until: times.length ? new Date(Math.max(...times)) : null,
  }
}

/** Disclosure popover: button toggles, Escape and outside taps close, focus returns to the button. */
export function popover(btn: HTMLButtonElement, panel: HTMLElement): void {
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

function monthYear(d: Date): string {
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { month: 'short', year: 'numeric' })
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(GRID_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(v: boolean): void {
  try {
    localStorage.setItem(GRID_KEY, v ? '1' : '0')
  } catch {
    /* blocked: toggle still works for this view */
  }
}

/** Progress ring like the "Profilstärke" frame: thin teal arc on a dark track, "NN %" inside. */
function ring(score: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const r = 25
  const c = 2 * Math.PI * r
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('class', 'bzh-ring')
  svg.setAttribute('viewBox', '0 0 60 60')
  svg.setAttribute('aria-hidden', 'true')
  const circle = (cls: string) => {
    const el = document.createElementNS(ns, 'circle')
    el.setAttribute('class', cls)
    el.setAttribute('cx', '30')
    el.setAttribute('cy', '30')
    el.setAttribute('r', String(r))
    return el
  }
  const track = circle('bzh-ring-track')
  const arc = circle('bzh-ring-arc')
  arc.setAttribute('stroke-dasharray', `${(c * Math.max(0, Math.min(100, score))) / 100} ${c}`)
  const text = document.createElementNS(ns, 'text')
  text.setAttribute('class', 'bzh-ring-text')
  text.setAttribute('x', '30')
  text.setAttribute('y', '30')
  text.setAttribute('text-anchor', 'middle')
  text.setAttribute('dominant-baseline', 'central')
  text.textContent = `${score} %`
  svg.append(track, arc, text)
  return svg
}

export function businessHomeHeader(_ctx: FeatureCtx, business: BusinessProfile, actions: BusinessHomeActions, opts: BusinessHomeOptions): HTMLElement {
  const id = `bzh${++uid}`
  const stats = businessHomeStats(business)
  const verified = stats.score >= VERIFIED_MIN_SCORE

  // ---------- top bar: centred title, info, bell ----------
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
    ? h('button', { class: 'bzh-info', type: 'button', 'aria-label': L.info, onclick: actions.onData }, icon('info'))
    : null
  const top = h('header', { class: 'bzh-top' },
    infoBtn,
    h('h2', { id: 'sheet-title', class: 'bzh-title', tabindex: '-1' }, L.title),
    bellBtn,
    bellPanel,
  )

  // ---------- business row: avatar, name, address, profile link, chevron menu ----------
  const letter = (business.name.trim()[0] ?? '?').toLocaleUpperCase('de-DE')
  const menuBtn = h('button', {
    class: 'bzh-chev', type: 'button', 'aria-label': L.switcher(business.name),
    'aria-expanded': 'false', 'aria-controls': `${id}-menu`,
  }, icon('keyboard_arrow_down'))
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
  const bizRow = h('div', { class: 'bzh-biz' },
    h('span', { class: 'bzh-avatar', 'aria-hidden': 'true' },
      letter,
      verified ? h('span', { class: 'bzh-verified' }, icon('verified', true)) : null,
    ),
    h('div', { class: 'bzh-biz-text' },
      h('p', { class: 'bzh-name' }, business.name, verified ? h('span', { class: 'sr-only' }, `, ${L.verified}`) : null),
      h('p', { class: 'bzh-addr' }, business.address || L.noAddress),
      h('button', { class: 'bzh-link', type: 'button', onclick: actions.onPreview }, L.viewProfile),
    ),
    menuBtn,
    menu,
  )

  // ---------- "Profilstärke" card ----------
  const strength = h('button', { class: 'bzh-strength', type: 'button', 'aria-label': L.strengthAria(stats.score), onclick: actions.onScore },
    h('span', { class: 'bzh-strength-text' },
      h('span', { class: 'bzh-strength-title' }, L.strength),
      h('span', { class: 'bzh-strength-sub' }, L.strengthSub),
    ),
    ring(stats.score),
  )

  // ---------- 4-column grid of round tonal actions ----------
  const action = (name: string, label: string, onclick: () => void) =>
    h('li', { class: 'bzh-action' },
      h('button', { class: 'bzh-action-btn', type: 'button', onclick },
        h('span', { class: 'bzh-action-circle', 'aria-hidden': 'true' }, icon(name, true)),
        h('span', { class: 'bzh-action-label' }, label),
      ),
    )
  const items = [
    action('edit', L.edit, actions.onEdit),
    action('door_front', L.entrances, actions.onEntrances),
    action('videocam', L.record, actions.onRecord),
    action('add_photo_alternate', L.photos, actions.onPhotos),
    action('schedule', L.hours, actions.onHours),
    action('accessible', L.access, actions.onAccess),
    action('visibility', L.preview, actions.onPreview),
    actions.onData ? action('database', L.data, actions.onData) : null,
  ].filter((x): x is HTMLLIElement => x !== null)
  let collapsed = readCollapsed()
  const grid = h('ul', { class: 'bzh-grid', id: `${id}-grid`, 'aria-label': L.actionsLabel }, ...items)
  const toggleLabel = h('span', {})
  const toggleIcon = icon('keyboard_arrow_up')
  const toggle = h('button', { class: 'bzh-more', type: 'button', 'aria-controls': `${id}-grid` }, toggleIcon, toggleLabel)
  const apply = () => {
    items.forEach((li, i) => { li.hidden = collapsed && i >= 4 })
    toggle.setAttribute('aria-expanded', String(!collapsed))
    toggleLabel.textContent = collapsed ? L.more : L.less
    toggleIcon.textContent = collapsed ? 'keyboard_arrow_down' : 'keyboard_arrow_up'
  }
  toggle.addEventListener('click', () => {
    collapsed = !collapsed
    writeCollapsed(collapsed)
    apply()
  })
  apply()

  // ---------- "Leistung": plain numbers ----------
  const stat = (value: number, label: string) =>
    h('li', { class: 'bzh-stat' },
      h('span', { class: 'bzh-stat-value' }, String(value)),
      h('span', { class: 'bzh-stat-label' }, label),
    )
  const range = stats.since && stats.until ? L.range(monthYear(stats.since), monthYear(stats.until)) : ''
  const perf = h('section', { class: 'bzh-sec', 'aria-labelledby': `${id}-perf` },
    h('h3', { class: 'bzh-h3', id: `${id}-perf` }, L.perf),
    range ? h('p', { class: 'bzh-sub' }, range) : null,
    h('ul', { class: 'bzh-stats' },
      stat(stats.entrances, L.statEntrances),
      stat(stats.withPhoto, L.statPhotos),
      stat(stats.answered, L.statAnswered),
    ),
  )

  return h('div', { class: 'bzh' }, top, bizRow, h('div', { class: 'bzh-pad' }, strength), grid, toggle, perf)
}
