// Profile header for the "Unternehmen" tab, in the style of the Google Maps business
// profile card: name, category and address, a row of round tonal action buttons, a
// "Leistung" card with real local counts only (nothing is invented) and a preview hint.
// Pure view: it reads the survey store once for the counts and never writes.

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
}

const S = {
  de: {
    chip: 'Dein Unternehmensprofil',
    actionsLabel: 'Aktionen',
    category: 'Lokales Unternehmen',
    noAddress: 'Keine Adresse angegeben',
    verified: 'Barrierefreiheit geprüft',
    edit: 'Profil bearbeiten',
    entrances: 'Eingänge',
    record: 'Weg filmen',
    photos: 'Fotos',
    preview: 'Vorschau',
    perf: 'Leistung',
    perfSub: 'Zahlen von diesem Gerät',
    statEntrances: 'Anzahl Eingänge',
    statPhotos: 'mit Foto',
    statTasks: 'Aufgaben erledigt',
    statScore: 'Score',
    of: (a: number, b: number) => `${a} von ${b}`,
    hintTitle: 'Vorschau',
    hintText: 'So sehen Kunden deinen Eintrag',
    hintLabel: 'Vorschau öffnen: So sehen Kunden deinen Eintrag',
  },
  en: {
    chip: 'Your business profile',
    actionsLabel: 'Actions',
    category: 'Local business',
    noAddress: 'No address given',
    verified: 'Accessibility checked',
    edit: 'Edit profile',
    entrances: 'Entrances',
    record: 'Film the way',
    photos: 'Photos',
    preview: 'Preview',
    perf: 'Performance',
    perfSub: 'Counts from this device',
    statEntrances: 'Entrances',
    statPhotos: 'with photo',
    statTasks: 'Tasks done',
    statScore: 'Score',
    of: (a: number, b: number) => `${a} of ${b}`,
    hintTitle: 'Preview',
    hintText: 'This is how customers see your listing',
    hintLabel: 'Open preview: this is how customers see your listing',
  },
}
const L = S[lang === 'en' ? 'en' : 'de']

/** Score from which the profile shows the "checked" badge. */
export const VERIFIED_MIN_SCORE = 70

let uid = 0
const icon = (name: string, filled = false) => h('span', { class: `ms${filled ? ' ms-fill' : ''}`, 'aria-hidden': 'true' }, name)

/** Counts shown in the "Leistung" card. All derived from local data, nothing estimated. */
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

export function businessHomeHeader(_ctx: FeatureCtx, business: BusinessProfile, actions: BusinessHomeActions): HTMLElement {
  const id = `bzh${++uid}`
  const stats = businessHomeStats(business)
  const verified = stats.score >= VERIFIED_MIN_SCORE

  // ---------- profile head ----------
  const head = h(
    'div',
    { class: 'bzh-head' },
    h('div', { class: 'bzh-avatar', 'aria-hidden': 'true' }, icon('storefront', true)),
    h(
      'div',
      { class: 'bzh-text' },
      h('span', { class: 'bzh-chip' }, L.chip),
      h('h2', { id: 'sheet-title', class: 'bzh-name', tabindex: '-1' }, business.name),
      h('p', { class: 'bzh-meta' }, `${L.category} · ${business.address || L.noAddress}`),
      verified ? h('span', { class: 'bzh-badge' }, icon('verified', true), L.verified) : null,
    ),
  )

  // ---------- round action buttons ----------
  const action = (name: string, label: string, onclick: () => void) =>
    h('li', { class: 'bzh-action' },
      h('button', { class: 'bzh-action-btn', type: 'button', onclick },
        h('span', { class: 'bzh-action-circle', 'aria-hidden': 'true' }, icon(name)),
        h('span', { class: 'bzh-action-label' }, label),
      ),
    )
  const row = h(
    'ul',
    { class: 'bzh-actions', 'aria-label': L.actionsLabel },
    action('edit', L.edit, actions.onEdit),
    action('door_front', L.entrances, actions.onEntrances),
    action('videocam', L.record, actions.onRecord),
    action('photo_camera', L.photos, actions.onPhotos),
    action('visibility', L.preview, actions.onPreview),
  )

  // ---------- "Leistung" card: real local counts only ----------
  const stat = (label: string, value: string, extraClass = '') =>
    h('div', { class: `bzh-stat${extraClass ? ` ${extraClass}` : ''}` },
      h('dt', { class: 'bzh-stat-label' }, label),
      h('dd', { class: 'bzh-stat-value' }, value),
    )
  const perf = h(
    'section',
    { class: 'bzh-card', 'aria-labelledby': `${id}-perf` },
    h('div', { class: 'bzh-card-head' },
      h('h3', { class: 'bzh-h3', id: `${id}-perf` }, L.perf),
      h('span', { class: 'bzh-card-sub' }, L.perfSub),
    ),
    h(
      'dl',
      { class: 'bzh-stats' },
      stat(L.statEntrances, String(stats.entrances)),
      stat(L.statPhotos, String(stats.withPhoto)),
      stat(L.statTasks, L.of(stats.tasksDone, stats.tasksTotal)),
      stat(L.statScore, L.of(stats.score, 100), 'bzh-stat-score'),
    ),
    h('div', {
      class: 'bzh-bar', role: 'progressbar', 'aria-label': L.statScore,
      'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': stats.score, 'aria-valuetext': L.of(stats.score, 100),
    }, h('div', { class: 'bzh-bar-fill', style: `width:${stats.score}%` })),
  )

  // ---------- preview hint ----------
  const hint = h(
    'button',
    { class: 'bzh-hint', type: 'button', 'aria-label': L.hintLabel, onclick: actions.onPreview },
    h('span', { class: 'bzh-hint-icon', 'aria-hidden': 'true' }, icon('visibility')),
    h('span', { class: 'bzh-hint-text' },
      h('span', { class: 'bzh-hint-title' }, L.hintTitle),
      h('span', { class: 'bzh-hint-sub' }, L.hintText),
    ),
    icon('chevron_right'),
  )

  return h('div', { class: 'bzh', 'aria-labelledby': 'sheet-title', role: 'region' }, head, row, perf, hint)
}
