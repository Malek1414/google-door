// Place sheet and place result list, drawn like the Google Maps iOS place sheet.
// Tier rules (docs/CONTRACT.md): Places accessibility data is building level (Tier 2) and
// never moves an arrow. Lived reviews are Tier 3: verbatim quotes with attribution, text only.
// Only a tier 1 entrance near the place unlocks the Start pill.

import './placecard.css'
import { haversineM } from '../core/geo'
import type { Entrance } from '../core/types'
import { fetchLived } from '../data'
import type { PlaceHit } from '../places'
import { lang } from '../strings'
import type { FeatureCtx } from './ctx'
import { h } from './dom'

const ENTRANCE_RADIUS_M = 60
const SAVED_KEY = 'doorway-saved-places'

type AccessKey = keyof PlaceHit['access']

const S = {
  de: {
    close: 'Schließen',
    save: 'Speichern',
    unsave: 'Nicht mehr speichern',
    share: 'Teilen',
    copied: 'Link kopiert.',
    route: 'Route',
    start: 'Start',
    open: 'Geöffnet',
    closed: 'Geschlossen',
    ratingLabel: (r: string, n: string) => `Bewertung ${r} von 5, ${n} Rezensionen`,
    ratingOnly: (r: string) => `Bewertung ${r} von 5`,
    tabOverview: 'Übersicht',
    tabReviews: 'Rezensionen',
    tabAccess: 'Barrierefreiheit',
    tipsTitle: 'Hilfreiche Tipps',
    newBadge: 'Neu!',
    tipsLoading: 'Erfahrungen werden geladen.',
    reviewsNone: 'Noch keine Erfahrungsberichte zur Barrierefreiheit.',
    reviewsError: 'Erfahrungsberichte konnten nicht geladen werden.',
    quoteSource: 'Zitat aus einer Google-Rezension, unverändert.',
    entrancesTitle: 'Eingänge dieses Orts',
    guide: 'Hinführen',
    stepFree: 'Stufenlos',
    notStepFree: 'Mit Stufen',
    unknown: 'Unbekannt',
    noEntrance: 'Kein genauer Eingang bekannt. Hilf mit: Eingang melden',
    accessTitle: 'Barrierefreiheit laut Google',
    accessNote: 'Diese Angaben gelten für das Gebäude, nicht für eine bestimmte Tür.',
    accessNoteDoor: (n: number) => (n === 1 ? 'Ein genau vermessener Eingang ist bekannt, siehe unten.' : `${n} genau vermessene Eingänge sind bekannt, siehe unten.`),
    accessNoteNoDoor: 'Welche Tür genau passt, ist unbekannt.',
    access: {
      entrance: 'Rollstuhlgerechter Eingang',
      restroom: 'Rollstuhlgerechtes WC',
      seating: 'Rollstuhlgerechte Sitzplätze',
      parking: 'Rollstuhlgerechter Parkplatz',
    } as Record<AccessKey, string>,
    yes: 'Ja',
    no: 'Nein',
    listNone: 'Keine Orte gefunden.',
    accessibleEntrance: 'Rollstuhlgerechter Eingang',
    photoAlt: (n: string) => `Foto von ${n}`,
  },
  en: {
    close: 'Close',
    save: 'Save',
    unsave: 'Remove from saved',
    share: 'Share',
    copied: 'Link copied.',
    route: 'Directions',
    start: 'Start',
    open: 'Open',
    closed: 'Closed',
    ratingLabel: (r: string, n: string) => `Rated ${r} out of 5, ${n} reviews`,
    ratingOnly: (r: string) => `Rated ${r} out of 5`,
    tabOverview: 'Overview',
    tabReviews: 'Reviews',
    tabAccess: 'Accessibility',
    tipsTitle: 'Helpful tips',
    newBadge: 'New!',
    tipsLoading: 'Loading experiences.',
    reviewsNone: 'No accessibility experiences yet.',
    reviewsError: 'Could not load experiences.',
    quoteSource: 'Quoted unchanged from a Google review.',
    entrancesTitle: 'Entrances of this place',
    guide: 'Guide me',
    stepFree: 'Step-free',
    notStepFree: 'Has steps',
    unknown: 'Unknown',
    noEntrance: 'No exact entrance known. Help out: report an entrance',
    accessTitle: 'Accessibility according to Google',
    accessNote: 'This applies to the building, not to a specific door.',
    accessNoteDoor: (n: number) => (n === 1 ? 'One surveyed entrance is known, see below.' : `${n} surveyed entrances are known, see below.`),
    accessNoteNoDoor: 'Which door exactly works is unknown.',
    access: {
      entrance: 'Wheelchair-accessible entrance',
      restroom: 'Wheelchair-accessible restroom',
      seating: 'Wheelchair-accessible seating',
      parking: 'Wheelchair-accessible parking',
    } as Record<AccessKey, string>,
    yes: 'Yes',
    no: 'No',
    listNone: 'No places found.',
    accessibleEntrance: 'Wheelchair-accessible entrance',
    photoAlt: (n: string) => `Photo of ${n}`,
  },
}
const L = lang === 'de' ? S.de : S.en
const locale = lang === 'de' ? 'de-DE' : 'en-US'

