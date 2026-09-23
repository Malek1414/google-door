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
import { bboxAround, fetchEntrances, fetchLived, type BBox } from '../data'
import { announce } from '../session'
import { t } from '../strings'
import { h, mount } from './dom'

const DEFAULT_CENTER: LatLon = { lat: 52.5251, lon: 13.3694 } // Berlin Hauptbahnhof
const BASE_PIN = 32
const NEARBY_UNKNOWN_M = 30
const LIST_MAX = 15
const SEARCH_MAX = 6

// ---- marker icons (SVG data URIs; no external assets) ----
const svgUrl = (svg: string) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
const GLYPH =
  '<circle cx="15" cy="6.5" r="2.6" fill="#000"/><path d="M14.5 10.5V18H21L24 24.5" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 14H20" stroke="#000" stroke-width="2.2" stroke-linecap="round"/><path d="M11 14.5A6.5 6.5 0 1 0 20.5 22.5" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round"/>'
const ICON_STEP_FREE = svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 36 36"><circle cx="16" cy="16" r="15" fill="#FFD60A" stroke="#000" stroke-width="3.5"/>${GLYPH}</svg>`)
const ICON_NOT_STEP_FREE = svgUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M16 2L30 16L16 30L2 16Z" fill="#9AA0A6" fill-opacity="0.75" stroke="#202124" stroke-width="2.5"/><path d="M10 16H22" stroke="#202124" stroke-width="3" stroke-linecap="round"/></svg>',
)
const ICON_TIER2 = svgUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#000" stroke-width="5" stroke-dasharray="6 4"/><circle cx="20" cy="20" r="16" fill="none" stroke="#FFD60A" stroke-width="2.5" stroke-dasharray="6 4"/></svg>',
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
type Filter = { stepFree: boolean; withSteps: boolean }

/** Material Symbols glyph. Decorative: the text next to it carries the meaning. */
const icon = (name: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, name)

