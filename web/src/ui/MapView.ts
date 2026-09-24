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
import { CONNECTOR_MIN_M, connected, instructionLine, tailLength, walkMinutes, type Route } from '../core/route'
import { liveViewMode, arrivalClock, navSheetLines, navState, roundNavM, secondsLeft, startEnabled, thenGlyph, viaStreets } from '../core/nav'
import { isMuted, setMuted } from './voiceCalm'
import { NEAR_TRIGGER_M } from './LiveView'
import { computeRoute, D, formatDistance, routeSubline, startBlockedReason, stepsList, type RouteOutcome } from './Directions'
import { outputFor, type Profile } from '../core/profile'
import { guidanceFor, markerKind, type ArrowTarget } from '../core/target'
import type { Building, Entrance } from '../core/types'
import { mapsKey } from '../config'
import { bboxAround, fetchEntrances, fetchLived, findEntrance, type BBox } from '../data'
import { announce, primeSpeech, speak } from '../session'
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
import { doorName } from './doorName'
import { openSearchScreen } from './SearchScreen'
import { exploreFeed } from './ExploreFeed'
import { t } from '../strings'
import { h, mount, s } from './dom'
import { pathDoorName } from './doorName'
import type { LivePlace } from './LiveView'
import { approachModeFor, type ApproachMode } from './approachPort'

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
/**
 * One Google map per page. Every return from settings, guidance or the recorder used to
 * build a new google.maps.Map: each one is a billed map load, and Maps never frees a map
 * instance, so the page grew with every round trip. The map and its element are kept
 * here and handed to the next MapView; teardown removes everything a view put on it.
 */
