// "Erkunden" feed inside the bottom sheet, drawn like the Google Maps iOS explore sheet:
// "In dieser Gegend" photo carousel, "Alle ansehen" pill, nearby step-free doors and
// editorial accessibility tips. Places failures hide the place carousels silently; door
// content never depends on Places. Tier rule: only tier 1 entrances are listed as doors.

import './explore-feed.css'
import { haversineM } from '../core/geo'
import type { Entrance } from '../core/types'
import { searchCategory, type PlaceHit } from '../places'
import type { FeatureCtx } from './ctx'
import { glyphPaths, h, s } from './dom'

const MAX_PLACES = 10
const MAX_DOORS = 12

const TIPS: { title: string; body: string; tone: 'teal' | 'plum' }[] = [
  {
    title: 'Drehtür? Nach der Seitentür fragen',
    body: 'Neben fast jeder Drehtür gibt es eine Flügeltür oder einen Taster. Sie ist oft nicht beschildert, das Personal öffnet sie.',
    tone: 'teal',
  },
  {
    title: 'Rampe prüfen, bevor du losrollst',
    body: 'Mobile Rampen liegen oft drinnen. Klingel oder Anruf vorab spart das Warten vor der Stufe.',
    tone: 'plum',
  },
  {
    title: 'Aufzug außer Betrieb?',
    body: 'Bahnhofsaufzüge melden ihren Status live. Vor der Fahrt nachsehen und eine Station weiter einplanen.',
    tone: 'teal',
  },
]

