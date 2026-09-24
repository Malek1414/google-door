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
    tabPhotos: 'Fotos',
    call: 'Anrufen',
    closesAt: (t: string) => `Schließt um ${t}`,
    opensAt: (t: string) => `Öffnet um ${t}`,
    walkMin: (n: number) => `${n} min`,
    walkLabel: (n: number) => `${n} Minuten zu Fuß`,
    hours: 'Öffnungszeiten',
    address: 'Adresse',
    website: 'Website',
    phone: 'Telefon',
    suggestEdit: 'Änderung vorschlagen',
    photosNone: 'Keine Fotos vorhanden.',
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
    noEntrance: 'Kein genauer Eingang bekannt. Du kannst ihn unter „Beitragen“ melden.',
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
    tabPhotos: 'Photos',
    call: 'Call',
    closesAt: (t: string) => `Closes ${t}`,
    opensAt: (t: string) => `Opens ${t}`,
    walkMin: (n: number) => `${n} min`,
    walkLabel: (n: number) => `${n} minute walk`,
    hours: 'Opening hours',
    address: 'Address',
    website: 'Website',
    phone: 'Phone',
    suggestEdit: 'Suggest an edit',
    photosNone: 'No photos available.',
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
    noEntrance: 'No exact entrance known. You can report it under “Contribute”.',
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

