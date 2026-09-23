// Screen 3: Google Maps JS with entrance markers, plus an always-present text list
// (the list is the VoiceOver path and the fallback when no Maps key is configured).
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

export function MapView(opts: { profile: Profile; onGuide: (target: ArrowTarget) => void; onSettings: () => void }): () => void {
  let entrances: Entrance[] = []
  let buildings: Building[] = []
  let me: LatLon | null = null
  let map: google.maps.Map | null = null
  let markers: google.maps.Marker[] = []
  let geoWatch: number | null = null
  let lastBox = ''

  const status = h('p', { class: 'status' }, t.loading)
  const mapEl = h('div', { class: 'map', role: 'region', 'aria-label': t.mapTitle })
  const list = h('ul', { class: 'door-list' })
  const sheet = h('dialog', { class: 'sheet', 'aria-labelledby': 'sheet-title' }) as HTMLDialogElement

  mount(
    h(
      'section',
      { class: 'screen screen-map', 'aria-labelledby': 'map-title' },
      h('header', { class: 'bar' }, h('h1', { id: 'map-title' }, t.mapTitle), h('button', { class: 'btn btn-small', type: 'button', onclick: opts.onSettings }, t.settings)),
      status,
      mapEl,
      h('h2', {}, t.listTitle),
      list,
      sheet,
    ),
  )

  const origin = () => me ?? (map?.getCenter() ? { lat: map.getCenter()!.lat(), lon: map.getCenter()!.lng() } : DEFAULT_CENTER)

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
      renderList()
    } catch {
      status.textContent = t.noDoors
    }
  }

  function renderList() {
    const o = origin()
    const doors = entrances
      .filter((e) => markerKind(e) !== 'no-marker')
      .map((e) => ({ e, d: haversineM(o, e) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, LIST_MAX)
    list.replaceChildren(
      ...(doors.length
        ? doors.map(({ e, d }) =>
            h(
              'li',
              {},
              h(
                'button',
                { class: `door door-${markerKind(e)}`, type: 'button', onclick: () => openEntrance(e) },
                h('span', { class: 'door-shape', 'aria-hidden': 'true' }),
                h('span', { class: 'door-name' }, e.name ?? t.unnamedEntrance),
                h('span', { class: 'door-meta' }, `${stepFreeLabel(e.stepFree)}, ${t.metresShort(d)}${e.warnings.length ? `, ${t.warningPrefix}: ${e.warnings.map((w) => t.door[w] ?? w).join(', ')}` : ''}`),
              ),
            ),
          )
        : [h('li', {}, t.noDoors)]),
    )
  }

  function renderMarkers() {
    if (!map) return
    markers.forEach((m) => m.setMap(null))
    markers = []
    for (const e of entrances) {
      const k = markerKind(e)
      if (k === 'no-marker') continue
      const size = k === 'step-free' ? BASE_PIN * 1.4 : BASE_PIN
      const m = new google.maps.Marker({
        map,
        position: { lat: e.lat, lng: e.lon },
        title: `${e.name ?? t.unnamedEntrance}, ${stepFreeLabel(e.stepFree)}`,
        icon: { url: k === 'step-free' ? ICON_STEP_FREE : ICON_NOT_STEP_FREE, scaledSize: new google.maps.Size(size, size), anchor: new google.maps.Point(size / 2, size / 2) },
        zIndex: k === 'step-free' ? 2 : 1,
        opacity: k === 'step-free' ? 1 : 0.85,
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
    const btn = h('button', { class: 'btn btn-secondary', type: 'button' }, t.livedButton)
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
    return h('div', {}, btn, out)
  }

  function showSheet(...children: (Node | null)[]) {
    sheet.replaceChildren(...children.filter((c): c is Node => c !== null), h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => sheet.close() }, t.close))
    if (!sheet.open) sheet.showModal()
    sheet.querySelector<HTMLElement>('h2')?.focus()
  }

  function openEntrance(e: Entrance) {
    const g = guidanceFor(e, opts.profile)
    const b = e.buildingId ? buildings.find((x) => x.id === e.buildingId) : undefined
    const unknownNearby = entrances.filter((x) => x.id !== e.id && x.tier === 0 && haversineM(x, e) <= NEARBY_UNKNOWN_M).length
    const facts: [string, string][] = [
      [t.accessLabel, stepFreeLabel(e.stepFree)],
      ...(e.door ? [[t.doorLabel, `${t.door[e.door] ?? e.door}${e.automatic ? `, ${t.automatic}` : ''}`] as [string, string]] : []),
      ...(e.level !== null ? [[t.levelLabel, String(e.level)] as [string, string]] : []),
      ...(e.approachBearing !== null ? [[t.approachLabel, t.faceToEnter(t.compass[Math.round(e.approachBearing / 45) % 8])] as [string, string]] : []),
      [t.confidenceLabel, t.confidence[e.confidence] ?? e.confidence],
    ]
    showSheet(
      h('h2', { id: 'sheet-title', tabindex: '-1' }, e.name ?? t.unnamedEntrance),
      warningsBlock(e),
      h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      e.description ? h('p', {}, e.description) : null,
      b?.accessSummary.tier === 2 ? h('p', {}, t.buildingReported) : null,
      unknownNearby ? h('p', { class: 'hint' }, t.nearbyUnknown(unknownNearby)) : null,
      g.kind === 'arrow'
        ? h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                sheet.close()
                teardown()
                opts.onGuide(g.target)
              },
            },
            t.guideMe,
          )
        : h('p', { class: 'reason' }, reasonText[g.reason]),
      livedSection(b),
    )
  }

  function openBuilding(b: Building) {
    showSheet(
      h('h2', { id: 'sheet-title', tabindex: '-1' }, b.name ?? b.addr ?? t.unnamedEntrance),
      b.addr ? h('p', {}, b.addr) : null,
      h('p', {}, t.buildingReported),
      h('p', { class: 'reason' }, t.reasonNotTier1),
      livedSection(b),
    )
  }

  // ---- position + data ----
  if ('geolocation' in navigator) {
    geoWatch = navigator.geolocation.watchPosition(
      (p) => {
        const first = !me
        me = { lat: p.coords.latitude, lon: p.coords.longitude }
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
        map = new google.maps.Map(mapEl, { center: { lat: c.lat, lng: c.lon }, zoom: 18, clickableIcons: false, gestureHandling: 'greedy' })
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
        void load(bboxAround(origin().lat, origin().lon, 500))
      })
  } else {
    mapEl.classList.add('map-off')
    mapEl.replaceChildren(h('p', { class: 'hint' }, t.mapUnavailable))
    void load(bboxAround(DEFAULT_CENTER.lat, DEFAULT_CENTER.lon, 500))
  }
  announce(t.mapTitle)

  function teardown() {
    if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch)
    markers.forEach((m) => m.setMap(null))
  }
  return teardown
}