function fmtDist(m: number): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`
  return `${(m / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} km`
}

function fmtRating(r: number): string {
  return r.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

function star(): SVGElement {
  return s(
    'svg',
    { class: 'gx-star', viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
    s('path', { d: 'M12 17.3l6.2 3.7-1.6-7 5.4-4.7-7.2-.6L12 2 9.2 8.7 2 9.3l5.4 4.7-1.6 7z', fill: 'currentColor' }),
  )
}

function chevron(): SVGElement {
  return s(
    'svg',
    { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    s('path', { d: 'M9 6l6 6-6 6', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  )
}

function placeCard(p: PlaceHit, distM: number, trending: boolean, onPick: () => void): HTMLElement {
  const bits: string[] = []
  const labelBits: string[] = [p.name]
  const meta = h('p', { class: 'gx-meta' })
  if (p.rating != null) {
    const r = fmtRating(p.rating)
    meta.append(h('span', { class: 'gx-rating' }, r), star())
    if (p.ratingCount != null) meta.append(h('span', {}, ` (${p.ratingCount.toLocaleString('de-DE')})`))
    labelBits.push(`Bewertung ${r} von 5${p.ratingCount != null ? `, ${p.ratingCount} Rezensionen` : ''}`)
  }
  if (p.category) bits.push(p.category)
  bits.push(fmtDist(distM))
  meta.append(h('span', {}, `${p.rating != null ? ' · ' : ''}${bits.join(' · ')}`))
  labelBits.push(...bits)

  let open: HTMLElement | null = null
  if (p.openNow === true) {
    open = h('p', { class: 'gx-open' }, 'Geöffnet')
    labelBits.push('Geöffnet')
  } else if (p.openNow === false) {
    open = h('p', { class: 'gx-closed' }, 'Geschlossen')
    labelBits.push('Geschlossen')
  }

  const photo = p.photoUrl
    ? h('img', { class: 'gx-photo', src: p.photoUrl, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' })
    : h('div', { class: 'gx-photo gx-photo--empty', 'aria-hidden': 'true' })

  return h(
    'li',
    { class: 'gx-item' },
    h(
      'button',
      { type: 'button', class: 'gx-place', 'aria-label': labelBits.join(', ') + (trending ? ', gerade angesagt' : ''), onclick: onPick },
      h('div', { class: 'gx-photo-wrap' }, photo, trending ? h('span', { class: 'gx-badge', 'aria-hidden': 'true' }, 'Gerade angesagt') : null),
      h('div', { class: 'gx-body', 'aria-hidden': 'true' }, h('p', { class: 'gx-name' }, p.name), meta, open),
    ),
  )
}

function doorCard(e: Entrance, distM: number, onPick: () => void): HTMLElement {
  const name = e.name || e.description || 'Eingang'
  const state = e.stepFree === true ? 'Stufenlos' : e.stepFree === false ? 'Mit Stufen' : 'Stufen unbekannt'
  const dist = fmtDist(distM)
  const tile = s('svg', { viewBox: '0 0 32 32', width: 28, height: 28, 'aria-hidden': 'true' }, ...glyphPaths('#000'))
  return h(
    'li',
    { class: 'gx-item' },
    h(
      'button',
      { type: 'button', class: 'gx-door', 'aria-label': `${name}, ${state}, ${dist}`, onclick: onPick },
      h('span', { class: 'gx-glyph', 'aria-hidden': 'true' }, tile),
      h(
        'span',
        { class: 'gx-door-text', 'aria-hidden': 'true' },
        h('span', { class: 'gx-door-name' }, name),
        h('span', { class: e.stepFree === true ? 'gx-door-meta gx-door-meta--ok' : 'gx-door-meta' }, `${state} · ${dist}`),
      ),
    ),
  )
}

function tipCard(t: (typeof TIPS)[number]): HTMLElement {
  return h(
    'li',
    { class: 'gx-item' },
    h(
      'article',
      { class: `gx-tip gx-tip--${t.tone}` },
      h('h3', { class: 'gx-tip-title' }, t.title),
      h('p', { class: 'gx-tip-src' }, h('span', { class: 'gx-tip-dot', 'aria-hidden': 'true' }), 'Doorway · Barrierefreiheit'),
      h('p', { class: 'gx-tip-body' }, t.body),
    ),
  )
}

function section(title: string, id: string, list: HTMLElement, extra?: HTMLElement): HTMLElement {
  return h(
    'section',
    { class: 'gx-section', 'aria-labelledby': id },
    h('h2', { class: 'gx-h', id }, title),
    list,
    extra ?? null,
  )
}

export function exploreFeed(
  el: HTMLElement,
  ctx: FeatureCtx,
  opts: { onPlace(p: PlaceHit): void; onDoor(e: Entrance): void; mode: 'standard' | 'access' },
): () => void {
  let alive = true
  const uid = Math.random().toString(36).slice(2, 8)
  const origin = ctx.origin()

  // Places block: header row keeps a slot for the caller's weather chip.
  const placeList = h('ul', { class: 'gx-carousel gx-carousel--places', 'aria-busy': 'true' })
  const allBtn = h('button', { type: 'button', class: 'gx-all' }, 'Alle ansehen', chevron())
  const placesHead = h('div', { class: 'gx-head' }, h('h2', { class: 'gx-h gx-h--lead', id: `gx-near-${uid}` }, 'In dieser Gegend'), h('div', { class: 'gm-weather' }))
  const placesSec = h('section', { class: 'gx-section', 'aria-labelledby': `gx-near-${uid}` }, placesHead, placeList, allBtn)

  // Doors: tier 1 only, step-free first, then by distance.
  const doors = ctx
    .entrances()
    .filter((e) => e.tier === 1 && Number.isFinite(e.lat) && Number.isFinite(e.lon))
    .map((e) => ({ e, d: haversineM(origin, e) }))
    .sort((a, b) => Number(b.e.stepFree === true) - Number(a.e.stepFree === true) || a.d - b.d)
    .slice(0, MAX_DOORS)
  const doorList = h('ul', { class: 'gx-carousel' })
  for (const { e, d } of doors) doorList.append(doorCard(e, d, () => opts.onDoor(e)))
  const doorSec = doors.length
    ? section('Barrierefreie Eingänge in der Nähe', `gx-doors-${uid}`, doorList)
    : section(
        'Barrierefreie Eingänge in der Nähe',
        `gx-doors-${uid}`,
        h('p', { class: 'gx-empty' }, 'Hier ist noch kein Eingang vermessen. Verschiebe die Karte oder melde einen Eingang.'),
      )

  const tipList = h('ul', { class: 'gx-carousel' })
  for (const t of TIPS) tipList.append(tipCard(t))
  const tipSec = section('Tipps für Barrierefreiheit', `gx-tips-${uid}`, tipList)

  const root = h('div', { class: 'gx-feed' })
  if (opts.mode === 'access') root.append(doorSec, placesSec, tipSec)
  else root.append(placesSec, doorSec, tipSec)
  el.append(root)

  let allHits: PlaceHit[] = []
  allBtn.addEventListener('click', () => {
    ctx.setSheet('full')
    const extra = allHits.slice(MAX_PLACES)
    if (!extra.length) return
    for (const p of extra) placeList.append(placeCard(p, haversineM(origin, p), false, () => opts.onPlace(p)))
    allBtn.hidden = true
    ctx.announce(`${allHits.length} Orte in dieser Gegend`)
  })

  if (!ctx.map) {
    placesSec.hidden = true
  } else {
    const map = ctx.map
    const safe = (id: string) => searchCategory(map, id).catch((): PlaceHit[] => [])
    void Promise.all([safe('restaurants'), safe('kaffee')]).then(([a, b]) => {
      if (!alive) return
      const seen = new Set<string>()
      const hits = [...a, ...b].filter((p) => (seen.has(p.placeId) ? false : (seen.add(p.placeId), true)))
      hits.sort((x, y) => (y.rating ?? 0) * Math.log10((y.ratingCount ?? 0) + 1) - (x.rating ?? 0) * Math.log10((x.ratingCount ?? 0) + 1))
      placeList.removeAttribute('aria-busy')
      if (!hits.length) {
        placesSec.hidden = true
        return
      }
      allHits = hits
      const top = hits.reduce((best, p) => ((p.rating ?? 0) > (best.rating ?? 0) ? p : best), hits[0])
      for (const p of hits.slice(0, MAX_PLACES)) {
        placeList.append(placeCard(p, haversineM(origin, p), p === top && top.rating != null, () => opts.onPlace(p)))
      }
    })
  }

  return () => {
    alive = false
    root.remove()
  }
}