const icon = (name: string, filled = false) => h('span', { class: `ms${filled ? ' ms-fill' : ''}`, 'aria-hidden': 'true' }, name)
const roundIcon = (ic: string, label: string, onclick: () => void, extra = '') =>
  h('button', { class: `gm-circle ${extra}`, type: 'button', 'aria-label': label, onclick }, icon(ic, extra.includes('on')))

function fmtRating(r: number): string {
  return r.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}
function fmtCount(n: number): string {
  return n.toLocaleString(locale)
}
function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`
  return `${(m / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} km`
}

/** "4,8 ★★★★★ (204)" with one accessible label for the whole row. */
function ratingRow(p: PlaceHit): HTMLElement | null {
  if (typeof p.rating !== 'number') return null
  const r = fmtRating(p.rating)
  const label = typeof p.ratingCount === 'number' ? L.ratingLabel(r, fmtCount(p.ratingCount)) : L.ratingOnly(r)
  const stars = h('span', { class: 'pc-stars', 'aria-hidden': 'true' })
  for (let i = 1; i <= 5; i++) {
    const fill = p.rating >= i - 0.25 ? 'star' : p.rating >= i - 0.75 ? 'star_half' : 'star'
    const on = p.rating >= i - 0.75
    stars.append(h('span', { class: `ms${on ? ' ms-fill' : ''} pc-star${on ? '' : ' pc-star-off'}` }, fill))
  }
  return h(
    'span',
    { class: 'pc-rating', role: 'img', 'aria-label': label },
    h('span', { class: 'pc-rating-num', 'aria-hidden': 'true' }, r),
    stars,
    typeof p.ratingCount === 'number' ? h('span', { class: 'pc-rating-count', 'aria-hidden': 'true' }, `(${fmtCount(p.ratingCount)})`) : null,
  )
}

function openState(p: PlaceHit): HTMLElement | null {
  if (typeof p.openNow !== 'boolean') return null
  return h('span', { class: p.openNow ? 'pc-open' : 'pc-closed' }, p.openNow ? L.open : L.closed)
}

function readSaved(): string[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function writeSaved(ids: string[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(ids))
  } catch {
    /* storage blocked: saving is a convenience only */
  }
}

function tier1Near(ctx: FeatureCtx, p: PlaceHit): Entrance[] {
  return ctx
    .entrances()
    .filter((e) => e.tier === 1 && haversineM(e, p) <= ENTRANCE_RADIUS_M)
    .sort((a, b) => haversineM(a, p) - haversineM(b, p))
}

function stepFreeText(v: boolean | null): string {
  return v === true ? L.stepFree : v === false ? L.notStepFree : L.unknown
}

export function renderPlaceCard(el: HTMLElement, ctx: FeatureCtx, p: PlaceHit, onClose: () => void): () => void {
  let disposed = false
  const doors = tier1Near(ctx, p)
  const best = doors.find((e) => e.stepFree === true) ?? doors[0] ?? null

  const panTo = () => ctx.map?.panTo({ lat: p.lat, lng: p.lon })
  panTo()

  const share = async () => {
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}&query_place_id=${encodeURIComponent(p.placeId)}`
    try {
      if (navigator.share) await navigator.share({ title: p.name, url })
      else {
        await navigator.clipboard.writeText(url)
        ctx.announce(L.copied)
      }
    } catch {
      /* share sheet dismissed */
    }
  }

  // ---- title row ----
  const saveBtn = h('button', { class: 'gm-circle', type: 'button' })
  const paintSave = () => {
    const on = readSaved().includes(p.placeId)
    saveBtn.className = `gm-circle${on ? ' gm-circle-on' : ''}`
    saveBtn.setAttribute('aria-label', on ? L.unsave : L.save)
    saveBtn.setAttribute('aria-pressed', String(on))
    saveBtn.replaceChildren(icon('bookmark', on))
  }
  saveBtn.addEventListener('click', () => {
    const ids = readSaved()
    writeSaved(ids.includes(p.placeId) ? ids.filter((x) => x !== p.placeId) : [...ids, p.placeId])
    paintSave()
  })
  paintSave()
  const head = h(
    'div',
    { class: 'gm-card-title' },
    h('h2', { id: 'sheet-title', class: 'gm-sheet-title', tabindex: '-1' }, p.name),
    saveBtn,
    roundIcon('ios_share', L.share, () => void share()),
    roundIcon('close', L.close, onClose),
  )

  const metaBits: (Node | string)[] = []
  if (p.category) metaBits.push(p.category)
  const os = openState(p)
  if (os) {
    if (metaBits.length) metaBits.push(' · ')
    metaBits.push(os)
  }
  const meta = metaBits.length ? h('p', { class: 'gm-sheet-sub pc-meta' }, ...metaBits) : null

  // ---- pills ----
  const pills = h(
    'div',
    { class: 'gm-actions' },
    h(
      'button',
      {
        class: 'gm-pill gm-pill-primary',
        type: 'button',
        onclick: () => {
          ctx.setSheet('peek')
          panTo()
        },
      },
      icon('assistant_direction', true),
      L.route,
    ),
    best ? h('button', { class: 'gm-pill', type: 'button', onclick: () => ctx.openDoor(best) }, icon('navigation', true), L.start) : null,
    h('button', { class: 'gm-pill', type: 'button', onclick: () => void share() }, icon('ios_share'), L.share),
  )

  const photo = p.photoUrl
    ? h('div', { class: 'gm-photo' }, h('img', { class: 'pc-photo-img', src: p.photoUrl, alt: L.photoAlt(p.name), loading: 'lazy', referrerpolicy: 'no-referrer' }))
    : null

  // ---- lived quotes (Tier 3): verbatim, attributed, never paraphrased ----
  const tipsList = h('ul', { class: 'pc-quotes' })
  const tips = h(
    'section',
    { class: 'gm-tips pc-tips', 'aria-labelledby': 'pc-tips-h', hidden: true },
    h('div', { class: 'gm-tips-head' }, icon('auto_awesome', true), h('h3', { id: 'pc-tips-h' }, L.tipsTitle), h('span', { class: 'gm-new' }, L.newBadge)),
    tipsList,
    h('p', { class: 'pc-quote-src' }, L.quoteSource),
  )
  const reviewsOut = h('div', { class: 'pc-reviews', 'aria-live': 'polite', 'aria-busy': 'true' }, h('p', { class: 'gm-p' }, L.tipsLoading))

  const quoteEl = (quote: string, author: string) =>
    h('li', {}, h('blockquote', { class: 'pc-quote' }, h('p', {}, lang === 'de' ? `„${quote}“` : `“${quote}”`), h('footer', {}, author)))

  fetchLived(p.placeId)
    .then((claims) => {
      if (disposed) return
      reviewsOut.removeAttribute('aria-busy')
      if (!claims.length) {
        reviewsOut.replaceChildren(h('p', { class: 'gm-p' }, L.reviewsNone))
        return
      }
      tipsList.replaceChildren(...claims.slice(0, 3).map((c) => quoteEl(c.quote, c.author)))
      tips.hidden = false
      reviewsOut.replaceChildren(h('ul', { class: 'pc-quotes' }, ...claims.map((c) => quoteEl(c.quote, c.author))), h('p', { class: 'pc-quote-src' }, L.quoteSource))
    })
    .catch(() => {
      if (disposed) return
      reviewsOut.removeAttribute('aria-busy')
      reviewsOut.replaceChildren(h('p', { class: 'gm-p' }, L.reviewsError))
    })

  // ---- entrances of this place (Tier 1 only) ----
  const entrancesSection = () =>
    h(
      'section',
      { class: 'gm-section', 'aria-label': L.entrancesTitle },
      h('h3', { class: 'pc-h3' }, L.entrancesTitle),
      doors.length
        ? h(
            'ul',
            { class: 'gm-list pc-doors' },
            ...doors.map((e) =>
              h(
                'li',
                {},
                h(
                  'button',
                  { class: `gm-row door-${e.stepFree === true ? 'step-free' : 'not-step-free'}`, type: 'button', onclick: () => ctx.openDoor(e) },
                  h('span', { class: 'gm-row-shape', 'aria-hidden': 'true' }),
                  h(
                    'span',
                    { class: 'gm-row-text' },
                    h('span', { class: 'gm-row-title' }, e.name ?? p.name),
                    h('span', { class: 'gm-row-meta' }, `${stepFreeText(e.stepFree)} · ${fmtDistance(haversineM(ctx.origin(), e))}`),
                  ),
                  h('span', { class: 'pc-guide' }, L.guide),
                ),
              ),
            ),
          )
        : h('p', { class: 'gm-p' }, L.noEntrance),
    )

  // ---- accessibility (Tier 2, building level) ----
  const accessVal = (v: boolean | null) => (v === true ? L.yes : v === false ? L.no : L.unknown)
  const accessIcon = (v: boolean | null) => (v === true ? 'check_circle' : v === false ? 'cancel' : 'help')
  const accessPanelChildren = () => [
    h('h3', { class: 'pc-h3' }, L.accessTitle),
    h('p', { class: 'reason' }, `${L.accessNote} ${doors.length ? L.accessNoteDoor(doors.length) : L.accessNoteNoDoor}`),
    h(
      'ul',
      { class: 'gm-facts' },
      ...(['entrance', 'restroom', 'seating', 'parking'] as AccessKey[]).map((k) => {
        const v = p.access[k]
        return h(
          'li',
          { class: `gm-fact pc-access pc-access-${v === true ? 'yes' : v === false ? 'no' : 'unknown'}` },
          icon(accessIcon(v), v !== null),
          h('span', { class: 'pc-access-label' }, L.access[k]),
          h('span', { class: 'pc-access-val' }, accessVal(v)),
        )
      }),
    ),
    entrancesSection(),
  ]

  const overview = h(
    'div',
    { class: 'gm-tabpanel', role: 'tabpanel', id: 'pc-panel-0', 'aria-labelledby': 'pc-tab-0' },
    tips,
    p.address ? h('ul', { class: 'gm-facts' }, h('li', { class: 'gm-fact' }, icon('location_on'), h('span', {}, p.address))) : null,
    entrancesSection(),
  )
  const reviews = h('div', { class: 'gm-tabpanel', role: 'tabpanel', id: 'pc-panel-1', 'aria-labelledby': 'pc-tab-1', hidden: true }, reviewsOut)
  const access = h('div', { class: 'gm-tabpanel', role: 'tabpanel', id: 'pc-panel-2', 'aria-labelledby': 'pc-tab-2', hidden: true }, ...accessPanelChildren())
  const panels = [overview, reviews, access]

  const tabBtns: HTMLButtonElement[] = []
  const select = (i: number, focus = false) => {
    tabBtns.forEach((b, j) => {
      b.setAttribute('aria-selected', String(j === i))
      b.tabIndex = j === i ? 0 : -1
    })
    panels.forEach((pn, j) => (pn.hidden = j !== i))
    if (focus) tabBtns[i].focus()
  }
  const tabs = h(
    'div',
    { class: 'gm-tabs', role: 'tablist' },
    ...[L.tabOverview, L.tabReviews, L.tabAccess].map((label, i) => {
      const b = h('button', { class: 'gm-tabbtn', type: 'button', role: 'tab', id: `pc-tab-${i}`, 'aria-controls': `pc-panel-${i}`, 'aria-selected': String(i === 0), tabindex: i === 0 ? '0' : '-1' }, label)
      b.addEventListener('click', () => select(i))
      b.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowRight') select((i + 1) % 3, true)
        else if (ev.key === 'ArrowLeft') select((i + 2) % 3, true)
      })
      tabBtns.push(b)
      return b
    }),
  )

  const root = h('div', { class: 'pc-card' }, head, ratingRow(p), meta, pills, photo, tabs, ...panels)
  el.replaceChildren(root)
  el.scrollTop = 0
  head.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })

  return () => {
    disposed = true
    root.remove()
  }
}

