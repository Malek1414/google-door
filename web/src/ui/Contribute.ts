// "Beitragen" tab: like the Contribute tab in Google Maps, but for entrance accessibility.
// Action tiles, nearby entrances without data, and the user's own contributions with
// Local-Guides-style points and levels.

import './contribute.css'
import { haversineM, type LatLon } from '../core/geo'
import type { Entrance } from '../core/types'
import { loadSurvey, type SurveyEntrance } from '../core/survey'
import { lang } from '../strings'
import type { FeatureCtx, Panel } from './ctx'
import { h } from './dom'
import { openEntranceEditor } from './EntranceEditor'

const S = {
  de: {
    title: 'Beitragen',
    sub: 'Hilf anderen, den richtigen Eingang zu finden',
    report: 'Eingang melden',
    record: 'Weg aufnehmen',
    photo: 'Foto hinzufügen',
    nearbyHead: 'Eingänge ohne Angaben in der Nähe',
    nearbyEmpty: 'Hier in der Nähe fehlen gerade keine Angaben.',
    ask: 'Ist dieser Eingang stufenlos?',
    unnamed: 'Eingang ohne Namen',
    mineHead: 'Deine Beiträge',
    mineEmpty: 'Noch keine Beiträge. Dein erster bringt 10 Punkte.',
    count: (n: number) => (n === 1 ? '1 Beitrag' : `${n} Beiträge`),
    points: (n: number) => `${n} Punkte`,
    level: (n: number) => `Stufe ${n}`,
    toNext: (n: number, lvl: number) => `Noch ${n} Punkte bis Stufe ${lvl}`,
    maxLevel: 'Höchste Stufe erreicht',
    withPhoto: 'mit Foto',
    stepFree: 'stufenlos',
    notStepFree: 'nicht stufenlos',
    unknown: 'unbekannt',
    metres: (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`),
    thanks: (p: number) => `Danke! Dein Beitrag hilft anderen, den richtigen Eingang zu finden. Plus ${p} Punkte.`,
  },
  en: {
    title: 'Contribute',
    sub: 'Help others find the right entrance',
    report: 'Report entrance',
    record: 'Record a walk',
    photo: 'Add photo',
    nearbyHead: 'Entrances nearby without data',
    nearbyEmpty: 'No entrances nearby are missing data right now.',
    ask: 'Is this entrance step-free?',
    unnamed: 'Unnamed entrance',
    mineHead: 'Your contributions',
    mineEmpty: 'No contributions yet. Your first one earns 10 points.',
    count: (n: number) => (n === 1 ? '1 contribution' : `${n} contributions`),
    points: (n: number) => `${n} points`,
    level: (n: number) => `Level ${n}`,
    toNext: (n: number, lvl: number) => `${n} points to level ${lvl}`,
    maxLevel: 'Top level reached',
    withPhoto: 'with photo',
    stepFree: 'step-free',
    notStepFree: 'not step-free',
    unknown: 'unknown',
    metres: (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`),
    thanks: (p: number) => `Thank you! Your contribution helps others find the right entrance. Plus ${p} points.`,
  },
}
const L = lang === 'de' ? S.de : S.en

const MAX_ROWS = 8
const LEVELS = [0, 50, 150, 300, 500] // Stufe 1..5

const pointsFor = (c: SurveyEntrance) => 10 + (c.photo ? 5 : 0)

function levelOf(points: number): { level: number; next: number | null } {
  let level = 1
  LEVELS.forEach((min, i) => { if (points >= min) level = i + 1 })
  return { level, next: level < LEVELS.length ? LEVELS[level] : null }
}

const icon = (name: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, name)

