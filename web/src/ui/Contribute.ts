// "Beitragen" tab: like the Contribute tab in Google Maps, but for entrance accessibility.
// Action tiles, nearby entrances without data, and the user's own contributions with
// Local-Guides-style points and levels.

import './contribute.css'
import { haversineM, type LatLon } from '../core/geo'
import type { Entrance } from '../core/types'
import { loadSurvey, type SurveyEntrance } from '../core/survey'
import { lang } from '../strings'
import type { FeatureCtx, Panel } from './ctx'
import { h, s } from './dom'
import { openEntranceEditor } from './EntranceEditor'

const S = {
  de: {
    title: 'Beitragen',
    you: 'Du',
    guide: (n: number) => `Local Guide Level ${n}`,
    profile: 'Deine Beiträge ansehen',
    pointsOf: (b: number) => `von ${fmt(b)} Punkten`,
    add: 'Eingang hinzufügen',
    update: 'Eingang aktualisieren',
    review: 'Rezension schreiben',
    photo: 'Foto hinzufügen',
    record: 'Weg aufnehmen',
    badgeHead: 'Hol dir deine Auszeichnung „Wegbereiter – Neuling“',
    badgeSub: 'Anderen helfen, 3 Eingänge zu erfassen',
    badgeLocked: 'Auszeichnung noch gesperrt',
    badgeDone: 'Auszeichnung freigeschaltet',
    badgeTask: 'Eingänge für 3 Orte hinzufügen',
    nearbyHead: 'Eingänge ohne Angaben in der Nähe',
    nearbyEmpty: 'Hier in der Nähe fehlen gerade keine Angaben.',
    ask: 'Ist dieser Eingang stufenlos?',
    unnamed: 'Eingang ohne Namen',
    statsHead: 'Beiträge insgesamt',
    fresh: (n: number) => `${n} neu`,
    chartLabel: (n: number) => `Verlauf deiner Beiträge, insgesamt ${n}`,
    chartEmpty: 'Dein erster Beitrag erscheint hier im Verlauf.',
    pointsCardPre: 'Für deine Beiträge gibt es',
    pointsCard: (n: number) => `${fmt(n)} Punkte`,
    seeAll: 'Beiträge ansehen',
    mineHead: 'Deine Beiträge',
    mineEmpty: 'Noch keine Beiträge. Dein erster bringt 10 Punkte.',
    withPhoto: 'mit Foto',
    stepFree: 'stufenlos',
    notStepFree: 'nicht stufenlos',
    unknown: 'unbekannt',
    metres: (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`),
    thanks: (p: number) => `Danke! Dein Beitrag hilft anderen, den richtigen Eingang zu finden. Plus ${p} Punkte.`,
    months: ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'],
  },
  en: {
    title: 'Contribute',
    you: 'You',
    guide: (n: number) => `Local Guide Level ${n}`,
    profile: 'See your contributions',
    pointsOf: (b: number) => `of ${fmt(b)} points`,
    add: 'Add entrance',
    update: 'Update entrance',
    review: 'Write a review',
    photo: 'Add photo',
    record: 'Record a walk',
    badgeHead: 'Earn your badge “Pathfinder, Novice”',
    badgeSub: 'Help others by mapping 3 entrances',
    badgeLocked: 'Badge still locked',
    badgeDone: 'Badge unlocked',
    badgeTask: 'Add entrances for 3 places',
    nearbyHead: 'Entrances nearby without data',
    nearbyEmpty: 'No entrances nearby are missing data right now.',
    ask: 'Is this entrance step-free?',
    unnamed: 'Unnamed entrance',
    statsHead: 'Total contributions',
    fresh: (n: number) => `${n} new`,
    chartLabel: (n: number) => `History of your contributions, ${n} in total`,
    chartEmpty: 'Your first contribution will show up here.',
    pointsCardPre: 'Your contributions earned',
    pointsCard: (n: number) => `${fmt(n)} points`,
    seeAll: 'See contributions',
    mineHead: 'Your contributions',
    mineEmpty: 'No contributions yet. Your first one earns 10 points.',
    withPhoto: 'with photo',
    stepFree: 'step-free',
    notStepFree: 'not step-free',
    unknown: 'unknown',
    metres: (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`),
    thanks: (p: number) => `Thank you! Your contribution helps others find the right entrance. Plus ${p} points.`,
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
}
function fmt(n: number) { return n.toLocaleString(lang === 'de' ? 'de-DE' : 'en-US') }
const L = lang === 'de' ? S.de : S.en

const MAX_ROWS = 8
const LEVELS = [0, 50, 150, 300, 500, 1500] // Level 1..6
const BADGE_GOAL = 3
const DAY = 86_400_000

const pointsFor = (c: SurveyEntrance) => 10 + (c.photo ? 5 : 0)

function levelOf(points: number): { level: number; next: number | null } {
  let level = 1
  LEVELS.forEach((min, i) => { if (points >= min) level = i + 1 })
  return { level, next: level < LEVELS.length ? LEVELS[level] : null }
}

function guideName(): string {
  try { return localStorage.getItem('doorway.guideName')?.trim() || L.you } catch { return L.you }
}

const icon = (name: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, name)

/** Step chart of the cumulative contribution count over time (real createdAt values). */
function stepChart(mine: SurveyEntrance[]): SVGSVGElement | HTMLElement {
  const times = mine.map((c) => Date.parse(c.createdAt)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)
  if (!times.length) return h('p', { class: 'ct-chart-empty' }, L.chartEmpty)
  const W = 340, H = 150, top = 16, bottom = 120, right = 300
  const now = Date.now()
  const t0 = Math.min(times[0], now - 21 * DAY) - 2 * DAY
  const x = (t: number) => ((t - t0) / (now - t0)) * right
  const maxN = times.length
  const y = (n: number) => bottom - 10 - (n / maxN) * (bottom - top - 20)
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ct-chart', role: 'img', 'aria-label': L.chartLabel(maxN) })
  // weekly guide lines with date labels, like the frame
  for (let t = now; t > t0 + 2 * DAY; t -= 7 * DAY) {
    const d = new Date(t)
    const gx = x(t)
    svg.append(s('line', { x1: gx, x2: gx, y1: top + 10, y2: bottom, class: 'ct-grid' }))
    const label = d.getDate() <= 7 ? `${d.getDate()}. ${L.months[d.getMonth()]}` : String(d.getDate())
    svg.append(s('text', { x: gx, y: bottom + 22, 'text-anchor': 'middle', class: 'ct-axis' }, label))
  }
  svg.append(s('text', { x: W - 2, y: top + 4, 'text-anchor': 'end', class: 'ct-axis' }, fmt(maxN)))
  svg.append(s('text', { x: W - 2, y: bottom - 6, 'text-anchor': 'end', class: 'ct-axis' }, '0'))
  // cumulative step path, recent week drawn in green
  const cut = now - 7 * DAY
  let old = `M0 ${y(0)}`, fresh = ''
  let n = 0
  for (const t of times) {
    const seg = ` L${x(t).toFixed(1)} ${y(n).toFixed(1)} L${x(t).toFixed(1)} ${y(n + 1).toFixed(1)}`
    if (t < cut) old += seg
    else { if (!fresh) fresh = `M${x(Math.max(cut, times[0])).toFixed(1)} ${y(n).toFixed(1)}`; fresh += seg }
    n++
  }
  if (fresh) {
    old += ` L${x(cut).toFixed(1)} ${y(times.filter((t) => t < cut).length).toFixed(1)}`
    fresh += ` L${right} ${y(n).toFixed(1)}`
  } else old += ` L${right} ${y(n).toFixed(1)}`
  svg.append(s('path', { d: old, class: 'ct-line' }))
  if (fresh) svg.append(s('path', { d: fresh, class: 'ct-line ct-line-new' }))
  return svg
}

/** Decorative shapes of the points card (yellow dot, red ring, green ring, blue quarter). */
function pointsDeco(): SVGSVGElement {
  return s(
    'svg',
    { viewBox: '0 0 390 90', class: 'ct-deco', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMax slice' },
    s('path', { d: 'M0 90 C40 40 90 50 120 70 C150 20 190 20 210 60 C250 30 300 40 340 70 L390 90 Z', fill: '#2f2f33' }),
    s('circle', { cx: 112, cy: 42, r: 19, fill: '#c9a53a' }),
    s('circle', { cx: 200, cy: 50, r: 20, fill: 'none', stroke: '#b5484f', 'stroke-width': 13 }),
    s('circle', { cx: 268, cy: 92, r: 24, fill: 'none', stroke: '#3f9a58', 'stroke-width': 14 }),
    s('path', { d: 'M318 60 A52 52 0 0 1 370 8 L370 60 Z', fill: '#4a689e' }),
    s('circle', { cx: 370, cy: 66, r: 14, fill: '#151316' }),
  )
}

export const contributePanel: Panel = (el, ctx) => {
  let editorCleanup: (() => void) | null = null
  let alive = true

  const closeEditor = () => {
    editorCleanup?.()
    editorCleanup = null
  }

  function openEditor(at: LatLon, extra: { name?: string | null; focusPhoto?: boolean; focusNote?: boolean } = {}) {
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
    const focusSel = extra.focusPhoto ? '.ee-file' : extra.focusNote ? '.ee-textarea' : null
    if (focusSel) {
      const target = el.querySelector<HTMLElement>(focusSel)
      target?.scrollIntoView({ block: 'center' })
      target?.focus({ preventScroll: true })
    }
  }

  /** Closest known entrance (any), for "Eingang aktualisieren" and "Rezension schreiben". */
  function nearest(): Entrance | null {
    const o = ctx.origin()
    let best: Entrance | null = null
    let bestD = Infinity
    for (const e of ctx.entrances()) {
      const d = haversineM(o, e)
      if (d < bestD) { bestD = d; best = e }
    }
    return best
  }

  function openNearest(extra: { focusNote?: boolean } = {}) {
    const e = nearest()
    openEditor(e ? { lat: e.lat, lon: e.lon } : ctx.origin(), { name: e?.name, ...extra })
  }

  function tile(label: string, name: string, onclick: () => void) {
    return h(
      'li',
      {},
      h('button', { class: 'ct-tile', type: 'button', onclick }, h('span', { class: 'ct-tile-icon' }, icon(name)), h('span', { class: 'ct-tile-label' }, label)),
    )
  }

  function profileBlock(total: number, onOpen: () => void) {
    const { level, next } = levelOf(total)
    const goal = next ?? total
    const pct = goal === 0 ? 100 : Math.min(100, Math.round((total / goal) * 100))
    const name = guideName()
    return h(
      'div',
      { class: 'ct-profile' },
      h(
        'button',
        { class: 'ct-profile-row', type: 'button', onclick: onOpen, 'aria-label': `${name}, ${L.guide(level)}. ${L.profile}` },
        h('span', { class: 'ct-avatar', 'aria-hidden': 'true' }, name.charAt(0).toUpperCase(), h('span', { class: 'ct-avatar-badge' }, icon('star'))),
        h('span', { class: 'ct-profile-text' }, h('span', { class: 'ct-profile-name' }, name), h('span', { class: 'ct-profile-level' }, L.guide(level))),
        h('span', { class: 'ct-profile-chev', 'aria-hidden': 'true' }, icon('chevron_right')),
      ),
      h(
        'div',
        { class: 'ct-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': goal, 'aria-valuenow': total, 'aria-label': `${fmt(total)} ${L.pointsOf(goal)}` },
        h('span', { style: `width:${pct}%` }),
      ),
      h('p', { class: 'ct-points', 'aria-hidden': 'true' }, h('strong', {}, fmt(total)), ` ${L.pointsOf(goal)}`),
    )
  }

  function badgeCard(count: number) {
    const done = Math.min(count, BADGE_GOAL)
    const headId = 'ct-badge-head'
    return h(
      'section',
      { class: 'ct-card ct-badge', 'aria-labelledby': headId },
      h(
        'div',
        { class: 'ct-badge-top' },
        h('div', {}, h('h3', { class: 'ct-badge-title', id: headId }, L.badgeHead), h('p', { class: 'ct-badge-sub' }, L.badgeSub)),
        h(
          'span',
          { class: `ct-hex${done >= BADGE_GOAL ? ' is-done' : ''}`, role: 'img', 'aria-label': done >= BADGE_GOAL ? L.badgeDone : L.badgeLocked },
          icon(done >= BADGE_GOAL ? 'workspace_premium' : 'lock'),
        ),
      ),
      h(
        'button',
        { class: 'ct-task', type: 'button', onclick: () => openEditor(ctx.origin()), 'aria-label': `${L.badgeTask}, ${done} / ${BADGE_GOAL}` },
        h('span', { class: 'ct-task-label' }, L.badgeTask),
        h('span', { class: 'ct-task-count' }, `${done}/${BADGE_GOAL}`),
        icon('chevron_right'),
      ),
    )
  }

  function statsCard(mine: SurveyEntrance[]) {
    const headId = 'ct-stats-head'
    const week = Date.now() - 7 * DAY
    const fresh = mine.filter((c) => Date.parse(c.createdAt) >= week).length
    return h(
      'section',
      { class: 'ct-stats', 'aria-labelledby': headId },
      h(
        'div',
        { class: 'ct-stats-head' },
        h('div', {}, h('h3', { class: 'ct-stats-title', id: headId }, L.statsHead), h('p', { class: 'ct-stats-num' }, fmt(mine.length))),
        fresh ? h('span', { class: 'ct-chip-new' }, L.fresh(fresh)) : null,
      ),
      stepChart(mine),
    )
  }

  function pointsCard(total: number, onOpen: () => void) {
    return h(
      'section',
      { class: 'ct-card ct-pts' },
      h('p', { class: 'ct-pts-pre' }, L.pointsCardPre),
      h('p', { class: 'ct-pts-num' }, L.pointsCard(total)),
      h('button', { class: 'ct-link', type: 'button', onclick: onOpen }, L.seeAll),
      pointsDeco(),
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

  function mineSection(mine: SurveyEntrance[]) {
    const headId = 'ct-mine-head'
    const o = ctx.origin()
    return h(
      'section',
      { class: 'ct-section', id: 'ct-mine', 'aria-labelledby': headId, tabindex: -1 },
      h('h3', { class: 'ct-h', id: headId }, L.mineHead),
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
    let list: SurveyEntrance[] = []
    try { list = loadSurvey() } catch { /* storage blocked: show empty state */ }
    const mine = list.filter((c) => c.by === 'community')
    const total = mine.reduce((sum, c) => sum + pointsFor(c), 0)
    const mineEl = mineSection(mine)
    const showMine = () => {
      ctx.setSheet('full')
      mineEl.scrollIntoView({ block: 'start', behavior: 'smooth' })
      mineEl.focus({ preventScroll: true })
    }
    el.replaceChildren(
      h(
        'div',
        { class: 'ct' },
        h('div', { class: 'gm-sheet-head' }, h('h2', { class: 'gm-sheet-title' }, L.title)),
        profileBlock(total, showMine),
        h(
          'ul',
          { class: 'ct-tiles' },
          tile(L.add, 'add_location_alt', () => openEditor(ctx.origin())),
          tile(L.update, 'edit_location_alt', () => openNearest()),
          tile(L.review, 'rate_review', () => openNearest({ focusNote: true })),
          tile(L.photo, 'add_a_photo', () => openEditor(ctx.origin(), { focusPhoto: true })),
          tile(L.record, 'route', () => ctx.openRecorder()),
        ),
        badgeCard(mine.length),
        nearbySection(ctx),
        statsCard(mine),
        pointsCard(total, showMine),
        mineEl,
      ),
    )
  }

  render()
  return () => {
    alive = false
    closeEditor()
  }
}
