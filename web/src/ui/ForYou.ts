// "Fuer dich" tab: saved entrances, recently viewed, recommendations for the
// accessibility profile, and a one-line profile summary. Google Maps style rows.

import './foryou.css'
import { haversineM } from '../core/geo'
import type { Channel } from '../core/profile'
import { guidanceFor, markerKind } from '../core/target'
import type { Entrance } from '../core/types'
import { lang } from '../strings'
import type { FeatureCtx, Panel } from './ctx'
import { h } from './dom'

const SAVED_KEY = 'doorway.saved'
const RECENT_KEY = 'doorway.recent'
const RECENT_MAX = 10
const RECOMMEND_MAX = 5

const L = {
  de: {
    title: 'Für dich',
    saved: 'Gespeichert',
    savedNone: 'Speichere einen Eingang mit dem Lesezeichen auf seiner Karte.',
    recent: 'Zuletzt angesehen',
    recentNone: 'Noch keine Eingänge angesehen.',
    recommended: 'Empfohlen für dich',
    recommendedNone: 'In diesem Kartenbereich gibt es keinen Eingang, zu dem Doorway dich führen kann.',
    profile: 'Dein Profil',
    elsewhere: 'In einem anderen Kartenbereich',
    elsewhereCount: (n: number) => (n === 1 ? '1 Eingang in einem anderen Kartenbereich' : `${n} Eingänge in einem anderen Kartenbereich`),
    unnamed: 'Eingang ohne Namen',
    stepFreeYes: 'Stufenlos',
    stepFreeNo: 'Nicht stufenlos',
    stepFreeUnknown: 'Stufenlos unbekannt',
    needStepFree: (v: boolean) => `Stufenlos nötig: ${v ? 'ja' : 'nein'}`,
    channels: 'Kanäle',
    ch: { speech: 'Sprache', visual: 'Große Anzeige', haptic: 'Vibration' } as Record<Channel, string>,
    allChannels: 'alle',
    metres: (m: number) => `${Math.round(m)} m`,
  },
  en: {
    title: 'For you',
    saved: 'Saved',
    savedNone: 'Save an entrance with the bookmark on its card.',
    recent: 'Recently viewed',
    recentNone: 'No entrances viewed yet.',
    recommended: 'Recommended for you',
    recommendedNone: 'No entrance in this map area that Doorway can guide you to.',
    profile: 'Your profile',
    elsewhere: 'In another map area',
    elsewhereCount: (n: number) => (n === 1 ? '1 entrance in another map area' : `${n} entrances in another map area`),
    unnamed: 'Unnamed entrance',
    stepFreeYes: 'Step-free',
    stepFreeNo: 'Not step-free',
    stepFreeUnknown: 'Step-free unknown',
    needStepFree: (v: boolean) => `Step-free needed: ${v ? 'yes' : 'no'}`,
    channels: 'Channels',
    ch: { speech: 'Speech', visual: 'Large visuals', haptic: 'Vibration' } as Record<Channel, string>,
    allChannels: 'all',
    metres: (m: number) => `${Math.round(m)} m`,
  },
}
const T = lang === 'de' ? L.de : L.en

function readIds(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Remember that an entrance card was opened. Most recent first, max 10. */
export function rememberRecent(id: string): void {
  if (!id) return
  const next = [id, ...readIds(RECENT_KEY).filter((x) => x !== id)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable */
  }
}

const stepFreeText = (v: boolean | null) => (v === true ? T.stepFreeYes : v === false ? T.stepFreeNo : T.stepFreeUnknown)

function row(e: Entrance, ctx: FeatureCtx, onOpen: () => void): HTMLElement {
  const meta = [stepFreeText(e.stepFree), T.metres(haversineM(ctx.origin(), e))].join(' · ')
  return h(
    'li',
    {},
    h(
      'button',
      { class: `gm-row door-${markerKind(e)}`, type: 'button', onclick: onOpen },
      h('span', { class: 'gm-row-shape', 'aria-hidden': 'true' }),
      h('span', { class: 'gm-row-text' }, h('span', { class: 'gm-row-title' }, e.name ?? T.unnamed), h('span', { class: 'gm-row-meta' }, meta)),
    ),
  )
}

function section(id: string, title: string, ...body: HTMLElement[]): HTMLElement {
  return h('section', { class: 'fy-section', 'aria-labelledby': id }, h('h3', { id, class: 'fy-heading' }, title), ...body)
}

/** Resolve stored ids against the loaded entrances; keep stored order. */
function resolve(ids: string[], byId: Map<string, Entrance>): { found: Entrance[]; missing: number } {
  const found: Entrance[] = []
  let missing = 0
  for (const id of ids) {
    const e = byId.get(id)
    if (e) found.push(e)
    else missing++
  }
  return { found, missing }
}

function idList(ids: string[], byId: Map<string, Entrance>, empty: string, ctx: FeatureCtx): HTMLElement {
  const { found, missing } = resolve(ids, byId)
  const items: HTMLElement[] = found.map((e) => row(e, ctx, () => ctx.openDoor(e)))
  if (missing) items.push(h('li', { class: 'gm-empty fy-elsewhere' }, T.elsewhereCount(missing)))
  if (!items.length) items.push(h('li', { class: 'gm-empty' }, empty))
  return h('ul', { class: 'gm-list' }, ...items)
}

export const forYouPanel: Panel = (el, ctx) => {
  const entrances = ctx.entrances()
  const byId = new Map(entrances.map((e) => [e.id, e] as const))
  const origin = ctx.origin()

  const recommended = entrances
    .filter((e) => guidanceFor(e, ctx.profile).kind === 'arrow')
    .map((e) => ({ e, d: haversineM(origin, e) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, RECOMMEND_MAX)

  const channels = ctx.profile.channels.length ? ctx.profile.channels.map((c) => T.ch[c]).join(', ') : T.allChannels
  const profileLine = `${T.needStepFree(ctx.profile.stepFreeRequired)}. ${T.channels}: ${channels}.`

  const root = h(
    'div',
    { class: 'fy' },
    h('div', { class: 'gm-sheet-head' }, h('h2', { id: 'sheet-title', class: 'gm-sheet-title' }, T.title)),
    section('fy-saved', T.saved, idList(readIds(SAVED_KEY), byId, T.savedNone, ctx)),
    section('fy-recent', T.recent, idList(readIds(RECENT_KEY), byId, T.recentNone, ctx)),
    section(
      'fy-rec',
      T.recommended,
      h('ul', { class: 'gm-list' }, ...(recommended.length ? recommended.map(({ e }) => row(e, ctx, () => ctx.openDoor(e))) : [h('li', { class: 'gm-empty' }, T.recommendedNone)])),
    ),
    section('fy-profile', T.profile, h('p', { class: 'gm-p fy-profile' }, profileLine)),
  )

  el.replaceChildren(root)
  return () => root.remove()
}