/** Optional fields a richer PlaceHit may carry; read defensively, never required. */
type PlaceExtras = { photoUrls?: unknown; phone?: unknown; website?: unknown; closesAt?: unknown; opensAt?: unknown; hoursText?: unknown }
const extras = (p: PlaceHit) => p as PlaceHit & PlaceExtras
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function photoList(p: PlaceHit): string[] {
  const raw = extras(p).photoUrls
  const list = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u)) : []
  if (p.photoUrl && !list.includes(p.photoUrl)) list.unshift(p.photoUrl)
  return list
}
function phoneOf(p: PlaceHit): string | null {
  const v = str(extras(p).phone)
  return v && /^[+\d][\d\s()/-]{3,}$/.test(v) ? v : null
}
function websiteOf(p: PlaceHit): string | null {
  const v = str(extras(p).website)
  if (!v) return null
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}
/** "Geöffnet · Schließt um 19:00" when data allows, else null. */
function hoursLine(p: PlaceHit): HTMLElement | null {
  if (typeof p.openNow !== 'boolean') return null
  const t = p.openNow ? str(extras(p).closesAt) : str(extras(p).opensAt)
  const tail = t ? (p.openNow ? L.closesAt(t) : L.opensAt(t)) : null
  return h('p', { class: 'pc-hours' }, h('span', { class: p.openNow ? 'pc-open' : 'pc-closed' }, p.openNow ? L.open : L.closed), tail ? ` · ${tail}` : null)
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

export function renderPlaceCard(el: HTMLElement, ctx: FeatureCtx, p: PlaceHit, onClose: () => void, onSuggestEdit?: (p: PlaceHit) => void): () => void {
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

  const walk = Math.max(1, Math.ceil(haversineM(ctx.origin(), p) / 80))
  const metaBits: (Node | string)[] = []
  const rr = ratingRow(p)
  if (rr) metaBits.push(rr)
  metaBits.push(h('span', { 'aria-label': L.walkLabel(walk) }, h('span', { class: 'ms pc-walk', 'aria-hidden': 'true' }, 'directions_walk'), L.walkMin(walk)))
  const meta = h('p', { class: 'gm-sheet-sub pc-meta' })
  metaBits.forEach((b, i) => {
    if (i) meta.append(h('span', { class: 'pc-dot', 'aria-hidden': 'true' }, '·'))
    meta.append(b)
  })
  const hours = hoursLine(p)
  const phone = phoneOf(p)
  const website = websiteOf(p)

  // ---- pills ----
  const pills = h(
    'div',
    { class: 'gm-actions' },
    h(
      'button',
      {
        class: 'gm-pill gm-pill-primary',
        type: 'button',
        onclick: async (ev: Event) => {
          // This used to collapse the sheet and pan the map, which looked like
          // directions and computed none. Now it fetches the real walking route.
          const btn = ev.currentTarget as HTMLButtonElement
          btn.disabled = true
          btn.setAttribute('aria-busy', 'true')
          try {
            await ctx.showRoute({ lat: p.lat, lon: p.lon }, p.name || undefined)
          } finally {
            btn.disabled = false
            btn.removeAttribute('aria-busy')
          }
        },
      },
      icon('assistant_direction', true),
      L.route,
    ),
    best ? h('button', { class: 'gm-pill', type: 'button', onclick: () => ctx.openDoor(best) }, icon('navigation', true), L.start) : null,
    phone ? h('a', { class: 'gm-pill', href: `tel:${phone.replace(/[^+\d]/g, '')}` }, icon('call', true), L.call) : null,
    h('button', { class: 'gm-pill', type: 'button', onclick: () => void share() }, icon('ios_share'), L.share),
  )

  const photos = photoList(p)
  const img = (src: string, cls: string) => h('img', { class: `pc-photo-img ${cls}`, src, alt: L.photoAlt(p.name), loading: 'lazy', onerror: (ev: Event) => ((ev.target as HTMLElement).style.visibility = 'hidden') })
  const photo = photos.length
    ? h(
        'div',
        { class: `pc-strip${photos.length > 1 ? ' pc-strip-multi' : ''}` },
        h('div', { class: 'pc-strip-big' }, img(photos[0], '')),
        photos.length > 1 ? h('div', { class: 'pc-strip-col' }, ...photos.slice(1, 3).map((u) => h('div', { class: 'pc-strip-small' }, img(u, '')))) : null,
      )
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

  const infoRows = () => {
    const rows: HTMLElement[] = []
    const hoursTxt = str(extras(p).hoursText)
    if (hours || hoursTxt) rows.push(h('li', { class: 'gm-fact' }, icon('schedule'), h('span', { class: 'pc-fact-text' }, h('span', { class: 'sr-only' }, `${L.hours}: `), hours ? hours.cloneNode(true) : null, hoursTxt ? h('span', { class: 'pc-fact-sub' }, hoursTxt) : null)))
    if (p.address) rows.push(h('li', { class: 'gm-fact' }, icon('location_on'), h('span', { class: 'pc-fact-text' }, h('span', { class: 'sr-only' }, `${L.address}: `), p.address)))
    if (website) rows.push(h('li', { class: 'gm-fact' }, icon('public'), h('a', { class: 'pc-fact-link', href: website, target: '_blank', rel: 'noopener noreferrer' }, h('span', { class: 'sr-only' }, `${L.website}: `), new URL(website).hostname.replace(/^www\./, ''))))
    if (phone) rows.push(h('li', { class: 'gm-fact' }, icon('call'), h('a', { class: 'pc-fact-link', href: `tel:${phone.replace(/[^+\d]/g, '')}` }, h('span', { class: 'sr-only' }, `${L.phone}: `), phone)))
    return rows.length ? h('ul', { class: 'gm-facts' }, ...rows) : null
  }

  const overview = h(
    'div',
    { class: 'gm-tabpanel', role: 'tabpanel', id: 'pc-panel-0', 'aria-labelledby': 'pc-tab-0' },
    tips,
    infoRows(),
    entrancesSection(),
    onSuggestEdit
      ? h('div', { class: 'pc-suggest' }, h('button', { class: 'gm-pill', type: 'button', onclick: () => onSuggestEdit(p) }, icon('edit'), L.suggestEdit))
      : null,
  )
  const reviews = h('div', { class: 'gm-tabpanel', role: 'tabpanel', id: 'pc-panel-1', 'aria-labelledby': 'pc-tab-1', hidden: true }, reviewsOut)
  const photosPanel = h(
    'div',
    { class: 'gm-tabpanel', role: 'tabpanel', id: 'pc-panel-2', 'aria-labelledby': 'pc-tab-2', hidden: true },
    photos.length ? h('div', { class: 'pc-photo-grid' }, ...photos.map((u) => img(u, ''))) : h('p', { class: 'gm-p' }, L.photosNone),
  )
  const access = h('div', { class: 'gm-tabpanel', role: 'tabpanel', id: 'pc-panel-3', 'aria-labelledby': 'pc-tab-3', hidden: true }, ...accessPanelChildren())
  const panels = [overview, reviews, photosPanel, access]
  const n = panels.length

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
    ...[L.tabOverview, L.tabReviews, L.tabPhotos, L.tabAccess].map((label, i) => {
      const b = h('button', { class: 'gm-tabbtn', type: 'button', role: 'tab', id: `pc-tab-${i}`, 'aria-controls': `pc-panel-${i}`, 'aria-selected': String(i === 0), tabindex: i === 0 ? '0' : '-1' }, label)
      b.addEventListener('click', () => select(i))
      b.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowRight') select((i + 1) % n, true)
        else if (ev.key === 'ArrowLeft') select((i + n - 1) % n, true)
      })
      tabBtns.push(b)
      return b
    }),
  )

  // Maps gives the category its own grey line under the rating, not a slot in it.
  const category = p.category ? h('p', { class: 'pc-cat' }, p.category) : null
  const root = h('div', { class: 'pc-card' }, head, meta, category, hours, pills, photo, tabs, ...panels)
  el.replaceChildren(root)
  el.scrollTop = 0
  head.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })

  return () => {
    disposed = true
    root.remove()
  }
}

