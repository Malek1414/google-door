// Screen 3: a Google Maps style shell. Full-bleed map, floating search pill with the
// profile button, filter chips, my-location button and a draggable bottom sheet that holds
// the door list (the VoiceOver path and the fallback without a Maps key) or one door's card.
//
// Markers per BRIEF-APP:
//   tier 1 step-free      accessibility glyph, full opacity, +40% scale
//   tier 1 not step-free  muted, distinct shape (diamond)
//   tier 2                dashed ring at the building centroid, no door pin
//   tier 0 / 3            no marker; surfaced as text in the detail sheet

import { haversineM, type LatLon } from '../core/geo'
import type { Profile } from '../core/profile'
import { guidanceFor, markerKind, type ArrowTarget } from '../core/target'
import type { Building, Entrance } from '../core/types'
import { mapsKey } from '../config'
import { bboxAround, fetchEntrances, fetchLived, findEntrance, type BBox } from '../data'
import { announce } from '../session'
import { unlockAll } from './Start'
import type { FeatureCtx, Panel } from './ctx'
import { businessPanel } from './Business'
import { contributePanel } from './Contribute'
import { forYouPanel, rememberRecent } from './ForYou'
import { renderPlaceCard, renderPlaceList } from './PlaceCard'
import { fetchPlaceById } from '../places'
import { modeSwitch } from './ModeSwitch'
import { loadMode, saveMode, showDoorMarkers, type Mode } from '../core/mode'
import { loadSurvey, mergeSurvey } from '../core/survey'
import { NORMAL_CHIPS, PlacesUnavailable, searchCategory, searchText, type PlaceHit } from '../places'
import { lang } from '../strings'
import { openSearchScreen } from './SearchScreen'
import { exploreFeed } from './ExploreFeed'
import { t } from '../strings'
import { h, mount, s } from './dom'

const DEFAULT_CENTER: LatLon = { lat: 52.5251, lon: 13.3694 } // Berlin Hauptbahnhof
const BASE_PIN = 32
const NEARBY_UNKNOWN_M = 30
const LIST_MAX = 15
const SEARCH_MAX = 6

// ---- marker icons (SVG data URIs; no external assets) ----
const svgUrl = (svg: string) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
// Google Maps pin geometry with the Material Symbols "accessible" glyph, so the
// markers read as part of Maps rather than as something drawn on top of it.
// Blue is doing two jobs at once here: it is Material 3's primary AND the ISO 7001
// convention for the wheelchair symbol (white on blue). Shape still carries the
// meaning independently — pin for step-free, muted square-cut pin for steps — so a
// colour-blind user loses nothing.
const PIN_BODY = 'M20 2C12.8 2 7 7.8 7 15c0 9.2 13 23 13 23s13-13.8 13-23c0-7.2-5.8-13-13-13z'

// Material Symbols 'accessible', re-centred into the pin head (24x24 -> 20x20 @ 10,5).
const WHEELCHAIR =
  '<g transform="translate(10 5) scale(0.83)">' +
  '<circle cx="12" cy="4" r="2.1" fill="#fff"/>' +
  '<path d="M19 13.2v-2.1c-1.5.02-3-.73-3.95-1.78l-1.25-1.39a2.2 2.2 0 0 0-.6-.44h-.01A2.1 2.1 0 0 0 11.8 7.2 2.2 2.2 0 0 0 10 9.4V15a2 2 0 0 0 2 2h4.9v-2.05h-3.9v-3.3c1.25.97 3.07 1.42 3.88 1.41z" fill="#fff"/>' +
  '<path d="M12.8 18.2a3 3 0 1 1-3.8-3.82v-2.1a5.02 5.02 0 1 0 5.95 5.95z" fill="#fff"/>' +
  '</g>'

// A flight of steps, drawn the way Maps draws its own small pictograms.
const STAIRS =
  '<g transform="translate(11 7)">' +
  '<path d="M2 17h4v-4h4V9h4V5h4" fill="none" stroke="#fff" stroke-width="2.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"/>' +
  '</g>'

const pin = (fill: string, stroke: string, glyph: string) =>
  svgUrl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 42" width="40" height="42">' +
      '<filter id="d" x="-40%" y="-20%" width="180%" height="160%">' +
      '<feDropShadow dx="0" dy="1.5" stdDeviation="1.6" flood-color="#000" flood-opacity="0.45"/></filter>' +
      `<path d="${PIN_BODY}" fill="${fill}" stroke="${stroke}" stroke-width="2" filter="url(#d)"/>` +
      glyph +
      '</svg>',
  )

// Google Blue 600. Saturated on purpose: a pin sits on the map, not on a UI surface.
const ICON_STEP_FREE = pin('#1a73e8', '#ffffff', WHEELCHAIR)
// Neutral, never red — a door having steps is a fact, not an error.
const ICON_NOT_STEP_FREE = pin('#5f6368', '#dadce0', STAIRS)
const ICON_TIER2 = svgUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#000" stroke-width="5" stroke-dasharray="6 4"/><circle cx="20" cy="20" r="16" fill="none" stroke="#a8c7fa" stroke-width="2.5" stroke-dasharray="6 4"/></svg>',
)