export function renderPlaceList(el: HTMLElement, ctx: FeatureCtx, hits: PlaceHit[], title: string, onPick: (p: PlaceHit) => void): () => void {
  const origin = ctx.origin()
  const rows = hits.map((p) => {
    const sub: (Node | string)[] = []
    const catDist = [p.category, fmtDistance(haversineM(origin, p))].filter(Boolean).join(' · ')
    sub.push(catDist)
    const os = openState(p)
    return h(
      'li',
      {},
      h(
        'button',
        { class: 'gm-row pc-row', type: 'button', onclick: () => onPick(p) },
        h(
          'span',
          { class: 'gm-row-text' },
          h('span', { class: 'gm-row-title' }, p.name),
          ratingRow(p),
          h('span', { class: 'gm-row-meta' }, ...sub),
          os ? h('span', { class: 'gm-row-meta' }, os) : null,
        ),
        p.access.entrance === true
          ? h('span', { class: 'pc-a11y', role: 'img', 'aria-label': L.accessibleEntrance }, icon('accessible', true))
          : null,
      ),
    )
  })
  const root = h(
    'div',
    { class: 'pc-list' },
    h('div', { class: 'gm-sheet-head' }, h('h2', { id: 'sheet-title', class: 'gm-sheet-title', tabindex: '-1' }, title)),
    rows.length ? h('ul', { class: 'gm-list' }, ...rows) : h('p', { class: 'gm-empty' }, L.listNone),
  )
  el.replaceChildren(root)
  el.scrollTop = 0
  root.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  return () => root.remove()
}