// Result filters like Google's chips above a result list. Remembered while the app is open,
// so an accessibility filter stays on from one category to the next.
const listFilters = { access: false, open: false, top: false }
const LF = {
  de: { access: 'Rollstuhlgerechter Eingang', open: 'Jetzt geöffnet', top: 'Top-bewertet', count: (n: number) => (n === 1 ? '1 Ort' : `${n} Orte`), none: 'Keine passenden Orte. Filter anpassen.', label: 'Ergebnisse filtern' },
  en: { access: 'Wheelchair accessible entrance', open: 'Open now', top: 'Top rated', count: (n: number) => (n === 1 ? '1 place' : `${n} places`), none: 'No matching places. Adjust the filters.', label: 'Filter results' },
}[lang === 'en' ? 'en' : 'de']

export function renderPlaceList(
  el: HTMLElement,
  ctx: FeatureCtx,
  hits: PlaceHit[],
  title: string,
  onPick: (p: PlaceHit) => void,
  onFilter?: (visible: PlaceHit[]) => void,
): () => void {
  const origin = ctx.origin()
  const row = (p: PlaceHit) => {
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
  }
  const visible = () =>
    hits.filter(
      (p) =>
        (!listFilters.access || p.access.entrance === true) &&
        (!listFilters.open || p.openNow === true) &&
        (!listFilters.top || (typeof p.rating === 'number' && p.rating >= 4.5)),
    )
  const list = h('div', {})
  const count = h('p', { class: 'gm-sheet-sub', 'aria-live': 'polite' })
  const draw = () => {
    const v = visible()
    count.textContent = LF.count(v.length)
    list.replaceChildren(v.length ? h('ul', { class: 'gm-list' }, ...v.map(row)) : h('p', { class: 'gm-empty' }, hits.length ? LF.none : L.listNone))
    onFilter?.(v)
  }
  const chip = (key: keyof typeof listFilters, ic: string, label: string) => {
    const b = h('button', { class: 'gm-chip', type: 'button', 'aria-pressed': String(listFilters[key]) }, icon(ic), label)
    b.addEventListener('click', () => {
      listFilters[key] = !listFilters[key]
      b.setAttribute('aria-pressed', String(listFilters[key]))
      draw()
    })
    return b
  }
  const root = h(
    'div',
    { class: 'pc-list' },
    h('div', { class: 'gm-sheet-head' }, h('h2', { id: 'sheet-title', class: 'gm-sheet-title', tabindex: '-1' }, title)),
    h('div', { class: 'gm-chips pc-filters', role: 'group', 'aria-label': LF.label },
      chip('access', 'accessible', LF.access),
      chip('open', 'schedule', LF.open),
      chip('top', 'star', LF.top),
    ),
    count,
    list,
  )
  draw()
  el.replaceChildren(root)
  el.scrollTop = 0
  root.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  return () => root.remove()
}