export function MapView(opts: { profile: Profile; onGuide: (target: ArrowTarget) => void; onSettings: () => void }): () => void {
  let entrances: Entrance[] = []
  let buildings: Building[] = []
  let me: LatLon | null = null
  let map: google.maps.Map | null = null
  let markers: google.maps.Marker[] = []
  let meMarker: google.maps.Marker | null = null
  let geoWatch: number | null = null
  let lastBox = ''
  let selected: Entrance | Building | null = null
  // A step-free profile starts with only step-free doors shown; the chip turns the rest on.
  const filter: Filter = { stepFree: true, withSteps: !opts.profile.stepFreeRequired }

  // ---- shell ----
  const status = h('p', { class: 'gm-status', role: 'status' }, t.loading)
  const mapEl = h('div', { class: 'gm-map', role: 'region', 'aria-label': t.mapTitle })

  const searchInput = h('input', { class: 'gm-search-input', type: 'search', placeholder: t.searchPlaceholder, 'aria-label': t.searchLabel, autocomplete: 'off', enterkeyhint: 'search' }) as HTMLInputElement
  const results = h('ul', { class: 'gm-results', role: 'listbox', 'aria-label': t.searchLabel, hidden: true })
  const avatar = h('button', { class: 'gm-avatar', type: 'button', 'aria-label': t.profileButton, onclick: opts.onSettings }, icon('accessible'))
  const search = h('div', { class: 'gm-search' }, icon('search'), searchInput, avatar)

  const chip = (label: string, key: keyof Filter, shape: string) => {
    const b = h('button', { class: 'gm-chip', type: 'button', 'aria-pressed': String(filter[key]) }, h('span', { class: `gm-chip-shape ${shape}`, 'aria-hidden': 'true' }), label)
    b.addEventListener('click', () => {
      filter[key] = !filter[key]
      b.setAttribute('aria-pressed', String(filter[key]))
      renderMarkers()
      renderList()
    })
    return b
  }
  const chips = h('div', { class: 'gm-chips', role: 'group', 'aria-label': t.filterLabel }, chip(t.chipStepFree, 'stepFree', 'shape-step-free'), chip(t.chipWithSteps, 'withSteps', 'shape-not-step-free'))

  const locateBtn = h('button', { class: 'gm-fab', type: 'button', 'aria-label': t.myLocation }, icon('my_location'))

  const sheetBody = h('div', { class: 'gm-sheet-body' })
  const handle = h('button', { class: 'gm-handle', type: 'button', 'aria-label': t.sheetHandle }, h('span', { 'aria-hidden': 'true' }))
  const sheet = h('section', { class: 'gm-sheet', 'data-state': 'half', 'aria-labelledby': 'sheet-title' }, handle, sheetBody)

  mount(
    h(
      'section',
      { class: 'gm', 'aria-labelledby': 'map-title' },
      h('h1', { id: 'map-title', class: 'sr-only' }, t.mapTitle),
      mapEl,
      h('div', { class: 'gm-top' }, search, results, chips, status),
      locateBtn,
      sheet,
    ),
  )

  // ---- bottom sheet: three snap states, drag or tap the handle ----
  const setSheet = (st: SheetState) => {
    sheet.dataset.state = st
    sheet.style.removeProperty('--drag')
  }
  const order: SheetState[] = ['peek', 'half', 'full']
  handle.addEventListener('click', () => {
    const i = order.indexOf(sheet.dataset.state as SheetState)
    setSheet(i === order.length - 1 ? 'peek' : order[i + 1])
  })
  let dragY0: number | null = null
  let dragged = false
  handle.addEventListener('pointerdown', (ev) => {
    dragY0 = ev.clientY
    dragged = false
    handle.setPointerCapture(ev.pointerId)
  })
  handle.addEventListener('pointermove', (ev) => {
    if (dragY0 === null) return
    const dy = ev.clientY - dragY0
    if (Math.abs(dy) > 6) dragged = true
    sheet.style.setProperty('--drag', `${dy}px`)
  })
  handle.addEventListener('pointerup', (ev) => {
    if (dragY0 === null) return
    const dy = ev.clientY - dragY0
    dragY0 = null
    if (!dragged) return
    ev.preventDefault()
    const i = order.indexOf(sheet.dataset.state as SheetState)
    setSheet(order[Math.max(0, Math.min(order.length - 1, i + (dy < -40 ? 1 : dy > 40 ? -1 : 0)))])
  })
  // A drag ends with a click event too; swallow it so the state does not jump twice.
  handle.addEventListener('click', (ev) => { if (dragged) { ev.stopImmediatePropagation(); dragged = false } }, true)

  const origin = () => me ?? (map?.getCenter() ? { lat: map.getCenter()!.lat(), lon: map.getCenter()!.lng() } : DEFAULT_CENTER)
  const visible = (e: Entrance) => {
    const k = markerKind(e)
    return (k === 'step-free' && filter.stepFree) || (k === 'not-step-free' && filter.withSteps)
  }

  async function load(b: BBox) {
    const key = [b.south, b.west, b.north, b.east].map((x) => x.toFixed(4)).join(',')
    if (key === lastBox) return
    lastBox = key
    try {
      const r = await fetchEntrances(b)
      entrances = r.entrances
      buildings = r.buildings
      status.textContent = r.source === 'static' ? t.offlineData : ''
      if (r.source === 'static') console.warn('[doorway] /api/entrances unreachable, using static data/berlin-mitte.json')
      renderMarkers()
      if (!selected) renderList()
    } catch {
      status.textContent = t.noDoors
    }
  }

  // ---- list view (default sheet content) ----
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
        icon('chevron_right'),
      ),
    )
  }

  function renderList() {
    if (selected) return
    const o = origin()
    const doors = entrances
      .filter(visible)
      .map((e) => ({ e, d: haversineM(o, e) }))
      .sort((a, b) => a.d - b.d)
    sheetBody.replaceChildren(
      h('h2', { id: 'sheet-title', class: 'gm-sheet-title' }, t.mapTitle),
      h('p', { class: 'gm-sheet-sub' }, t.doorsCount(doors.length)),
      h('ul', { class: 'gm-list' }, ...(doors.length ? doors.slice(0, LIST_MAX).map(({ e, d }) => doorRow(e, d)) : [h('li', { class: 'gm-empty' }, t.noDoors)])),
    )
  }

  function renderMarkers() {
    if (!map) return
    markers.forEach((m) => m.setMap(null))
    markers = []
    for (const e of entrances) {
      if (!visible(e)) continue
      const k = markerKind(e)
      const big = k === 'step-free'
      const size = (big ? BASE_PIN * 1.4 : BASE_PIN) * (selected === e ? 1.25 : 1)
      const m = new google.maps.Marker({
        map,
        position: { lat: e.lat, lng: e.lon },
        title: `${e.name ?? t.unnamedEntrance}, ${stepFreeLabel(e.stepFree)}`,
        icon: { url: big ? ICON_STEP_FREE : ICON_NOT_STEP_FREE, scaledSize: new google.maps.Size(size, size), anchor: new google.maps.Point(size / 2, size / 2) },
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

  // ---- place card (sheet content for one door or building) ----
  function showCard(item: Entrance | Building, ...children: (Node | null)[]) {
    selected = item
    renderMarkers()
    const back = h('button', { class: 'gm-icon-btn', type: 'button', 'aria-label': t.back, onclick: closeCard }, icon('arrow_back'))
    sheetBody.replaceChildren(h('div', { class: 'gm-card-head' }, back), ...children.filter((c): c is Node => c !== null))
    if (sheet.dataset.state === 'peek') setSheet('half')
    sheetBody.querySelector<HTMLElement>('h2')?.focus()
  }
  function closeCard() {
    selected = null
    renderMarkers()
    renderList()
    sheetBody.querySelector<HTMLElement>('h2')?.focus()
  }

  function fact(ic: string, label: string, value: string) {
    return h('li', { class: 'gm-fact' }, icon(ic), h('span', {}, h('span', { class: 'gm-fact-label' }, label), h('span', { class: 'gm-fact-value' }, value)))
  }

  function openEntrance(e: Entrance) {
    const g = guidanceFor(e, opts.profile)
    const b = e.buildingId ? buildings.find((x) => x.id === e.buildingId) : undefined
    const unknownNearby = entrances.filter((x) => x.id !== e.id && x.tier === 0 && haversineM(x, e) <= NEARBY_UNKNOWN_M).length
    const d = haversineM(origin(), e)
    map?.panTo({ lat: e.lat, lng: e.lon })
    const action =
      g.kind === 'arrow'
        ? h('div', { class: 'gm-actions' }, h(
            'button',
            {
              class: 'gm-pill gm-pill-primary',
              type: 'button',
              onclick: () => {
                teardown()
                opts.onGuide(g.target)
              },
            },
            icon('navigation'),
            t.guideMe,
          ))
        : h('p', { class: 'reason' }, reasonText[g.reason])
    showCard(
      e,
      h('h2', { id: 'sheet-title', class: 'gm-sheet-title', tabindex: '-1' }, e.name ?? t.unnamedEntrance),
      h('p', { class: 'gm-sheet-sub' }, [stepFreeLabel(e.stepFree), t.metresShort(d), b?.name ?? b?.addr ?? null].filter(Boolean).join(' · ')),
      action,
      warningsBlock(e),
      h('h3', { class: 'gm-h3' }, t.accessSection),
      h(
        'ul',
        { class: 'gm-facts' },
        fact('accessible', t.accessLabel, stepFreeLabel(e.stepFree)),
        e.door ? fact('door_front', t.doorLabel, `${t.door[e.door] ?? e.door}${e.automatic ? `, ${t.automatic}` : ''}`) : null,
        e.level !== null ? fact('stairs', t.levelLabel, String(e.level)) : null,
        e.approachBearing !== null ? fact('explore', t.approachLabel, t.faceToEnter(t.compass[Math.round(e.approachBearing / 45) % 8])) : null,
        fact('verified', t.confidenceLabel, t.confidence[e.confidence] ?? e.confidence),
      ),
      e.description ? h('p', {}, e.description) : null,
      b?.accessSummary.tier === 2 ? h('p', {}, t.buildingReported) : null,
      unknownNearby ? h('p', { class: 'hint' }, t.nearbyUnknown(unknownNearby)) : null,
      livedSection(b),
    )
  }

  function openBuilding(b: Building) {
    map?.panTo({ lat: b.centroid[0], lng: b.centroid[1] })
    showCard(
      b,
      h('h2', { id: 'sheet-title', class: 'gm-sheet-title', tabindex: '-1' }, b.name ?? b.addr ?? t.unnamedEntrance),
      b.addr ? h('p', { class: 'gm-sheet-sub' }, b.addr) : null,
      h('p', {}, t.buildingReported),
      h('p', { class: 'reason' }, t.reasonNotTier1),
      livedSection(b),
    )
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
  searchInput.addEventListener('input', renderResults)
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') results.querySelector<HTMLButtonElement>('button')?.click()
    if (ev.key === 'Escape') results.hidden = true
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
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#1a73e8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
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
          map?.setCenter({ lat: me.lat, lng: me.lon })
          if (!map) void load(bboxAround(me.lat, me.lon, 500))
        }
        renderList()
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
          zoom: 18,
          clickableIcons: false,
          gestureHandling: 'greedy',
          disableDefaultUI: true,
          keyboardShortcuts: true,
        })
        drawMe()
        map.addListener('click', () => {
          results.hidden = true
          if (sheet.dataset.state === 'full') setSheet('half')
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
  renderList()
  announce(t.mapTitle)

  function teardown() {
    if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch)
    markers.forEach((m) => m.setMap(null))
    meMarker?.setMap(null)
  }
  return teardown
}