let sharedMap: { el: HTMLElement; map: google.maps.Map } | null = null
function loadMaps(key: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve()
  mapsLoading ??= new Promise<void>((resolve, reject) => {
    const cb = '__doorwayMapsReady'
    ;(window as unknown as Record<string, () => void>)[cb] = () => resolve()
    const sc = document.createElement('script')
    sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=${lang === 'de' ? 'de' : 'en'}&callback=${cb}`
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

type SheetState = 'peek' | 'route' | 'half' | 'full'
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

/** Where nav mode resumes after Live View, and what Live View is opened on. */
export interface NavResume {
  lat: number
  lon: number
  name: string
  door: Entrance | null
}

export function MapView(opts: {
  profile: Profile
  openDoor?: string | null
  /** `name` is the distinguishable door name (doorName), shown and spoken in Live View. */
  onGuide: (target: ArrowTarget, name?: string, fromNav?: boolean) => void
  /** Nav mode's "Zum Eingang führen": straight into the last-10-m approach. */
  onApproach?: (door: Entrance, mode: ApproachMode) => void
  /** Back from a Live View that was opened in nav mode: navigate to this door again. */
  resumeNav?: NavResume | null
  /** Live View to a destination that is not a guidable door (Maps-style, no handover). */
  onLivePlace?: (place: LivePlace, fromNav: boolean) => void
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
  /** Set by teardown: late network answers must not draw on a screen that is gone. */
  let gone = false
  /**
   * Bumped whenever the user changes what the sheet is about (a tab, a card, a new
   * search). A places answer that lands after that belongs to a question nobody is
   * asking any more; showing it yanked the sheet away from what was just tapped.
   */
  let sheetEpoch = 0

  // ---- top: search bar, chips, layers ----
  const status = h('p', { class: 'gm-status', role: 'status' }, '')
  const mapEl = sharedMap?.el ?? h('div', { class: 'gm-map', role: 'region', 'aria-label': t.mapTitle })
  /** Listeners this view put on the shared map; teardown takes them off again. */
  const mapListeners: google.maps.MapsEventListener[] = []
  // The pill is a button, not an input: it only opens the full-screen search. As an
  // input it opened the overlay on focus, so keyboard and Switch Control users tabbing
  // past it were trapped in the search (WCAG 2.1.1, 3.2.1).
  const searchInput = h('button', { class: 'gm-search-input is-empty', type: 'button', 'aria-haspopup': 'dialog' }, t.searchPlaceholder) as HTMLButtonElement
  let searchQuery = ''
  const setSearchQuery = (q: string) => {
    searchQuery = q
    searchInput.textContent = q || t.searchPlaceholder
    searchInput.classList.toggle('is-empty', !q)
    searchInput.setAttribute('aria-label', q ? `${t.searchPlaceholder}: ${q}` : t.searchPlaceholder)
  }
  setSearchQuery('')
  const micBtn = h('button', { class: 'gm-search-btn', type: 'button', 'aria-label': t.voiceSearch }, icon('mic'))
  const lensBtn = h('button', { class: 'gm-search-btn', type: 'button', 'aria-label': t.look }, icon('photo_camera'))
  // Settings replace this screen and come back through a new MapView: stop the GPS
  // watch and take the markers off first, as guidance and the recorder do. Without
  // this every visit to settings left one more watchPosition feeding a dead map.
  const avatar = h('button', { class: 'gm-avatar', type: 'button', 'aria-label': t.profileButton, onclick: () => { teardown(); opts.onSettings() } }, 'S')
  const search = h('div', { class: 'gm-search' }, pinLogo(), searchInput, micBtn, lensBtn, avatar)

  const placeChips = NORMAL_CHIPS.map((c) => {
    const b = h('button', { class: 'gm-chip', type: 'button', 'aria-pressed': 'false', 'data-chip': c.id }, icon(c.icon), lang === 'de' ? c.labelDe : c.labelEn)
    b.addEventListener('click', () => void runCategory(c.id, lang === 'de' ? c.labelDe : c.labelEn))
    return b
  })
  const modeChip = modeSwitch(mode, (m) => {
    mode = m
    saveMode(m)
    sheetEpoch++
    clearRoute(false)
    clearPlaces()
    selected = null
    renderChips()
    renderMarkers()
    renderSheet()
    announce(m === 'access' ? t.modeOn : t.modeOff)
  })
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
  const chips = h('div', { class: 'gm-chips', role: 'group', 'aria-label': t.filterLabel })
  function renderChips() {
    // Search categories up top like Google, but the accessibility mode chip leads.
    // Sami's branch moved it into settings to match Maps exactly; kept here instead,
    // because the toggle between plain Maps and accessibility mode IS the product, and
    // a setting three taps deep cannot show that. His result-list filters are taken.
    chips.replaceChildren(modeChip, ...(mode === 'access' ? accessChips : placeChips))
    placeChips.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.chip === activePlaceChip)))
  }
  renderChips()
  const morePill = h('button', { class: 'gm-more', type: 'button', hidden: true, onclick: () => closeCard() }, t.moreDoors)
  // ---- route preview ----
  // Measured off a screen recording of Maps walking directions: the summary lives in
  // the sheet, not in a floating pill. One line of "4 min - 260 m" with round buttons
  // on the right, then a row of actions, the first of them filled.
  let routePreview = false
  /** Bumped by every draw and clear, so a route that lands after a close is dropped. */
  let routeSeq = 0
  let routeTarget: Entrance | null = null
  /** Reopens the card a route was drawn from, when the user removes the route. */
  let routeReturn: (() => void) | null = null
  /** The place card currently (or last) open, so a place route can return to it. */
  let lastPlace: PlaceHit | null = null
  /** Destination of the route being drawn or shown. */
  let routeTo: LatLon | null = null

  // ---- navigation mode (after Start) ----
  // Measured off Maps: Start does not jump into the camera. It turns the map into a
  // navigation screen (green manoeuvre banner on top, "4 Min. · 260 m · Ankunft 09:24"
  // below, round X to end). The square Live View tile bottom-left switches to the
  // camera on the same route, from the preview and from navigation alike.
  const NV = lang === 'de'
    ? { live: 'Live View', end: 'Navigation beenden', exit: 'Beenden', then: 'Dann', compass: 'Kompass, nach Norden ausrichten', mute: 'Ton aus', options: 'Routenoptionen und Schritte', arrive: 'Ankunft', dest: 'Ziel erreichen', inM: (m: number) => `In ${m} m`, you: 'Dein Standort', started: 'Navigation gestartet', near: 'Zum Eingang führen', nearSay: 'Du bist fast da. Zum Eingang führen?' }
    : { live: 'Live View', end: 'End navigation', exit: 'Exit', then: 'Then', compass: 'Compass, north up', mute: 'Mute', options: 'Route options and steps', arrive: 'Arrival', dest: 'Arrive at destination', inM: (m: number) => `In ${m} m`, you: 'Your location', started: 'Navigation started', near: 'Guide me to the entrance', nearSay: 'You are almost there. Guide you to the entrance?' }
  let navOn = false
  /** Nav speaks only when the profile speaks and nobody muted it (voiceCalm, shared with Live View). */
  const voiceOn = () => outputFor(opts.profile).speak && !isMuted()
  let navRoute: Route | null = null
  /** Where nav mode is going. `door` is set only for a door that may carry guidance:
   *  the Live View button and the last-10-m handover need it; places navigate without. */
  let navDest: { lat: number; lon: number; name: string; door: Entrance | null } | null = null
  let navBack: (() => void) | null = null
  let navFollow: [number, number][] = []
  let navTail = 0
  let navSpoken = -1
  let navNearSaid = false
  const liveThumb = h('button', { class: 'gm-livethumb', type: 'button', hidden: true, 'aria-label': NV.live, title: NV.live },
    h('span', { class: 'gm-livethumb-img', 'aria-hidden': 'true' }, icon('photo_camera')))
  const routeTopTo = h('span', { class: 'gm-routetop-t' }, '')
  const routeTop = h('div', { class: 'gm-routetop', hidden: true },
    h('div', { class: 'gm-routetop-row' }, h('span', { class: 'gm-routetop-dot', 'aria-hidden': 'true' }), h('span', { class: 'gm-routetop-me' }, NV.you)),
    h('div', { class: 'gm-routetop-row' }, h('span', { class: 'gm-routetop-pin', 'aria-hidden': 'true' }, icon('location_on', true)), routeTopTo),
  )
  const navIc = h('span', { class: 'gm-navbanner-ic', 'aria-hidden': 'true' })
  const navDist = h('span', { class: 'gm-navbanner-m' }, '')
  const navText = h('span', { class: 'gm-navbanner-t' }, '')
  const navThenIc = h('span', { class: 'gm-navthen-ic', 'aria-hidden': 'true' })
  const navThen = h('div', { class: 'gm-navthen', hidden: true }, h('span', {}, NV.then), navThenIc)
  const navBanner = h('div', { class: 'gm-navwrap', hidden: true },
    h('div', { class: 'gm-navbanner' }, navIc, h('div', { class: 'gm-navbanner-txt' }, navDist, navText)),
    navThen,
  )
  // Right column in nav mode, top to bottom as in Maps: Live View, compass, search,
  // mute, route options.
  const navRound = (ic: string, label: string, on: () => void) =>
    h('button', { class: 'gm-navbtn', type: 'button', 'aria-label': label, title: label, onclick: on }, icon(ic))
  const navLiveBtn = navRound('center_focus_weak', NV.live, () => navDest && void beginLive(navDest, true))
  navLiveBtn.classList.add('gm-navbtn-live')
  navLiveBtn.replaceChildren(h('span', { class: 'gm-navbtn-live-ic', 'aria-hidden': 'true' }, icon('center_focus_weak'), icon('photo_camera', true)))
  const muteBtn = navRound('volume_up', NV.mute, () => {
    setMuted(!isMuted())
    paintMute()
  })
  function paintMute() {
    const m = isMuted()
    muteBtn.classList.toggle('is-muted', m)
    muteBtn.setAttribute('aria-pressed', String(m))
    muteBtn.replaceChildren(icon(m ? 'volume_off' : 'volume_up'))
  }
  paintMute()
  const navStepsEl = h('div', { class: 'gm-navsteps', hidden: true })
  const navCol = h('div', { class: 'gm-navcol', hidden: true },
    navLiveBtn,
    navRound('explore', NV.compass, () => {
      map?.setHeading(0)
      const p = origin()
      map?.panTo({ lat: p.lat, lng: p.lon })
    }),
    navRound('search', t.searchPlaceholder, () => searchInput.click()),
    muteBtn,
    navRound('alt_route', NV.options, () => {
      navStepsEl.hidden = !navStepsEl.hidden
      setSheet(navStepsEl.hidden ? 'route' : 'full')
    }),
  )
  const navSummary = h('h2', { id: 'sheet-title', class: 'gm-navsheet-t', tabindex: '-1' }, '')
  const navSub = h('span', { class: 'gm-navsheet-sub' }, '')
  const navNearBtn = h('button', { class: 'gm-pill gm-pill-primary gm-navnear', type: 'button', hidden: true }, icon('door_front', true), NV.near)

  function startNav(dest: { lat: number; lon: number; name: string; door: Entrance | null }, r: Route, back: () => void) {
    primeSpeech()
    navOn = true
    navRoute = r
    navDest = dest
    navBack = back
    const e = dest.door
    const from = origin()
    navFollow = connected(from, r.path, { lat: dest.lat, lon: dest.lon })
    navTail = tailLength(r.path, navFollow)
    navSpoken = -1
    navNearSaid = false
    root.dataset.nav = 'on'
    navBanner.hidden = false
    routeTop.hidden = true
    navNearBtn.hidden = true
    navNearBtn.onclick = () => e && void beginApproach(e)
    liveThumb.hidden = true
    navCol.hidden = false
    navLiveBtn.hidden = false
    paintMute()
    navStepsEl.hidden = true
    navStepsEl.replaceChildren(stepsList(r, dest.name))
    sheetBody.replaceChildren(
      h('div', { class: 'gm-navsheet' },
        h('div', { class: 'gm-navsheet-txt' }, h('div', { class: 'gm-navsheet-row' }, navSummary, h('span', { class: 'gm-navsheet-walk', 'aria-hidden': 'true' }, icon('directions_walk', true))), navSub),
        h('button', { class: 'gm-navend', type: 'button', 'aria-label': NV.end, onclick: () => endNav() }, NV.exit),
      ),
      navNearBtn,
      navStepsEl,
    )
    setSheet('route')
    if (map) {
      map.setZoom(18)
      map.panTo({ lat: from.lat, lng: from.lon })
    }
    announce(NV.started)
    updateNav()
  }

  function updateNav() {
    if (!navOn || !navRoute || !navDest) return
    const pos = origin()
    const st = navState(pos, navRoute, navFollow, navTail)
    const m = roundNavM(st.toManeuverM)
    navIc.replaceChildren(icon(st.glyph, true))
    navDist.textContent = NV.inM(m)
    navText.textContent = st.text ?? `${NV.dest}: ${navDest.name}`
    const secs = secondsLeft(navRoute, st.remainingM)
    const lines = navSheetLines(secs, st.remainingM, new Date(), lang === 'de')
    navSummary.textContent = lines.big
    navSub.textContent = lines.small
    const then = thenGlyph(navRoute, st.walking)
    navThen.hidden = !then
    if (then) navThenIc.replaceChildren(icon(then, true))
    if (st.walking !== navSpoken) {
      navSpoken = st.walking
      const line = `${NV.inM(m)} ${st.text ?? NV.dest}`
      announce(line)
      if (voiceOn()) speak(line, { interrupt: true })
    }
    // The last-10-m handover is ours only for a door that may carry guidance.
    const near = !!navDest.door && haversineM(pos, { lat: navDest.lat, lon: navDest.lon }) <= NEAR_TRIGGER_M
    navNearBtn.hidden = !near
    if (near && !navNearSaid) {
      navNearSaid = true
      announce(NV.nearSay)
      if (voiceOn()) speak(NV.nearSay, { interrupt: true })
    }
    map?.panTo({ lat: pos.lat, lng: pos.lon })
  }

  function stopNav() {
    if (!navOn) return
    navOn = false
    navRoute = null
    delete root.dataset.nav
    navBanner.hidden = true
    navCol.hidden = true
  }

  /** X in navigation: back to the route preview, as in Maps. */
  function endNav() {
    const back = navBack
    stopNav()
    if (back) back()
    else clearRoute()
  }

  /** "Ankunft 09:25 · über Ganghoferstraße und Karl-Marx-Straße", or the old subline. */
  function previewSub(r: Route, label: string | null): string {
    const secs = secondsLeft(r, r.distanceM ?? 0)
    const via = viaStreets(r, lang === 'de')
    const arrive = `${lang === 'de' ? 'Ankunft' : 'Arrive'} ${arrivalClock(new Date(), secs)}`
    return via ? `${arrive} · ${via}` : `${arrive} · ${routeSubline(label)}`
  }

  function showRoutePreview(summary: string, label: string | null, out: RouteOutcome, retry: () => void, crowM: number) {
    routePreview = true
    morePill.hidden = true
    root.dataset.route = 'on'
    routeTopTo.textContent = label ?? D.destination
    routeTop.hidden = false
    const e = routeTarget
    const g = e ? guidanceFor(e, opts.profile) : null
    const r = out.ok ? out.route : null

    const action = (cls: string, ic: string, text: string, on: () => void) =>
      h('button', { class: `gm-pill ${cls}`, type: 'button', onclick: on }, icon(ic, true), text)
    // Start works whenever there is a route: nav mode needs no door. Only Live View and
    // the last-10-m handover need a door that may carry guidance; for a door that cannot,
    // the reason stays as an info line under the actions.
    const guidable = g?.kind === 'arrow'
    const blocked = !startEnabled(!!r, guidable)
    const why = e && !guidable ? startBlockedReason(g?.kind === 'text' ? g.reason : null) : null
    const startBtn = h(
      'button',
      {
        class: 'gm-pill gm-pill-primary',
        type: 'button',
        disabled: blocked,
        'aria-disabled': String(blocked),
        ...(why ? { 'aria-describedby': 'route-start-why' } : {}),
        onclick: () => {
          const to = routeTo
          if (r && to) startNav({ lat: to.lat, lon: to.lon, name: label ?? D.destination, door: guidable ? e : null }, r, retry)
          else if (e && guidable) void beginGuidance(e)
        },
      },
      icon(blocked ? 'block' : 'navigation', true),
      t.startGuidance,
    )

    // The turn-by-turn list is always in the sheet, as in Maps: pull the sheet up, or
    // press "Schritte", and it is there. Without a route there is nothing to list, and
    // the sheet says why instead of showing a straight line.
    const body = r
      ? stepsList(r, label ?? D.destination)
      : h(
          'div',
          { class: 'dir-error', role: 'alert' },
          icon('wrong_location', true),
          h('p', {}, out.ok ? '' : out.message, h('small', {}, D.crow(t.metresShort(crowM)))),
        )

    // Live View works for every route, as in Maps; only a guidable door adds our handover.
    liveThumb.hidden = !r || !routeTo
    liveThumb.onclick = () => {
      const to = routeTo
      if (to) void beginLive({ lat: to.lat, lon: to.lon, name: label ?? D.destination, door: e }, false)
    }
    const whyLine = why ? [h('p', { id: 'route-start-why', class: 'gm-route-why' }, icon('info'), why)] : []
    // Mode tabs as in Maps. Doorway guides on foot; the others are shown, not offered.
    const modeTab = (ic: string, text: string, on = false) =>
      h('span', { class: `gm-modetab${on ? ' is-on' : ''}`, 'aria-disabled': String(!on), ...(on ? { 'aria-current': 'true' } : {}) }, icon(ic, on), text)
    const modeTabs = h('div', { class: 'gm-modetabs', role: 'group', 'aria-label': lang === 'de' ? 'Verkehrsmittel' : 'Travel mode' },
      modeTab('directions_car', lang === 'de' ? 'Auto' : 'Car'),
      modeTab('directions_transit', lang === 'de' ? 'ÖPNV' : 'Transit'),
      modeTab('directions_walk', lang === 'de' ? 'Zu Fuß' : 'Walk', true),
      modeTab('directions_bike', lang === 'de' ? 'Fahrrad' : 'Bike'),
    )
    sheetBody.replaceChildren(
      modeTabs,
      h(
        'div',
        { class: 'gm-routehead' },
        h('span', { class: 'gm-routehead-ic', 'aria-hidden': 'true' }, icon(r ? 'directions_walk' : 'wrong_location', true)),
        h('h2', { id: 'sheet-title', class: 'gm-routehead-t', tabindex: '-1' }, summary),
        h('span', { class: 'gm-routehead-sub' }, r ? previewSub(r, label) : label ?? ''),
        h('div', { class: 'gm-routehead-btns' },
          e ? h('button', { class: 'gm-round-s', type: 'button', 'aria-label': t.share, onclick: () => void share(e) }, icon('ios_share')) : null,
          h('button', { class: 'gm-round-s', type: 'button', 'aria-label': t.clearRoute, onclick: () => clearRoute() }, icon('close')),
        ),
      ),
      h(
        'div',
        { class: 'gm-actions gm-routeactions' },
        startBtn,
        r ? action('', 'list', t.steps, () => setSheet(sheet.dataset.state === 'full' ? 'route' : 'full')) : action('', 'refresh', D.retry, retry),
        e ? action('', 'door_front', t.otherDoors, () => closeCard()) : null,
      ),
      ...whyLine,
      body,
    )
    setSheet('route')
  }

  /** The one gesture that unlocks compass, camera and sound. Must await first. */
  // A double tap on Start must open one Live View, not two stacked ones.
  let guiding = false
  /** Live View to any destination: a guidable door gets the full view, anything else the Maps one. */
  async function beginLive(dest: NavResume, fromNav: boolean) {
    if (liveViewMode(dest.door, opts.profile) === 'door' && dest.door) return beginGuidance(dest.door, fromNav)
    if (guiding || !opts.onLivePlace) return
    guiding = true
    try {
      await unlockAll({ camera: true })
    } catch (err) {
      guiding = false
      throw err
    }
    teardown()
    opts.onLivePlace({ lat: dest.lat, lon: dest.lon, name: dest.name }, fromNav)
  }

  async function beginGuidance(e: Entrance, fromNav = false) {
    if (guiding) return
    const g = guidanceFor(e, opts.profile)
    if (g.kind !== 'arrow') return
    guiding = true
    const name = doorName(e, origin(), buildings)
    try {
      await unlockAll({ camera: true })
    } catch (err) {
      guiding = false
      throw err
    }
    teardown()
    opts.onGuide(g.target, name, fromNav)
  }

  /**
   * Nav mode, last 10 m: the same approach LiveView's trigger and the arrival "Ja" open
   * (guide for speech users, the door check for step-free profiles). No detour through
   * Live View, which would ask a second time. Falls back to Live View without a mode.
   */
  async function beginApproach(e: Entrance) {
    const mode = approachModeFor(opts.profile)
    if (!mode || !opts.onApproach || guidanceFor(e, opts.profile).kind !== 'arrow') return beginGuidance(e, true)
    if (guiding) return
    guiding = true
    try {
      await unlockAll({ camera: true })
    } catch (err) {
      guiding = false
      throw err
    }
    teardown()
    opts.onApproach(e, mode)
  }

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
    sheetEpoch++
    // A route belongs to the Erkunden sheet. Left drawn, it kept routePreview set, so
    // the other tabs' sheets snapped to the route height and GPS redraws stopped.
    clearRoute(false)
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
    h('div', { class: 'gm-top' }, search, chips, morePill, status),
    layersBtn,
    rightCol,
    liveThumb,
    routeTop,
    navBanner,
    navCol,
    sheet,
    nav,
    // Last in the DOM, first on screen (absolute, under every z-indexed overlay): Tab
    // reaches the search pill first, not the map region and Google's footer links.
    mapEl,
  )
  mount(root)
  // The root and the sheet are fixed frames, never scroll containers. focus() and
  // scrollIntoView() still scroll overflow:hidden boxes, which leaves the tab bar
  // mid-screen; snap them back whenever that happens.
  for (const frame of [root, sheet]) frame.addEventListener('scroll', () => { if (frame.scrollTop || frame.scrollLeft) frame.scrollTo(0, 0) }, { passive: true })

  // Focus never lands under the nav bar or below the sheet edge (WCAG 2.4.11): a Tab
  // stop outside the visible part opens the sheet fully and brings the row into view.
  sheetBody.addEventListener('focusin', (ev) => {
    const el = ev.target as HTMLElement
    const r = el.getBoundingClientRect()
    const bottom = nav.getBoundingClientRect().top || window.innerHeight
    if (r.top >= sheet.getBoundingClientRect().top && r.bottom <= bottom) return
    if (sheet.dataset.state !== 'full') setSheet('full')
    requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }))
  })

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
    showRoute: (to, label) => drawRoute(to, label),
    clearRoute: () => clearRoute(),
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
  /** Handle tap: one step up, from full back to the bottom; the route summary counts as the bottom. */
  const nextState = (): SheetState => {
    const st = sheet.dataset.state as SheetState
    if (st === 'route') return 'half'
    if (st === 'full') return routePreview ? 'route' : 'peek'
    return order[stateIdx() + 1]
  }
  const snap = (dy: number, dt: number) => {
    const v = dy / Math.max(dt, 1) // px per ms, negative = up
    // 'route' is not in `order`; index -1 used to make an upward swipe land on peek.
    // Up opens the route to half, down keeps the route summary as its lowest state.
    if (sheet.dataset.state === 'route') {
      setSheet(v < -0.5 || dy < -60 ? (dy < -420 ? 'full' : 'half') : 'route')
      return
    }
    const i = stateIdx()
    let step = 0
    if (v < -0.5 || dy < -60) step = dy < -420 && i === 0 ? 2 : 1
    else if (v > 0.5 || dy > 60) step = dy > 420 && i === 2 ? -2 : -1
    const next = order[Math.max(0, Math.min(order.length - 1, i + step))]
    setSheet(next === 'peek' && routePreview ? 'route' : next)
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
      // Two fingers are a pinch: page zoom for low-vision users, never a sheet drag.
      if (ev.touches.length > 1) {
        dragY0 = null
        dragging = false
        sheet.style.transition = ''
        setSheet(sheet.dataset.state as SheetState)
        return
      }
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
    else if (!decided && handle.contains(ev.target as Node)) setSheet(nextState())
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
  // Ends a mouse drag in every way it can end: button released, released outside the window
  // (lost capture), cancelled. A drag that never ends would leave the sheet shifted for good.
  const endMouse = (clientY: number | null) => {
    if (mouseY0 === null) return
    const dy = clientY === null ? 0 : clientY - mouseY0
    mouseY0 = null
    if (Math.abs(dy) < 6) {
      if (clientY !== null) setSheet(nextState())
      else setSheet(sheet.dataset.state as SheetState)
    } else snap(dy, performance.now() - dragT0)
  }
  handle.addEventListener('pointermove', (ev) => {
    if (mouseY0 === null) return
    if (ev.buttons === 0) return endMouse(ev.clientY)
    sheet.style.setProperty('--drag', `${ev.clientY - mouseY0}px`)
  })
  handle.addEventListener('pointerup', (ev) => endMouse(ev.clientY))
  handle.addEventListener('pointercancel', () => endMouse(null))
  handle.addEventListener('lostpointercapture', (ev) => endMouse(ev.clientY))
  // Safety net: any scroll or wheel on the sheet without an active gesture clears a stale offset.
  const clearStale = () => {
    if (mouseY0 === null && dragY0 === null && sheet.style.getPropertyValue('--drag')) setSheet(sheet.dataset.state as SheetState)
  }
  sheetBody.addEventListener('scroll', clearStale, { passive: true })
  sheet.addEventListener('wheel', clearStale, { passive: true })
  handle.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    setSheet(nextState())
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

  /** Bumped per entrance request: a slow answer for a box the user already left is dropped. */
  let loadSeq = 0
  async function load(b: BBox) {
    const key = [b.south, b.west, b.north, b.east].map((x) => x.toFixed(4)).join(',')
    if (key === lastBox) return
    lastBox = key
    const seq = ++loadSeq
    try {
      const r = await fetchEntrances(b)
      if (seq !== loadSeq || gone) return
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
      } else backgroundRender()
    } catch {
      if (seq !== loadSeq || gone) return
      lastBox = '' // the same view may be asked again once the network is back
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
        h('span', { class: 'gm-row-text' }, h('span', { class: 'gm-row-title' }, pathDoorName(e)), h('span', { class: 'gm-row-meta' }, meta)),
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

  /**
   * New data (a map load, a location fix) redraws the Erkunden sheet only. Für dich,
   * Beitragen and Unternehmen own their screens: remounting them from a GPS tick threw
   * the user out of an open editor ("Eingang hinzufügen" jumped back to the business
   * home) and moved VoiceOver focus. They re-render themselves after their own saves.
   */
  function backgroundRender() {
    if (selected || placeOpen || routePreview) return
    if (tab !== 'explore') return
    renderSheet()
  }

  function renderSheet() {
    placeOpen = false
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
      panelCleanup = renderPlaceList(sheetBody, featureCtx, placeHits, placeTitle, (p) => openPlace(p), (visibleHits) => {
        // Keep the map pins in step with the list filters.
        const keep = new Set(visibleHits.map((x) => x.placeId))
        placeMarkers.forEach((m, i) => m.setVisible(keep.has(placeHits[i]?.placeId ?? '')))
      })
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
      chip.setAttribute('role', 'img')
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
        title: `${pathDoorName(e)}, ${stepFreeLabel(e.stepFree)}`,
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
      if (navigator.share) await navigator.share({ title: pathDoorName(e), url })
      else {
        await navigator.clipboard.writeText(url)
        announce(t.copied)
      }
    } catch {
      /* share sheet dismissed */
    }
  }

  // Street View panoramas in door cards: each holds listeners and a WebGL context, and
  // an unclosed one kept them after the card was gone (fuzz: 30 to 140 listeners).
  let panos: { p: google.maps.StreetViewPanorama; div: HTMLElement }[] = []
  function disposePanos() {
    for (const { p, div } of panos) {
      try {
        p.setVisible(false)
        google.maps.event.clearInstanceListeners(p)
        div.replaceChildren()
      } catch {
        /* already gone */
      }
    }
    panos = []
  }
  function showCard(item: Entrance | Building, ...children: (Node | null)[]) {
    disposePanos()
    sheetEpoch++
    placeOpen = false
    // A new card replaces a route preview; the route was drawn for the old one.
    clearRoute(false)
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
    // preventScroll: the sheet is still sliding up, and a plain focus() scrolls the
    // fixed root so the tab bar ends up in the middle of the screen.
    sheetBody.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }
  function closeCard() {
    disposePanos()
    panelCleanup?.()
    panelCleanup = null
    selected = null
    clearRoute(false)
    renderMarkers()
    renderSheet()
    // Back to a result list: show the list, not a peek that hides every row.
    setSheet(placeHits.length ? 'half' : 'peek')
  }

  const ROUTE_BLUE = '#1a73e8'
  let routeCasing: google.maps.Polyline | null = null
  let routeTail: google.maps.Polyline | null = null
  let routeEnd: google.maps.Marker | null = null
  let routeBadge: google.maps.Marker | null = null

  /**
   * Maps draws a walking route as a run of blue dots, never a solid line — the solid
   * line means driving. Each dot carries a white ring so it survives satellite tiles,
   * and a soft dark casing runs underneath so the path still reads as one thing where
   * the dots cross something bright.
   */
  function walkDots(rough: boolean): google.maps.IconSequence[] {
    // Measured off a screen recording of Maps walking directions on this phone:
    // flat blue circles about 6.3 CSS px across, 16 px centre to centre, no ring and
    // no casing under them. The ring was mine and it read as a different product.
    return [{
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: rough ? 2.6 : 3.2,
        fillColor: rough ? '#9aa0a6' : ROUTE_BLUE,
        fillOpacity: 1,
        strokeOpacity: 0,
        strokeWeight: 0,
      },
      offset: '0',
      repeat: rough ? '13px' : '16px',
    }]
  }

  /**
   * Remove the route from the map. With `restore` (the user's "Route entfernen"), the
   * sheet goes back to what the route was drawn from: the door card or the place card,
   * not a stale "2 Min. · 160 m". Internal clears (a new draw, closing the card,
   * teardown) pass false and leave the sheet to their caller.
   */
  function clearRoute(restore = true) {
    routeSeq++
    stopNav()
    liveThumb.hidden = true
    routeTop.hidden = true
    delete root.dataset.route
    routeLine?.setMap(null)
    routeCasing?.setMap(null)
    routeTail?.setMap(null)
    routeTail = null
    routeEnd?.setMap(null)
    routeBadge?.setMap(null)
    routeLine = null
    routeCasing = null
    routeEnd = null
    routeBadge = null
    const back = routeReturn
    const wasPreview = routePreview
    routeReturn = null
    routePreview = false
    if (!restore) return
    if (wasPreview) {
      if (back) back()
      else {
        renderSheet()
        setSheet('peek')
      }
    }
  }

  /** The red Maps pin at the destination, drawn from the same teardrop Maps uses. */
  function endCap(to: LatLon) {
    routeEnd = new google.maps.Marker({
      map,
      position: { lat: to.lat, lng: to.lon },
      zIndex: 7,
      clickable: false,
      icon: {
        path: 'M 0 0 c -3.1 -5.4 -10.5 -10.4 -10.5 -17.6 a 10.5 10.5 0 1 1 21 0 C 10.5 -10.4 3.1 -5.4 0 0 z',
        fillColor: '#ea4335',
        fillOpacity: 1,
        strokeColor: '#b31412',
        strokeWeight: 0.8,
        scale: 1.25,
        anchor: new google.maps.Point(0, 0),
      },
    })
  }

  /** Maps parks the walking time on the line itself, in a blue tab. */
  function timeBadge(at: LatLon, text: string) {
    const w = 18 + text.length * 8
    routeBadge = new google.maps.Marker({
      map,
      position: { lat: at.lat, lng: at.lon },
      zIndex: 8,
      clickable: false,
      label: { text, color: '#ffffff', fontSize: '13px', fontWeight: '600', fontFamily: "'Google Sans Flex', Roboto, sans-serif" },
      icon: {
        path: `M ${-w / 2} -11 h ${w} a 5 5 0 0 1 5 5 v 12 a 5 5 0 0 1 -5 5 h ${-w} a 5 5 0 0 1 -5 -5 v -12 a 5 5 0 0 1 5 -5 z`,
        fillColor: ROUTE_BLUE,
        fillOpacity: 1,
        strokeOpacity: 0,
        scale: 1,
        anchor: new google.maps.Point(0, 0),
        labelOrigin: new google.maps.Point(0, 0),
      },
    })
  }

  /**
   * Draw the way to a point: the real walking route from the Routes API, blue dots as
   * Maps draws a walk, the time on the line, and the steps in the sheet. When no route
   * can be computed nothing is drawn but the destination pin, and the sheet says why.
   * A straight line is never drawn: it read as a route and pointed through buildings.
   */
  async function drawRoute(to: LatLon, label?: string, target: Entrance | null = null): Promise<Route | null> {
    if (!map) return null
    // Set here rather than at one call site: routing to a Google POI used to leave the
    // previous door in routeTarget, and Start would then guide to a door the user had
    // navigated away from.
    routeTarget = target
    routeTo = to
    const from = origin()
    clearRoute(false)
    const seq = ++routeSeq
    const place = placeOpen ? lastPlace : null
    const back = target ? () => openEntrance(target) : place ? () => openPlace(place) : null

    const out = await computeRoute(from, to)
    // Closed, or another route asked for, while this one was in flight.
    if (seq !== routeSeq || !map) return out.ok ? out.route : null
    clearRoute(false)
    routeReturn = back
    const retry = () => void drawRoute(to, label, target)
    endCap(to)

    if (!out.ok) {
      const crow = haversineM(from, to)
      showRoutePreview(D.noRouteTitle, label ?? null, out, retry, crow)
      announce(`${D.noRouteTitle}. ${out.message}`)
      map.panTo({ lat: to.lat, lng: to.lon })
      return null
    }

    const r = out.route
    const coords = r.path.map(([lat, lng]) => ({ lat, lng }))
    // Maps draws no casing under walking dots. Neither do we.
    routeLine = new google.maps.Polyline({
      map, path: coords, strokeOpacity: 0, zIndex: 5, clickable: false, icons: walkDots(false),
    })
    // Where the route starts away from the user (snapped to the nearest walkable way),
    // Maps joins the two with small grey dots. Guidance follows the same connector.
    if (haversineM(from, { lat: coords[0].lat, lon: coords[0].lng }) > CONNECTOR_MIN_M) {
      routeCasing = new google.maps.Polyline({
        map, path: [{ lat: from.lat, lng: from.lon }, coords[0]], strokeOpacity: 0, zIndex: 5, clickable: false, icons: walkDots(true),
      })
    }
    const endPt = coords[coords.length - 1]
    if (haversineM(to, { lat: endPt.lat, lon: endPt.lng }) > CONNECTOR_MIN_M) {
      routeTail = new google.maps.Polyline({
        map, path: [endPt, { lat: to.lat, lng: to.lon }], strokeOpacity: 0, zIndex: 5, clickable: false, icons: walkDots(true),
      })
    }
    const bounds = new google.maps.LatLngBounds()
    coords.forEach((c) => bounds.extend(c))
    bounds.extend({ lat: from.lat, lng: from.lon })
    bounds.extend({ lat: to.lat, lng: to.lon })

    const mins = walkMinutes(r)
    const metres = r.distanceM ?? 0
    const summary = mins !== null ? `${t.walkMin(mins)} · ${formatDistance(metres)}` : formatDistance(metres)
    if (mins !== null) timeBadge(midpoint(coords), t.walkMin(mins))

    showRoutePreview(summary, label ?? null, out, retry, metres)
    const first = instructionLine(r.steps[0] ?? null) ?? ''
    announce(`${mins !== null ? `${t.walkMin(mins)}, ` : ''}${t.metres(metres)}. ${label ?? ''}. ${first}`.trim())

    // Maps fills the map area with the route. Padding clears the search bar above and
    // the preview sheet below, and nothing more.
    map.fitBounds(bounds, { top: 118, bottom: 268, left: 36, right: 36 })
    return r
  }

  /** Halfway along the drawn path, by walked distance — not the midpoint of the bounds. */
  function midpoint(coords: { lat: number; lng: number }[]): LatLon {
    if (coords.length < 2) return { lat: coords[0].lat, lon: coords[0].lng }
    const seg = coords.slice(1).map((c, i) => haversineM({ lat: coords[i].lat, lon: coords[i].lng }, { lat: c.lat, lon: c.lng }))
    const half = seg.reduce((a, b) => a + b, 0) / 2
    let run = 0
    for (let i = 0; i < seg.length; i++) {
      if (run + seg[i] >= half) {
        const f = seg[i] === 0 ? 0 : (half - run) / seg[i]
        return {
          lat: coords[i].lat + (coords[i + 1].lat - coords[i].lat) * f,
          lon: coords[i].lng + (coords[i + 1].lng - coords[i].lng) * f,
        }
      }
      run += seg[i]
    }
    return { lat: coords[coords.length - 1].lat, lon: coords[coords.length - 1].lng }
  }

  /** Door cards still call this with an Entrance. */
  function drawRouteToEntrance(e: Entrance) {
    void drawRoute({ lat: e.lat, lon: e.lon }, pathDoorName(e), e)
  }


  function streetView(e: Entrance): HTMLElement | null {
    if (!map) return null
    // The outer box is one image for assistive tech. The panorama goes in an inert
    // inner box: Google's own links and shortcut buttons inside role=img were invalid
    // (nested-interactive) and added seven junk Tab stops before the tabs.
    const box = h('div', { class: 'gm-photo', role: 'img', 'aria-label': t.streetViewAlt })
    const pano = h('div', { class: 'gm-photo-pano', inert: '', 'aria-hidden': 'true', style: 'position:absolute;inset:0' })
    box.append(pano)
    new google.maps.StreetViewService().getPanorama({ location: { lat: e.lat, lng: e.lon }, radius: 40 }, (data, st) => {
      // The card may be closed or replaced by the time the lookup answers.
      if (gone || !box.isConnected) return
      if (st !== google.maps.StreetViewStatus.OK || !data?.location?.latLng) {
        box.remove()
        return
      }
      const from = data.location.latLng
      const heading = google.maps.geometry?.spherical ? google.maps.geometry.spherical.computeHeading(from, { lat: e.lat, lng: e.lon }) : bearingFromTo(from.lat(), from.lng(), e.lat, e.lon)
      panos.push({ div: pano, p: new google.maps.StreetViewPanorama(pano, { pano: data.location.pano, pov: { heading, pitch: 5 }, disableDefaultUI: true, clickToGo: false, linksControl: false, motionTracking: false }) })
    })
    return box
  }

  function tipsCard(e: Entrance): HTMLElement {
    const tips: string[] = []
    if (e.stepFree === true) tips.push(t.tipStepFree)
    if (e.stepFree === false) tips.push(t.tipNotStepFree)
    if (e.door) tips.push(`${t.door[e.door] ?? e.door}${e.automatic ? `, ${t.automatic}` : ''}.`)
    // Warnings are not tips: they sit right under the actions (warningsBlock), once.
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

    const start = () => beginGuidance(e)
    // The card's own View pill is the one way in; a second floating View button beside
    // it read as two different features. viewBtn stays as the Lens shortcut's target.
    viewBtn.hidden = true
    viewBtn.onclick = () => void start()

    // Like Maps' Directions/Start: one filled Google-blue action leads the row. For a
    // door that can carry guidance it is View, and one tap opens the guidance itself.
    const canGuide = g.kind === 'arrow'
    const pills = h(
      'div',
      { class: 'gm-actions' },
      canGuide
        ? h('button', { class: 'gm-pill gm-pill-view', type: 'button', 'aria-label': 'Live View zum Eingang starten', style: 'background:#1a73e8;color:#fff;min-height:48px', onclick: () => void start() }, icon('view_in_ar', true), t.view)
        : null,
      h('button', { class: canGuide ? 'gm-pill' : 'gm-pill gm-pill-primary', type: 'button', onclick: () => drawRouteToEntrance(e) }, icon('assistant_direction', true), t.route),
      h('button', { class: 'gm-pill', type: 'button', onclick: () => void share(e) }, icon('ios_share'), t.share),
    )

    const overview = h(
      'div',
      { class: 'gm-tabpanel' },
      tipsCard(e),
      g.kind === 'arrow' ? null : h('p', { class: 'reason' }, reasonText[g.reason]),
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
    // ARIA tab pattern, as in PlaceCard: roving tabindex, arrows/Home/End, linked panels.
    panels.forEach((p, i) => {
      p.setAttribute('role', 'tabpanel')
      p.id = `gm-panel-${i}`
      p.setAttribute('aria-labelledby', `gm-tab-${i}`)
    })
    const tabBtns: HTMLButtonElement[] = []
    const selectTab = (i: number, focus = false) => {
      tabBtns.forEach((x, j) => {
        x.setAttribute('aria-selected', String(j === i))
        x.tabIndex = j === i ? 0 : -1
      })
      panels.forEach((p, j) => (p.hidden = j !== i))
      if (i === 2 && !photos.childElementCount) {
        const sv = streetView(e)
        photos.append(sv ?? h('p', { class: 'gm-p' }, t.noPhotos))
      }
      if (focus) tabBtns[i].focus()
    }
    const tabs = h(
      'div',
      { class: 'gm-tabs', role: 'tablist' },
      ...[t.tabOverview, t.tabReviews, t.tabPhotos].map((label, i) => {
        const b2 = h('button', { class: 'gm-tabbtn', type: 'button', role: 'tab', id: `gm-tab-${i}`, 'aria-controls': `gm-panel-${i}`, 'aria-selected': String(i === 0), tabindex: i === 0 ? '0' : '-1' }, label) as HTMLButtonElement
        b2.addEventListener('click', () => selectTab(i))
        b2.addEventListener('keydown', (ev) => {
          const n = tabBtns.length
          const to = ev.key === 'ArrowRight' ? (i + 1) % n : ev.key === 'ArrowLeft' ? (i + n - 1) % n : ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : -1
          if (to < 0) return
          ev.preventDefault()
          selectTab(to, true)
        })
        tabBtns.push(b2)
        return b2
      }),
    )

    // A revolving door or steps decide whether this door works at all for a wheelchair:
    // named in the subtitle and shown right under the actions, above the fold.
    const warnShort = e.warnings.map((w) => (t.warning[w] ?? w).split('.')[0])
    showCard(e, cardHead(doorName(e, origin(), buildings), e), h('p', { class: 'gm-sheet-sub' }, [stepFreeLabel(e.stepFree), ...warnShort, t.metresShort(haversineM(origin(), e)), b?.name ?? b?.addr ?? null].filter(Boolean).join(' · ')), pills, warningsBlock(e), streetView(e), tabs, ...panels)
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
    clearRoute(false)
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
  /** Places already fetched this session. A second tap on the same POI is instant. */
  const placeCache = new Map<string, PlaceHit>()
  /** Set while a place card owns the sheet. `selected` only tracks doors, so without
   *  this the map's own idle/geolocation callbacks re-render the nearby list over the
   *  card a moment after it opens. */
  let placeOpen = false
  let placeInFlight: string | null = null

  /**
   * A POI tap must feel instant. Google raises the sheet on touch and fills it in
   * afterwards; awaiting the network first left a dead half-second with nothing but a
   * status label, which is what read as lag.
   *
   * So: pan and raise the sheet on the same frame as the tap, show a skeleton, then
   * swap in the real card. Repeat taps are served from cache.
   */
  async function openPlaceById(placeId: string, at?: google.maps.LatLng | null) {
    const cached = placeCache.get(placeId)
    if (cached) {
      openPlace(cached)
      return
    }
    if (placeInFlight === placeId) return // second tap while the first is still running
    placeInFlight = placeId
    const epoch = ++sheetEpoch
    placeOpen = true // claim the sheet immediately; the skeleton is about to fill it

    // --- immediate, same frame as the tap ---
    clearRoute(false)
    if (at) map?.panTo(at)
    selected = null
    panelCleanup?.()
    panelCleanup = null
    chips.hidden = true
    morePill.hidden = false
    goBtn.hidden = true
    setSheet('half')
    renderPlaceSkeleton()

    try {
      const hit = await fetchPlaceById(placeId)
      if (hit) placeCache.set(placeId, hit)
      // The user tapped something else while this loaded: keep the answer, not the card.
      if (epoch !== sheetEpoch || gone) return
      if (hit) openPlace(hit)
      else closePlaceSkeleton()
    } catch (err) {
      console.warn('[doorway] place lookup failed', err)
      if (epoch === sheetEpoch && !gone) closePlaceSkeleton()
    } finally {
      if (placeInFlight === placeId) placeInFlight = null
    }
  }

  /** Back from a skeleton that never became a card: the chips and buttons it hid return. */
  function closePlaceSkeleton() {
    placeOpen = false
    renderSheet()
    setSheet(placeHits.length ? 'half' : 'peek')
  }

  /** Grey bars in the shape of the card that is coming, so the sheet is never empty. */
  function renderPlaceSkeleton() {
    sheetBody.replaceChildren(
      h('div', { class: 'pc-skel', 'aria-busy': 'true', 'aria-label': t.loading ?? 'Lädt' },
        h('div', { class: 'pc-skel-line pc-skel-title' }),
        h('div', { class: 'pc-skel-line pc-skel-sub' }),
        h('div', { class: 'pc-skel-line pc-skel-row' }),
        h('div', { class: 'pc-skel-photo' }),
      ),
    )
  }


  function openPlace(p: PlaceHit) {
    sheetEpoch++
    clearRoute(false)
    selected = null
    placeOpen = true
    lastPlace = p
    panelCleanup?.()
    chips.hidden = true
    morePill.hidden = false
    goBtn.hidden = true
    map?.panTo({ lat: p.lat, lng: p.lon })
    panelCleanup = null
    try {
      panelCleanup = renderPlaceCard(sheetBody, featureCtx, p, () => {
        placeOpen = false
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
      sheetEpoch++
      if (status.textContent === t.loading) status.textContent = ''
      clearPlaces()
      renderSheet()
      return
    }
    activePlaceChip = id
    const epoch = ++sheetEpoch
    placeChips.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.chip === id)))
    status.textContent = t.loading
    try {
      const hits = await searchCategory(map, id)
      if (epoch !== sheetEpoch || gone) return
      status.textContent = hits.length ? '' : t.searchNoResults
      showPlaces(hits, label)
    } catch (err) {
      if (epoch !== sheetEpoch || gone) return
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
  const runQuery = (q: string) => {
    setSearchQuery(q)
    if (!map) return
    const epoch = ++sheetEpoch
    status.textContent = t.loading
    searchText(map, q)
      .then((hits) => {
        if (epoch !== sheetEpoch || gone) return
        status.textContent = hits.length ? '' : t.searchNoResults
        showPlaces(hits, q)
      })
      .catch((err) => {
        if (epoch !== sheetEpoch || gone) return
        status.textContent = err instanceof PlacesUnavailable ? err.message : t.placesError
      })
  }
  // Tapping the bar opens the full-screen search like Maps. Click also fires for Enter
  // and Space, and focus alone never opens it; closing hands focus back to the pill.
  let searchOpen = false
  searchInput.addEventListener('click', () => {
    if (searchOpen) return
    searchOpen = true
    let close: () => void = () => {}
    try {
      close = openSearchScreen(root, {
        initial: searchQuery,
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
          // Safari does not focus a tapped button, so the screen may have nothing to
          // hand focus back to. The pill is where the user came from.
          if (!document.activeElement || document.activeElement === document.body) searchInput.focus({ preventScroll: true })
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
    }
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
        const q = (ev.results[0]?.[0]?.transcript ?? '').trim()
        if (q) runQuery(q)
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
        if (navOn) updateNav()
        resumeNav()
        if (first) {
          if (!opts.openDoor) map?.setCenter({ lat: me.lat, lng: me.lon })
          if (!map) void load(bboxAround(me.lat, me.lon, 500))
        }
        backgroundRender()
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000 },
    )
  }

  const key = mapsKey()
  if (key) {
    loadMaps(key)
      .then(() => {
        if (gone) return
        const c = me ?? DEFAULT_CENTER
        if (sharedMap?.el === mapEl) {
          map = sharedMap.map
          if (me && !opts.openDoor) map.setCenter({ lat: me.lat, lng: me.lon })
        } else map = new google.maps.Map(mapEl, {
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
        sharedMap = { el: mapEl, map }
        drawMe()
        resumeNav()
        if (opts.openDoor)
          void findEntrance(opts.openDoor).then((e) => {
            if (e) map?.setCenter({ lat: e.lat, lng: e.lon })
          })
        mapListeners.push(map.addListener('click', (ev: google.maps.MapMouseEvent | google.maps.IconMouseEvent) => {
          const placeId = (ev as google.maps.IconMouseEvent).placeId
          if (placeId) {
            // A Google POI was tapped. Suppress the default InfoWindow and show our card.
            ev.stop?.()
            void openPlaceById(placeId, ev.latLng)
            return
          }
          // A panel (editor, business) may use map taps itself: do not collapse it then.
          if (panelCleanup) return
          if (sheet.dataset.state !== 'peek') setSheet('peek')
        }))
        const loadView = () => {
          const bb = map?.getBounds()
          if (!bb) return
          const ne = bb.getNorthEast()
          const sw = bb.getSouthWest()
          void load({ south: sw.lat(), west: sw.lng(), north: ne.lat(), east: ne.lng() })
        }
        mapListeners.push(map.addListener('idle', loadView))
        // A reused map is already idle and will not say so again until it moves.
        loadView()
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

  /** Live View closed from nav mode: straight back into nav on the same door. */
  let resumed = !opts.resumeNav
  function resumeNav() {
    const d = opts.resumeNav
    if (resumed || !d || !map || !me) return
    resumed = true
    const to = { lat: d.lat, lon: d.lon }
    const again = () => void drawRoute(to, d.name, d.door)
    void drawRoute(to, d.name, d.door).then((r) => {
      if (r && !gone) startNav({ ...to, name: d.name, door: d.door && liveViewMode(d.door, opts.profile) === 'door' ? d.door : null }, r, again)
    })
  }

  function teardown() {
    if (gone) return
    gone = true
    disposePanos()
    try {
      panelCleanup?.()
    } catch {
      /* ignore */
    }
    placeMarkers.forEach((m) => m.setMap(null))
    if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch)
    geoWatch = null
    mapListeners.splice(0).forEach((l) => l.remove())
    markers.forEach((m) => m.setMap(null))
    meMarker?.setMap(null)
    clearRoute(false)
  }
  return teardown
}

function bearingFromTo(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r)
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r)
  return ((Math.atan2(y, x) / r) + 360) % 360
}