export const contributePanel: Panel = (el, ctx) => {
  let editorCleanup: (() => void) | null = null
  let alive = true

  const closeEditor = () => {
    editorCleanup?.()
    editorCleanup = null
  }

  function openEditor(at: LatLon, extra: { name?: string | null; focusPhoto?: boolean } = {}) {
    closeEditor()
    el.replaceChildren()
    ctx.setSheet('full')
    editorCleanup = openEntranceEditor(ctx, el, {
      lat: at.lat,
      lon: at.lon,
      by: 'community',
      initial: extra.name ? { name: extra.name } : undefined,
      onSaved: (entry: SurveyEntrance) => {
        closeEditor()
        ctx.refresh()
        ctx.announce(L.thanks(pointsFor(entry)))
        render()
      },
      onCancel: () => {
        closeEditor()
        render()
      },
    })
    if (extra.focusPhoto) {
      const photo = el.querySelector<HTMLElement>('.ee-file')
      photo?.scrollIntoView({ block: 'center' })
      photo?.focus({ preventScroll: true })
    }
  }

  function tile(label: string, name: string, onclick: () => void) {
    return h(
      'li',
      {},
      h('button', { class: 'ct-tile', type: 'button', onclick }, h('span', { class: 'ct-tile-icon' }, icon(name)), h('span', { class: 'ct-tile-label' }, label)),
    )
  }

  function nearbySection(c: FeatureCtx) {
    const o = c.origin()
    const rows = c
      .entrances()
      .filter((e: Entrance) => e.tier === 0 && e.stepFree === null)
      .map((e) => ({ e, d: haversineM(o, e) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_ROWS)
    const headId = 'ct-nearby-head'
    return h(
      'section',
      { class: 'ct-section', 'aria-labelledby': headId },
      h('h3', { class: 'ct-h', id: headId }, L.nearbyHead),
      h(
        'ul',
        { class: 'gm-list' },
        ...(rows.length
          ? rows.map(({ e, d }) =>
              h(
                'li',
                {},
                h(
                  'button',
                  {
                    class: 'gm-row',
                    type: 'button',
                    'aria-label': `${e.name ?? L.unnamed}, ${L.metres(d)}. ${L.ask}`,
                    onclick: () => openEditor({ lat: e.lat, lon: e.lon }, { name: e.name }),
                  },
                  h('span', { class: 'ct-q', 'aria-hidden': 'true' }, icon('help')),
                  h('span', { class: 'gm-row-text' }, h('span', { class: 'gm-row-title' }, e.name ?? L.unnamed), h('span', { class: 'gm-row-meta' }, `${L.metres(d)} · ${L.ask}`)),
                  icon('chevron_right'),
                ),
              ),
            )
          : [h('li', { class: 'gm-empty' }, L.nearbyEmpty)]),
      ),
    )
  }

  function mineSection(list: SurveyEntrance[]) {
    const mine = list.filter((c) => c.by === 'community')
    const total = mine.reduce((sum, c) => sum + pointsFor(c), 0)
    const { level, next } = levelOf(total)
    const floor = LEVELS[level - 1]
    const pct = next === null ? 100 : Math.round(((total - floor) / (next - floor)) * 100)
    const headId = 'ct-mine-head'
    const o = ctx.origin()
    return h(
      'section',
      { class: 'ct-section', 'aria-labelledby': headId },
      h('h3', { class: 'ct-h', id: headId }, L.mineHead),
      h(
        'div',
        { class: 'ct-level' },
        h('span', { class: 'ct-level-badge' }, icon('star'), L.level(level)),
        h('span', { class: 'ct-level-text' }, h('strong', {}, L.points(total)), ` · ${L.count(mine.length)}`),
        h(
          'div',
          { class: 'ct-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': next === null ? L.maxLevel : L.toNext(next - total, level + 1) },
          h('span', { style: `width:${pct}%` }),
        ),
        h('span', { class: 'ct-level-next' }, next === null ? L.maxLevel : L.toNext(next - total, level + 1)),
      ),
      h(
        'ul',
        { class: 'gm-list' },
        ...(mine.length
          ? mine
              .slice()
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((c) => {
                const verdict = c.stepFree === true ? L.stepFree : c.stepFree === false ? L.notStepFree : L.unknown
                const dist = L.metres(haversineM(o, c))
                const meta = [verdict, c.photo ? L.withPhoto : null, dist, `+${pointsFor(c)}`].filter(Boolean).join(' · ')
                return h(
                  'li',
                  { class: 'gm-row ct-mine-row' },
                  h('span', { class: 'ct-q', 'aria-hidden': 'true' }, icon(c.photo ? 'photo_camera' : 'check')),
                  h('span', { class: 'gm-row-text' }, h('span', { class: 'gm-row-title' }, c.name || L.unnamed), h('span', { class: 'gm-row-meta' }, meta)),
                )
              })
          : [h('li', { class: 'gm-empty' }, L.mineEmpty)]),
      ),
    )
  }

  function render() {
    if (!alive) return
    const mineSlot = h('div', {})
    el.replaceChildren(
      h(
        'div',
        { class: 'ct' },
        h('div', { class: 'gm-sheet-head' }, h('h2', { class: 'gm-sheet-title' }, L.title)),
        h('p', { class: 'gm-sheet-sub' }, L.sub),
        h(
          'ul',
          { class: 'ct-tiles' },
          tile(L.report, 'add_location_alt', () => openEditor(ctx.origin())),
          tile(L.record, 'route', () => ctx.openRecorder()),
          tile(L.photo, 'add_a_photo', () => openEditor(ctx.origin(), { focusPhoto: true })),
        ),
        nearbySection(ctx),
        mineSlot,
      ),
    )
    let list: SurveyEntrance[] = []
    try { list = loadSurvey() } catch { /* storage blocked: show empty state */ }
    mineSlot.replaceChildren(mineSection(list))
  }

  render()
  return () => {
    alive = false
    closeEditor()
  }
}