let mapsLoading: Promise<void> | null = null
function loadMaps(key: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve()
  mapsLoading ??= new Promise<void>((resolve, reject) => {
    const cb = '__doorwayMapsReady'
    ;(window as unknown as Record<string, () => void>)[cb] = () => resolve()
    const sc = document.createElement('script')
    sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&callback=${cb}`
    sc.async = true
    sc.onerror = () => {
      mapsLoading = null
      reject(new Error('maps failed to load'))
    }
    document.head.append(sc)
  })
  return mapsLoading
}

export function stepFreeLabel(v: boolean | null): string {
  return v === true ? t.stepFreeYes : v === false ? t.stepFreeNo : t.stepFreeUnknown
}

const reasonText: Record<string, string> = {
  'not-tier1': t.reasonNotTier1,
  'not-step-free': t.reasonNotStepFree,
  'step-free-unknown': t.reasonStepFreeUnknown,
  'bad-coords': t.reasonBadCoords,
}

export function warningsBlock(e: Entrance): HTMLElement | null {
  if (!e.warnings.length) return null
  return h('div', { class: 'warning', role: 'note' }, ...e.warnings.map((w) => h('p', {}, h('strong', {}, `${t.warningPrefix}: `), t.warning[w] ?? w)))
}

type SheetState = 'peek' | 'half' | 'full'
type Filter = 'stepFree' | 'withSteps' | 'automatic' | 'noRevolving'
type Tab = 'explore' | 'saved' | 'contribute' | 'business'

const SAVED_KEY = 'doorway.saved'
const loadSaved = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
const storeSaved = (ids: string[]) => {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(ids))
  } catch {
    /* storage unavailable */
  }
}

/** Material Symbols glyph. Decorative: the text or aria-label next to it carries the meaning. */
const icon = (name: string, filled = false) => h('span', { class: `ms${filled ? ' ms-fill' : ''}`, 'aria-hidden': 'true' }, name)

/** Four-colour map pin in the search bar, drawn here (no logo asset). */
function pinLogo(): SVGElement {
  return s(
    'svg',
    { class: 'gm-logo', viewBox: '0 0 24 34', 'aria-hidden': 'true' },
    s('path', { d: 'M12 0C5.4 0 0 5.3 0 11.9c0 2.4.7 4.6 1.9 6.5L12 34l10.1-15.6c1.2-1.9 1.9-4.1 1.9-6.5C24 5.3 18.6 0 12 0z', fill: '#34a853' }),
    s('path', { d: 'M12 0C8.3 0 5 1.7 2.8 4.3l6 5A4.3 4.3 0 0 1 16 9.6l6.2-4.9C20 1.8 16.3 0 12 0z', fill: '#4285f4' }),
    s('path', { d: 'M2.8 4.3A11.8 11.8 0 0 0 0 11.9c0 2.4.7 4.6 1.9 6.5l6.9-9.1-6-5z', fill: '#ea4335' }),
    s('path', { d: 'M22.2 4.7L16 9.6c.3.7.4 1.5.2 2.3L22.1 18.4c1.2-1.9 1.9-4.1 1.9-6.5 0-2.7-.7-5.2-1.8-7.2z', fill: '#fbbc04' }),
    s('circle', { cx: 12, cy: 11.9, r: 4.3, fill: '#fff' }),
  )
}

export function MapView(opts: {
  profile: Profile
  openDoor?: string | null
  onGuide: (target: ArrowTarget) => void
  onSettings: () => void
  onContribute: () => void
}): () => void {
  let entrances: Entrance[] = []
  let buildings: Building[] = []
  let me: LatLon | null = null
  let map: google.maps.Map | null = null
  let markers: google.maps.Marker[] = []
  let meMarker: google.maps.Marker | null = null
  let routeLine: google.maps.Polyline | null = null
  let geoWatch: number | null = null
  let lastBox = ''
  let selected: Entrance | Building | null = null
  let opened = false
  let tab: Tab = 'explore'
  let saved = loadSaved()
  // A step-free profile starts with only step-free doors shown; the chips turn the rest on.
  const filters = new Set<Filter>(opts.profile.stepFreeRequired ? ['stepFree'] : [])
  let mode: Mode = loadMode()
  let panelCleanup: (() => void) | null = null
  let placeMarkers: google.maps.Marker[] = []
  let placeHits: PlaceHit[] = []
  let placeTitle = ''
  let activePlaceChip: string | null = null

  // ---- top: search bar, chips, layers ----
  const status = h('p', { class: 'gm-status', role: 'status' }, '')
  const mapEl = h('div', { class: 'gm-map', role: 'region', 'aria-label': t.mapTitle })
  const searchInput = h('input', { class: 'gm-search-input', type: 'search', placeholder: t.searchPlaceholder, 'aria-label': t.searchLabel, autocomplete: 'off', enterkeyhint: 'search' }) as HTMLInputElement
  const results = h('ul', { class: 'gm-results', role: 'listbox', 'aria-label': t.searchLabel, hidden: true })
  const micBtn = h('button', { class: 'gm-search-btn', type: 'button', 'aria-label': t.voiceSearch }, icon('mic'))
  const lensBtn = h('button', { class: 'gm-search-btn', type: 'button', 'aria-label': t.look }, icon('photo_camera'))
  const avatar = h('button', { class: 'gm-avatar', type: 'button', 'aria-label': t.profileButton, onclick: opts.onSettings }, 'S')
  const search = h('div', { class: 'gm-search' }, pinLogo(), searchInput, micBtn, lensBtn, avatar)

  const chipDefs: [Filter, string, string][] = [
    ['stepFree', 'accessible', t.chipStepFree],
    ['withSteps', 'stairs', t.chipWithSteps],
    ['automatic', 'door_sliding', t.chipAutomatic],
    ['noRevolving', 'block', t.chipNoRevolving],
  ]
  const accessChips = chipDefs.map(([key, ic, label]) => {
      const b = h('button', { class: 'gm-chip', type: 'button', 'aria-pressed': String(filters.has(key)) }, icon(ic), label)
      b.addEventListener('click', () => {
        if (filters.has(key)) filters.delete(key)
        else filters.add(key)
        b.setAttribute('aria-pressed', String(filters.has(key)))
        renderMarkers()
        renderSheet()
      })
      return b
    })
  const placeChips = NORMAL_CHIPS.map((c) => {
    const b = h('button', { class: 'gm-chip', type: 'button', 'aria-pressed': 'false', 'data-chip': c.id }, icon(c.icon), lang === 'de' ? c.labelDe : c.labelEn)
    b.addEventListener('click', () => void runCategory(c.id, lang === 'de' ? c.labelDe : c.labelEn))
    return b
  })
  const modeChip = modeSwitch(mode, (m) => {
    mode = m
    saveMode(m)
    clearPlaces()
    selected = null
    renderChips()
    renderMarkers()
    renderSheet()
    announce(m === 'access' ? t.modeOn : t.modeOff)
  })
  const chips = h('div', { class: 'gm-chips', role: 'group', 'aria-label': t.filterLabel })
  function renderChips() {
    chips.replaceChildren(modeChip, ...(mode === 'access' ? accessChips : placeChips))
    placeChips.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.chip === activePlaceChip)))
  }
  renderChips()
  const morePill = h('button', { class: 'gm-more', type: 'button', hidden: true, onclick: () => closeCard() }, t.moreDoors)
  const layersBtn = h('button', { class: 'gm-round gm-layers', type: 'button', 'aria-label': t.layers }, icon('layers'))

  // ---- right column above the sheet ----
  const locateBtn = h('button', { class: 'gm-round', type: 'button', 'aria-label': t.myLocation }, icon('near_me'))
  const goBtn = h('button', { class: 'gm-go', type: 'button', 'aria-label': t.nearestDoor }, icon('assistant_direction', true))
  const viewBtn = h('button', { class: 'gm-round gm-view', type: 'button', hidden: true }, icon('photo_camera'), h('span', {}, t.view))
  const rightCol = h('div', { class: 'gm-right' }, locateBtn, goBtn, viewBtn)

  // ---- sheet + nav ----
  const sheetBody = h('div', { class: 'gm-sheet-body' })
  const handle = h('button', { class: 'gm-handle', type: 'button', 'aria-label': t.sheetHandle }, h('span', { 'aria-hidden': 'true' }))
  const sheet = h('section', { class: 'gm-sheet', 'data-state': 'peek', 'aria-labelledby': 'sheet-title' }, handle, sheetBody)
  const navTab = (id: Tab | 'contribute', ic: string, label: string, dot = false) =>
    h('button', { class: 'gm-tab', type: 'button', 'data-tab': id, 'aria-current': id === tab ? 'page' : false }, h('span', { class: 'gm-tab-ic' }, icon(ic, id === tab), dot ? h('span', { class: 'gm-dot', 'aria-hidden': 'true' }) : null), h('span', {}, label))
  const nav = h(
    'nav',
    { class: 'gm-nav', 'aria-label': t.navLabel },
    navTab('explore', 'location_on', t.tabExplore),
    navTab('saved', 'bookmark', t.tabSaved, saved.length > 0),
    navTab('contribute', 'add_circle', t.tabContribute),
    navTab('business', 'storefront', t.tabBusiness),
  )
  nav.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('.gm-tab')
    if (!b) return
    const id = b.dataset.tab as Tab
    tab = id
    nav.querySelectorAll<HTMLButtonElement>('.gm-tab').forEach((x) => {
      const on = x.dataset.tab === tab
      x.toggleAttribute('aria-current', on)
      if (on) x.setAttribute('aria-current', 'page')
      x.querySelector('.ms')?.classList.toggle('ms-fill', on)
    })
    selected = null
    clearPlaces()
    renderMarkers()
    renderSheet()
    setSheet(tab === 'explore' ? 'peek' : 'full')
  })

  const root = h(
    'section',
    { class: 'gm', 'aria-labelledby': 'map-title' },
    h('h1', { id: 'map-title', class: 'sr-only' }, t.mapTitle),
    mapEl,
    h('div', { class: 'gm-top' }, search, results, chips, morePill, status),
    layersBtn,
    rightCol,
    sheet,
    nav,
  )
  mount(root)

  // ---- sheet snap states: drag or tap the handle ----
  const setSheet = (st: SheetState) => {
    sheet.dataset.state = st
    root.dataset.sheet = st
    sheet.style.removeProperty('--drag')
  }
  setSheet('peek')
  const featureCtx: FeatureCtx = {
    get map() {
      return map
    },
    entrances: () => entrances,
    buildings: () => buildings,
    origin: () => origin(),
    profile: opts.profile,
    openDoor: (e) => openEntrance(e),
    setSheet: (st) => setSheet(st),
    refresh: () => {
      lastBox = ''
      const bb = map?.getBounds()
      if (bb) void load({ south: bb.getSouthWest().lat(), west: bb.getSouthWest().lng(), north: bb.getNorthEast().lat(), east: bb.getNorthEast().lng() })
      else void load(bboxAround(origin().lat, origin().lon, 500))
    },
    openRecorder: () => {
      teardown()
      opts.onContribute()
    },
    announce: (text) => announce(text),
  }
  const order: SheetState[] = ['peek', 'half', 'full']
  // Sheet drag like Maps: the whole sheet follows the finger until it is fully open; only
  // then does its content scroll. Pulling down on content that is scrolled to the top moves
  // the sheet again. Horizontal swipes (carousels, chips) are left to the browser.
  let dragY0: number | null = null
  let dragX0 = 0
  let dragT0 = 0
  let dragging = false
  let decided = false
  const stateIdx = () => order.indexOf(sheet.dataset.state as SheetState)
  const snap = (dy: number, dt: number) => {
    const v = dy / Math.max(dt, 1) // px per ms, negative = up
    const i = stateIdx()
    let step = 0
    if (v < -0.5 || dy < -60) step = dy < -420 && i === 0 ? 2 : 1
    else if (v > 0.5 || dy > 60) step = dy > 420 && i === 2 ? -2 : -1
    setSheet(order[Math.max(0, Math.min(order.length - 1, i + step))])
  }
  sheet.addEventListener(
    'touchstart',
    (ev) => {
      const tt = ev.touches[0]
      dragY0 = tt.clientY
      dragX0 = tt.clientX
      dragT0 = performance.now()
      dragging = false
      decided = false
    },
    { passive: true },
  )
  sheet.addEventListener(
    'touchmove',
    (ev) => {
      if (dragY0 === null) return
      const tt = ev.touches[0]
      const dy = tt.clientY - dragY0
      const dx = tt.clientX - dragX0
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
        decided = true
        if (Math.abs(dx) > Math.abs(dy)) {
          dragY0 = null // horizontal: carousel or chips
          return
        }
        const full = sheet.dataset.state === 'full'
        const atTop = sheetBody.scrollTop <= 0
        // Not full: every vertical swipe moves the sheet. Full: only a pull-down at the top.
        dragging = !full || (dy > 0 && atTop)
      }
      if (!dragging) return
      ev.preventDefault()
      sheet.style.transition = 'none'
      sheet.style.setProperty('--drag', `${dy}px`)
    },
    { passive: false },
  )
  const endDrag = (ev: TouchEvent) => {
    if (dragY0 === null) return
    const tt = ev.changedTouches[0]
    const dy = tt.clientY - dragY0
    dragY0 = null
    sheet.style.transition = ''
    if (dragging) snap(dy, performance.now() - dragT0)
    // A plain tap on the handle cycles peek, half, full.
    else if (!decided && handle.contains(ev.target as Node)) setSheet(stateIdx() === order.length - 1 ? 'peek' : order[stateIdx() + 1])
    dragging = false
  }
  sheet.addEventListener('touchend', endDrag)
  sheet.addEventListener('touchcancel', endDrag)

  // Mouse / pen on the handle (desktop preview), tap on the handle cycles the states.
  let mouseY0: number | null = null
  handle.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'touch') return
    mouseY0 = ev.clientY
    dragT0 = performance.now()
    handle.setPointerCapture(ev.pointerId)
  })
  handle.addEventListener('pointermove', (ev) => {
    if (mouseY0 === null) return
    sheet.style.setProperty('--drag', `${ev.clientY - mouseY0}px`)
  })
  handle.addEventListener('pointerup', (ev) => {
    if (mouseY0 === null) return
    const dy = ev.clientY - mouseY0
    mouseY0 = null
    if (Math.abs(dy) < 6) setSheet(stateIdx() === order.length - 1 ? 'peek' : order[stateIdx() + 1])
    else snap(dy, performance.now() - dragT0)
  })
  handle.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    const i = order.indexOf(sheet.dataset.state as SheetState)
    setSheet(i === order.length - 1 ? 'peek' : order[i + 1])
  })

  const origin = () => me ?? (map?.getCenter() ? { lat: map.getCenter()!.lat(), lon: map.getCenter()!.lng() } : DEFAULT_CENTER)
  const visible = (e: Entrance) => {
    const k = markerKind(e)
    if (k === 'no-marker') return false
    if (filters.has('stepFree') && !filters.has('withSteps') && k !== 'step-free') return false
    if (filters.has('withSteps') && !filters.has('stepFree') && k !== 'not-step-free') return false
    if (filters.has('automatic') && !e.automatic) return false
    if (filters.has('noRevolving') && (e.door === 'revolving' || e.warnings.includes('revolving'))) return false
    return true
  }
  const nearby = () =>
    entrances
      .filter(visible)
      .map((e) => ({ e, d: haversineM(origin(), e) }))
      .sort((a, b) => a.d - b.d)

  async function load(b: BBox) {
    const key = [b.south, b.west, b.north, b.east].map((x) => x.toFixed(4)).join(',')
    if (key === lastBox) return
    lastBox = key
    try {
      const r = await fetchEntrances(b)
      let survey: ReturnType<typeof loadSurvey> = []
      try {
        survey = loadSurvey()
      } catch {
        survey = []
      }
      entrances = mergeSurvey(r.entrances, survey)
      buildings = r.buildings
      status.textContent = r.source === 'static' ? t.offlineData : ''
      renderMarkers()
      const want = opts.openDoor ? entrances.find((x) => x.id === opts.openDoor) : undefined
      if (want && !opened) {
        opened = true
        openEntrance(want)
      } else if (!selected) renderSheet()
    } catch {
      status.textContent = t.noDoors
    }
  }

  // ---- sheet content per tab ----
  function doorRow(e: Entrance, d: number) {
    const meta = [stepFreeLabel(e.stepFree), t.metresShort(d), ...e.warnings.map((w) => t.door[w] ?? w)].join(' · ')
    return h(
      'li',
      {},
      h(
        'button',
        { class: `gm-row door-${markerKind(e)}`, type: 'button', onclick: () => openEntrance(e) },
        h('span', { class: 'gm-row-shape', 'aria-hidden': 'true' }),
        h('span', { class: 'gm-row-text' }, h('span', { class: 'gm-row-title' }, e.name ?? t.unnamedEntrance), h('span', { class: 'gm-row-meta' }, meta)),
      ),
    )
  }

  function mountPanel(panel: Panel) {
    panelCleanup?.()
    panelCleanup = null
    try {
      panelCleanup = panel(sheetBody, featureCtx)
    } catch (err) {
      console.error('[doorway] panel failed', err)
      sheetBody.replaceChildren(h('p', { class: 'gm-p', role: 'alert' }, t.panelError))
    }
  }

  function renderSheet() {
    if (selected) return
    panelCleanup?.()
    panelCleanup = null
    morePill.hidden = true
    chips.hidden = false
    viewBtn.hidden = true
    goBtn.hidden = false
    if (tab === 'saved') return mountPanel(forYouPanel)
    if (tab === 'contribute') return mountPanel(contributePanel)
    if (tab === 'business') return mountPanel(businessPanel)
    if (placeHits.length) {
      panelCleanup = renderPlaceList(sheetBody, featureCtx, placeHits, placeTitle, (p) => openPlace(p))
      return
    }
    if (!showDoorMarkers(mode)) {
      // Pulled-up Erkunden sheet like Maps: photo cards, entrances nearby, tips.
      try {
        panelCleanup = exploreFeed(sheetBody, featureCtx, { onPlace: (p) => openPlace(p), onDoor: (e) => openEntrance(e), mode })
        const slot = sheetBody.querySelector('.gm-weather')
        if (slot) slot.replaceWith(weatherChip())
        else sheetBody.querySelector('.gm-sheet-head')?.append(weatherChip())
      } catch (err) {
        console.error('[doorway] explore feed failed', err)
        sheetBody.replaceChildren(
          h('div', { class: 'gm-sheet-head' }, h('h2', { id: 'sheet-title', class: 'gm-sheet-title' }, t.inThisArea), weatherChip()),
          h('p', { class: 'gm-p' }, t.standardHint),
        )
      }
      return
    }
    const doors = nearby()
    const stepFreeCount = doors.filter(({ e }) => e.stepFree === true).length
    sheetBody.replaceChildren(
      h(
        'div',
        { class: 'gm-sheet-head' },
        h('h2', { id: 'sheet-title', class: 'gm-sheet-title' }, t.inThisArea),
        h('span', { class: 'gm-badge', title: t.doorsCount(doors.length) }, icon('accessible'), h('span', {}, String(stepFreeCount)), h('span', { class: 'sr-only' }, t.doorsCount(doors.length))),
      ),
      h('ul', { class: 'gm-list' }, ...(doors.length ? doors.slice(0, LIST_MAX).map(({ e, d }) => doorRow(e, d)) : [h('li', { class: 'gm-empty' }, t.noDoors)])),
    )
  }

  // Weather chip like Maps' "In dieser Gegend": real current temperature from Open-Meteo
  // (free, no key). Fetched at most every 10 minutes; hidden when it cannot be loaded.
  let weather: { temp: number; icon: string; at: number } | null = null
  function weatherChip(): HTMLElement {
    const chip = h('span', { class: 'gm-badge gm-weather', hidden: true })
    const fill = () => {
      if (!weather) return
      chip.replaceChildren(icon(weather.icon), h('span', {}, `${Math.round(weather.temp)}°`))
      chip.setAttribute('aria-label', `${Math.round(weather.temp)} Grad`)
      chip.hidden = false
    }
    if (weather && Date.now() - weather.at < 600000) fill()
    else {
      const o = origin()
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${o.lat.toFixed(3)}&longitude=${o.lon.toFixed(3)}&current=temperature_2m,weather_code`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const c = j?.current
          if (!c || typeof c.temperature_2m !== 'number') return
          const code = Number(c.weather_code)
          const ic = code === 0 ? 'clear_day' : code <= 3 ? 'partly_cloudy_day' : code <= 48 ? 'foggy' : code <= 67 ? 'rainy' : code <= 77 ? 'weather_snowy' : code <= 82 ? 'rainy' : 'thunderstorm'
          weather = { temp: c.temperature_2m, icon: ic, at: Date.now() }
          fill()
        })
        .catch(() => {})
    }
    return chip
  }

  function renderMarkers() {
    if (!map) return
    markers.forEach((m) => m.setMap(null))
    markers = []
    for (const e of entrances) {
      if ((!visible(e) || !showDoorMarkers(mode)) && selected !== e) continue
      const big = markerKind(e) === 'step-free'
      const size = (big ? BASE_PIN * 1.4 : BASE_PIN) * (selected === e ? 1.25 : 1)
      const m = new google.maps.Marker({
        map,
        position: { lat: e.lat, lng: e.lon },
        title: `${e.name ?? t.unnamedEntrance}, ${stepFreeLabel(e.stepFree)}`,
        // 40x42 artwork: anchor at the pin TIP, not its centre, or every door sits
        // half a pin north of where it actually is.
        icon: {
          url: big ? ICON_STEP_FREE : ICON_NOT_STEP_FREE,
          scaledSize: new google.maps.Size(size, size * (42 / 40)),
          anchor: new google.maps.Point(size / 2, size * (42 / 40)),
        },
        zIndex: selected === e ? 3 : big ? 2 : 1,
        opacity: big ? 1 : 0.85,
      })
      m.addListener('click', () => openEntrance(e))
      markers.push(m)
    }
    for (const b of buildings) {
      if (b.accessSummary.tier !== 2) continue
      const m = new google.maps.Marker({
        map,
        position: { lat: b.centroid[0], lng: b.centroid[1] },
        title: `${b.name ?? b.addr ?? ''} ${t.buildingReported}`.trim(),
        icon: { url: ICON_TIER2, scaledSize: new google.maps.Size(40, 40), anchor: new google.maps.Point(20, 20) },
        zIndex: 0,
      })
      m.addListener('click', () => openBuilding(b))
      markers.push(m)
    }
  }

  // ---- place card ----
  const roundIcon = (ic: string, label: string, onclick: () => void, extra = '') => h('button', { class: `gm-circle ${extra}`, type: 'button', 'aria-label': label, onclick }, icon(ic, extra.includes('on')))

  function cardHead(title: string, e: Entrance | null) {
    const isSaved = !!e && saved.includes(e.id)
    const save = e
      ? roundIcon('bookmark', isSaved ? t.unsave : t.save, () => {
          saved = isSaved ? saved.filter((x) => x !== e.id) : [...saved, e.id]
          storeSaved(saved)
          nav.querySelector('[data-tab="saved"] .gm-tab-ic')?.replaceChildren(icon('bookmark', tab === 'saved'), ...(saved.length ? [h('span', { class: 'gm-dot', 'aria-hidden': 'true' })] : []))
          openEntrance(e)
        }, isSaved ? 'gm-circle-on' : '')
      : null
    return h(
      'div',
      { class: 'gm-card-title' },
      h('h2', { id: 'sheet-title', class: 'gm-sheet-title', tabindex: '-1' }, title),
      save,
      e ? roundIcon('ios_share', t.share, () => void share(e)) : null,
      roundIcon('close', t.close, closeCard),
    )
  }

  async function share(e: Entrance) {
    const url = `${location.origin}${location.pathname}?door=${encodeURIComponent(e.id)}`
    try {
      if (navigator.share) await navigator.share({ title: e.name ?? t.unnamedEntrance, url })
      else {
        await navigator.clipboard.writeText(url)
        announce(t.copied)
      }
    } catch {
      /* share sheet dismissed */
    }
  }

  function showCard(item: Entrance | Building, ...children: (Node | null)[]) {
    panelCleanup?.()
    panelCleanup = null
    selected = item
    renderMarkers()
    chips.hidden = true
    morePill.hidden = false
    goBtn.hidden = true
    sheetBody.replaceChildren(...children.filter((c): c is Node => c !== null))
    setSheet('half')
    sheetBody.scrollTop = 0
    sheetBody.querySelector<HTMLElement>('h2')?.focus()
  }
  function closeCard() {
    panelCleanup?.()
    panelCleanup = null
    selected = null
    routeLine?.setMap(null)
    routeLine = null
    renderMarkers()
    renderSheet()
    setSheet('peek')
  }

  function drawRoute(e: Entrance) {
    if (!map) return
    const from = origin()
    routeLine?.setMap(null)
    routeLine = new google.maps.Polyline({
      map,
      path: [{ lat: from.lat, lng: from.lon }, { lat: e.lat, lng: e.lon }],
      strokeOpacity: 0,
      icons: [{ icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: '#62c4cb', fillOpacity: 1, strokeColor: '#00363a', strokeWeight: 1.5, scale: 4 }, offset: '0', repeat: '14px' }],
    })
    const bounds = new google.maps.LatLngBounds()
    bounds.extend({ lat: from.lat, lng: from.lon })
    bounds.extend({ lat: e.lat, lng: e.lon })
    map.fitBounds(bounds, { top: 140, bottom: 260, left: 40, right: 40 })
    setSheet('peek')
    announce(`${t.metres(haversineM(from, e))}. ${e.name ?? t.unnamedEntrance}`)
  }

  function streetView(e: Entrance): HTMLElement | null {
    if (!map) return null
    const box = h('div', { class: 'gm-photo', role: 'img', 'aria-label': t.streetViewAlt })
    new google.maps.StreetViewService().getPanorama({ location: { lat: e.lat, lng: e.lon }, radius: 40 }, (data, st) => {
      if (st !== google.maps.StreetViewStatus.OK || !data?.location?.latLng) {
        box.remove()
        return
      }
      const from = data.location.latLng
      const heading = google.maps.geometry?.spherical ? google.maps.geometry.spherical.computeHeading(from, { lat: e.lat, lng: e.lon }) : bearingFromTo(from.lat(), from.lng(), e.lat, e.lon)
      new google.maps.StreetViewPanorama(box, { pano: data.location.pano, pov: { heading, pitch: 5 }, disableDefaultUI: true, clickToGo: false, linksControl: false, motionTracking: false })
    })
    return box
  }

  function tipsCard(e: Entrance): HTMLElement {
    const tips: string[] = []
    if (e.stepFree === true) tips.push(t.tipStepFree)
    if (e.stepFree === false) tips.push(t.tipNotStepFree)
    if (e.door) tips.push(`${t.door[e.door] ?? e.door}${e.automatic ? `, ${t.automatic}` : ''}.`)
    for (const w of e.warnings) tips.push(t.warning[w] ?? w)
    if (e.approachBearing !== null) tips.push(t.faceToEnter(t.compass[Math.round(e.approachBearing / 45) % 8]))
    if (e.description) tips.unshift(e.description)
    return h(
      'div',
      { class: 'gm-tips' },
      h('div', { class: 'gm-tips-head' }, icon('auto_awesome', true), h('h3', {}, t.tipsTitle), h('span', { class: 'gm-new' }, t.newBadge)),
      h('ul', {}, ...tips.slice(0, 4).map((x) => h('li', {}, x))),
    )
  }

  function fact(ic: string, value: string) {
    return h('li', { class: 'gm-fact' }, icon(ic), h('span', {}, value))
  }

  function openEntrance(e: Entrance) {
    try {
      rememberRecent(e.id)
    } catch {
      /* storage unavailable */
    }
    const g = guidanceFor(e, opts.profile)
    const b = e.buildingId ? buildings.find((x) => x.id === e.buildingId) : undefined
    const unknownNearby = entrances.filter((x) => x.id !== e.id && x.tier === 0 && haversineM(x, e) <= NEARBY_UNKNOWN_M).length
    map?.panTo({ lat: e.lat, lng: e.lon })

    const start = async () => {
      if (g.kind !== 'arrow') return
      // The Start pill is the one gesture that unlocks compass, camera and sound.
      // unlockAll must be the first await so iOS still sees the tap.
      await unlockAll({ camera: true })
      teardown()
      opts.onGuide(g.target)
    }
    viewBtn.hidden = g.kind !== 'arrow'
    viewBtn.onclick = () => void start()

    const pills = h(
      'div',
      { class: 'gm-actions' },
      h('button', { class: 'gm-pill gm-pill-primary', type: 'button', onclick: () => drawRoute(e) }, icon('assistant_direction', true), t.route),
      g.kind === 'arrow' ? h('button', { class: 'gm-pill', type: 'button', onclick: () => void start() }, icon('navigation', true), t.guideMe) : null,
      h('button', { class: 'gm-pill', type: 'button', onclick: () => void share(e) }, icon('ios_share'), t.share),
    )

    const overview = h(
      'div',
      { class: 'gm-tabpanel' },
      tipsCard(e),
      g.kind === 'arrow' ? null : h('p', { class: 'reason' }, reasonText[g.reason]),
      warningsBlock(e),
      h(
        'ul',
        { class: 'gm-facts' },
        fact('accessible', stepFreeLabel(e.stepFree)),
        e.door ? fact('door_front', `${t.door[e.door] ?? e.door}${e.automatic ? `, ${t.automatic}` : ''}`) : null,
        e.level !== null ? fact('stairs', `${t.levelLabel} ${e.level}`) : null,
        e.approachBearing !== null ? fact('explore', t.faceToEnter(t.compass[Math.round(e.approachBearing / 45) % 8])) : null,
        fact('verified', t.confidence[e.confidence] ?? e.confidence),
      ),
      unknownNearby ? h('p', { class: 'gm-p' }, t.nearbyUnknown(unknownNearby)) : null,
    )
    const reviews = h('div', { class: 'gm-tabpanel', hidden: true }, livedSection(b) ?? h('p', { class: 'gm-p' }, t.livedNone))
    const photos = h('div', { class: 'gm-tabpanel', hidden: true })
    const panels = [overview, reviews, photos]
    const tabs = h(
      'div',
      { class: 'gm-tabs', role: 'tablist' },
      ...[t.tabOverview, t.tabReviews, t.tabPhotos].map((label, i) => {
        const b2 = h('button', { class: 'gm-tabbtn', type: 'button', role: 'tab', 'aria-selected': String(i === 0) }, label)
        b2.addEventListener('click', () => {
          tabs.querySelectorAll('.gm-tabbtn').forEach((x, j) => x.setAttribute('aria-selected', String(j === i)))
          panels.forEach((p, j) => (p.hidden = j !== i))
          if (i === 2 && !photos.childElementCount) {
            const sv = streetView(e)
            photos.append(sv ?? h('p', { class: 'gm-p' }, t.noPhotos))
          }
        })
        return b2
      }),
    )

    showCard(e, cardHead(e.name ?? t.unnamedEntrance, e), h('p', { class: 'gm-sheet-sub' }, [stepFreeLabel(e.stepFree), t.metresShort(haversineM(origin(), e)), b?.name ?? b?.addr ?? null].filter(Boolean).join(' · ')), pills, streetView(e), tabs, ...panels)
  }

  function openBuilding(b: Building) {
    map?.panTo({ lat: b.centroid[0], lng: b.centroid[1] })
    viewBtn.hidden = true
    showCard(
      b,
      cardHead(b.name ?? b.addr ?? t.unnamedEntrance, null),
      b.addr ? h('p', { class: 'gm-sheet-sub' }, b.addr) : null,
      h('p', { class: 'gm-p' }, t.buildingReported),
      h('p', { class: 'reason' }, t.reasonNotTier1),
      livedSection(b),
    )
  }

  function livedSection(b: Building | undefined): HTMLElement | null {
    if (!b?.placeId) return null
    const out = h('div', { class: 'lived', 'aria-live': 'polite' })
    const btn = h('button', { class: 'gm-pill', type: 'button' }, icon('reviews'), t.livedButton)
    btn.addEventListener('click', async () => {
      btn.setAttribute('aria-busy', 'true')
      try {
        const claims = await fetchLived(b.placeId!)
        // Tier 3 is text only: verbatim quote + attribution, never a position.
        out.replaceChildren(...(claims.length ? claims.map((c) => h('blockquote', {}, h('p', {}, c.quote), h('footer', {}, c.author))) : [h('p', {}, t.livedNone)]))
      } catch {
        out.replaceChildren(h('p', {}, t.livedError))
      } finally {
        btn.removeAttribute('aria-busy')
      }
    })
    return h('div', { class: 'gm-section' }, btn, out)
  }

  // ---- Google places (standard mode chips, text search) ----
  function clearPlaces() {
    placeMarkers.forEach((m) => m.setMap(null))
    placeMarkers = []
    placeHits = []
    activePlaceChip = null
    placeChips.forEach((b) => b.setAttribute('aria-pressed', 'false'))
  }
  function showPlaces(hits: PlaceHit[], title: string) {
    placeMarkers.forEach((m) => m.setMap(null))
    placeMarkers = []
    placeHits = hits
    placeTitle = title
    if (map) {
      const bounds = new google.maps.LatLngBounds()
      for (const p of hits) {
        const m = new google.maps.Marker({ map, position: { lat: p.lat, lng: p.lon }, title: p.name, zIndex: 5 })
        m.addListener('click', () => openPlace(p))
        placeMarkers.push(m)
        bounds.extend({ lat: p.lat, lng: p.lon })
      }
      if (hits.length > 1) map.fitBounds(bounds, { top: 170, bottom: 280, left: 30, right: 30 })
    }
    selected = null
    renderSheet()
    setSheet('half')
  }
  /** Tapping a Google POI gives only an id, so fetch the details then open the card. */
  async function openPlaceById(placeId: string) {
    status.textContent = t.loading ?? 'Lädt …'
    try {
      const hit = await fetchPlaceById(placeId)
      status.textContent = ''
      if (hit) openPlace(hit)
    } catch (err) {
      status.textContent = ''
      console.warn('[doorway] place lookup failed', err)
    }
  }

  function openPlace(p: PlaceHit) {
    selected = null
    panelCleanup?.()
    chips.hidden = true
    morePill.hidden = false
    goBtn.hidden = true
    map?.panTo({ lat: p.lat, lng: p.lon })
    panelCleanup = null
    try {
      panelCleanup = renderPlaceCard(sheetBody, featureCtx, p, () => {
        chips.hidden = false
        morePill.hidden = true
        goBtn.hidden = false
        renderSheet()
      })
    } catch (err) {
      console.error('[doorway] place card failed', err)
      sheetBody.replaceChildren(h('p', { class: 'gm-p', role: 'alert' }, t.panelError))
    }
    setSheet('half')
  }
  async function runCategory(id: string, label: string) {
    if (!map) return
    if (activePlaceChip === id) {
      clearPlaces()
      renderSheet()
      return
    }
    activePlaceChip = id
    placeChips.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.chip === id)))
    status.textContent = t.loading
    try {
      const hits = await searchCategory(map, id)
      status.textContent = hits.length ? '' : t.searchNoResults
      showPlaces(hits, label)
    } catch (err) {
      activePlaceChip = null
      placeChips.forEach((b) => b.setAttribute('aria-pressed', 'false'))
      status.textContent = err instanceof PlacesUnavailable ? err.message : t.placesError
    }
  }

  // ---- search: known places plus named doors in the loaded data, no Places API needed ----
  function flyTo(lat: number, lon: number) {
    if (map) {
      map.panTo({ lat, lng: lon })
      map.setZoom(18)
    } else void load(bboxAround(lat, lon, 500))
  }
  function renderResults() {
    const q = searchInput.value.trim().toLowerCase()
    if (!q) {
      results.hidden = true
      return
    }
    const placeHits = t.places.filter((p) => p.name.toLowerCase().includes(q)).map((p) => ({ title: p.name, sub: p.sub, go: () => flyTo(p.lat, p.lon), ic: 'location_on' }))
    const doorHits = entrances
      .filter((e) => e.name && e.name.toLowerCase().includes(q) && markerKind(e) !== 'no-marker')
      .map((e) => ({ title: e.name!, sub: stepFreeLabel(e.stepFree), go: () => openEntrance(e), ic: 'door_front' }))
    const hits = [...placeHits, ...doorHits].slice(0, SEARCH_MAX)
    results.replaceChildren(
      ...(hits.length
        ? hits.map((r) =>
            h(
              'li',
              { role: 'option' },
              h(
                'button',
                {
                  class: 'gm-result',
                  type: 'button',
                  onclick: () => {
                    searchInput.value = r.title
                    results.hidden = true
                    searchInput.blur()
                    r.go()
                  },
                },
                icon(r.ic),
                h('span', { class: 'gm-row-text' }, h('span', { class: 'gm-row-title' }, r.title), h('span', { class: 'gm-row-meta' }, r.sub)),
              ),
            ),
          )
        : [h('li', { class: 'gm-empty' }, t.searchNoResults)]),
    )
    results.hidden = false
  }
  // Tapping the bar opens the full-screen search like Maps; the inline list stays as fallback.
  let searchOpen = false
  searchInput.addEventListener('focus', () => {
    if (searchOpen) return
    searchOpen = true
    searchInput.blur()
    const runQuery = (q: string) => {
      searchInput.value = q
      if (!map) return
      status.textContent = t.loading
      searchText(map, q)
        .then((hits) => {
          status.textContent = hits.length ? '' : t.searchNoResults
          showPlaces(hits, q)
        })
        .catch((err) => (status.textContent = err instanceof PlacesUnavailable ? err.message : t.placesError))
    }
    let close: () => void = () => {}
    try {
      close = openSearchScreen(root, {
        initial: searchInput.value,
        onQuery: (q) => {
          close()
          runQuery(q)
        },
        onPickPlaceName: (name) => {
          close()
          runQuery(name)
        },
        onClose: () => {
          searchOpen = false
        },
        suggestions: (q) => {
          const ql = q.trim().toLowerCase()
          if (!ql) return []
          const places = t.places.filter((p) => p.name.toLowerCase().includes(ql)).map((p) => ({ title: p.name, sub: p.sub, icon: 'location_on', go: () => { close(); flyTo(p.lat, p.lon) } }))
          const doors = entrances
            .filter((e) => typeof e.name === 'string' && e.name.toLowerCase().includes(ql) && markerKind(e) !== 'no-marker')
            .map((e) => ({ title: e.name!, sub: stepFreeLabel(e.stepFree), icon: 'door_front', go: () => { close(); openEntrance(e) } }))
          return [...places, ...doors].slice(0, SEARCH_MAX)
        },
      })
    } catch (err) {
      console.error('[doorway] search screen failed', err)
      searchOpen = false
      searchInput.focus()
    }
  })
  searchInput.addEventListener('input', renderResults)
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const first = results.querySelector<HTMLButtonElement>('button')
      if (first) first.click()
      else if (map && searchInput.value.trim()) {
        const q = searchInput.value.trim()
        results.hidden = true
        searchInput.blur()
        status.textContent = t.loading
        searchText(map, q)
          .then((hits) => {
            status.textContent = hits.length ? '' : t.searchNoResults
            showPlaces(hits, q)
          })
          .catch((err) => (status.textContent = err instanceof PlacesUnavailable ? err.message : t.placesError))
      }
    }
    if (ev.key === 'Escape') results.hidden = true
  })

  // Voice search through the browser's speech recognition (Safari and Chrome ship it prefixed).
  type Rec = { lang: string; interimResults: boolean; start(): void; onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null }
  const RecCtor = (window as unknown as { webkitSpeechRecognition?: new () => Rec; SpeechRecognition?: new () => Rec }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition
  if (!RecCtor) micBtn.hidden = true
  micBtn.addEventListener('click', () => {
    if (!RecCtor) return
    try {
      const rec = new RecCtor()
      rec.lang = document.documentElement.lang === 'en' ? 'en-US' : 'de-DE'
      rec.interimResults = false
      rec.onresult = (ev) => {
        searchInput.value = ev.results[0]?.[0]?.transcript ?? ''
        renderResults()
      }
      rec.start()
      announce(t.listening)
    } catch {
      /* recognition unavailable */
    }
  })
  // Lens: the camera view to the nearest door that may carry an arrow.
  lensBtn.addEventListener('click', () => nearestDoor(true))
  goBtn.addEventListener('click', () => nearestDoor(false))
  function nearestDoor(startNow: boolean) {
    const hit = nearby().find(({ e }) => guidanceFor(e, opts.profile).kind === 'arrow')
    if (!hit) {
      announce(t.noDoors)
      status.textContent = t.noDoors
      return
    }
    openEntrance(hit.e)
    if (startNow) viewBtn.click()
  }
  layersBtn.addEventListener('click', () => {
    if (!map) return
    map.setMapTypeId(map.getMapTypeId() === 'hybrid' ? 'roadmap' : 'hybrid')
  })

  // ---- position + data ----
  function drawMe() {
    if (!map || !me) return
    const pos = { lat: me.lat, lng: me.lon }
    if (meMarker) meMarker.setPosition(pos)
    else
      meMarker = new google.maps.Marker({
        map,
        position: pos,
        title: t.myLocation,
        zIndex: 4,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#1a73e8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2.5 },
      })
  }
  locateBtn.addEventListener('click', () => {
    if (me) flyTo(me.lat, me.lon)
  })

  if ('geolocation' in navigator) {
    geoWatch = navigator.geolocation.watchPosition(
      (p) => {
        const first = !me
        me = { lat: p.coords.latitude, lon: p.coords.longitude }
        drawMe()
        if (first) {
          if (!opts.openDoor) map?.setCenter({ lat: me.lat, lng: me.lon })
          if (!map) void load(bboxAround(me.lat, me.lon, 500))
        }
        if (!selected) renderSheet()
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000 },
    )
  }

  const key = mapsKey()
  if (key) {
    loadMaps(key)
      .then(() => {
        const c = me ?? DEFAULT_CENTER
        map = new google.maps.Map(mapEl, {
          center: { lat: c.lat, lng: c.lon },
          zoom: 17,
          // Google's own POI labels stay tappable: in Maps, tapping a restaurant or a
          // station opens its card, and switching that off made every venue on the map
          // dead to the touch. We intercept the tap and show OUR card instead of the
          // default InfoWindow, so accessibility data leads.
          clickableIcons: true,
          gestureHandling: 'greedy',
          disableDefaultUI: true,
          keyboardShortcuts: true,
          mapTypeId: 'hybrid',
        })
        drawMe()
        if (opts.openDoor)
          void findEntrance(opts.openDoor).then((e) => {
            if (e) map?.setCenter({ lat: e.lat, lng: e.lon })
          })
        map.addListener('click', (ev: google.maps.MapMouseEvent | google.maps.IconMouseEvent) => {
          results.hidden = true
          const placeId = (ev as google.maps.IconMouseEvent).placeId
          if (placeId) {
            // A Google POI was tapped. Suppress the default InfoWindow and show our card.
            ev.stop?.()
            void openPlaceById(placeId)
            return
          }
          // A panel (editor, business) may use map taps itself: do not collapse it then.
          if (panelCleanup) return
          if (sheet.dataset.state !== 'peek') setSheet('peek')
        })
        map.addListener('idle', () => {
          const bb = map!.getBounds()
          if (!bb) return
          const ne = bb.getNorthEast()
          const sw = bb.getSouthWest()
          void load({ south: sw.lat(), west: sw.lng(), north: ne.lat(), east: ne.lng() })
        })
      })
      .catch(() => {
        mapEl.replaceChildren(h('p', { class: 'hint' }, t.mapUnavailable))
        setSheet('full')
        void load(bboxAround(origin().lat, origin().lon, 500))
      })
  } else {
    mapEl.replaceChildren(h('p', { class: 'hint' }, t.mapUnavailable))
    setSheet('full')
    void load(bboxAround(DEFAULT_CENTER.lat, DEFAULT_CENTER.lon, 500))
  }
  renderSheet()
  announce(t.mapTitle)

  function teardown() {
    try {
      panelCleanup?.()
    } catch {
      /* ignore */
    }
    placeMarkers.forEach((m) => m.setMap(null))
    if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch)
    markers.forEach((m) => m.setMap(null))
    meMarker?.setMap(null)
    routeLine?.setMap(null)
  }
  return teardown
}

function bearingFromTo(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r)
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r)
  return ((Math.atan2(y, x) / r) + 360) % 360
}
