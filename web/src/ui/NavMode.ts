// Walking navigation screen, like Google Maps after Start: heading-up map that follows the
// user, green manoeuvre banner on top, white ETA bar below. Movement comes from a fix
// stream (core/position.ts watchFixes, injectable); progress maths is core/navProgress.ts.

import { mapsKey } from '../config'
import { instructionLine, maneuverGlyph, type Route } from '../core/route'
import { progress, splitPath, type NavFix, type NavState } from '../core/navProgress'
import { watchFixes } from '../core/position'
import { h } from './dom'
import './nav.css'

export type FixWatcher = (onFix: (f: NavFix) => void, onError?: (e: unknown) => void) => () => void

export interface NavOpts {
  route: Route
  destination: { lat: number; lng: number; name: string }
  onArrive: () => void
  onExit: () => void
  onLiveView?: () => void
  /** Called once each time the user leaves the route (re-routing belongs to the caller). */
  onOffRoute?: (fix: NavFix) => void
  /** Called with the new instruction when the step changes, for the caller's voice. */
  onStepChange?: (text: string) => void
  /** Fix source. Defaults to core/position.ts watchFixes; tests inject their own. */
  watch?: FixWatcher
  /** Parent element, default document.body. */
  parent?: HTMLElement
}

const T = {
  exit: 'Beenden',
  live: 'Live View',
  recenter: 'Zentrieren',
  offRoute: 'Route wird neu berechnet',
  waiting: 'Standort wird gesucht',
  arrive: 'Ziel erreicht',
  min: 'Min',
  nav: 'Navigation',
  toward: 'Richtung',
}

/** Reuse the page's Maps script (MapView loads it); only load it if nothing did. */
function mapsReady(): Promise<void> {
  if (window.google?.maps?.Map) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src*="maps.googleapis.com/maps/api/js"]')
    if (!existing) {
      const key = mapsKey()
      if (!key) return reject(new Error('no maps key'))
      const cb = '__doorwayNavMapsReady'
      ;(window as unknown as Record<string, () => void>)[cb] = () => resolve()
      const sc = document.createElement('script')
      sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=de&callback=${cb}`
      sc.async = true
      sc.onerror = () => reject(new Error('maps failed to load'))
      document.head.append(sc)
      return
    }
    const t0 = Date.now()
    const poll = setInterval(() => {
      if (window.google?.maps?.Map) {
        clearInterval(poll)
        resolve()
      } else if (Date.now() - t0 > 15000) {
        clearInterval(poll)
        reject(new Error('maps timeout'))
      }
    }, 100)
  })
}

export function formatNavDistance(m: number): string {
  if (m < 1000) return `${Math.max(0, Math.round(m / (m < 100 ? 5 : 10)) * (m < 100 ? 5 : 10))} m`
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`
}

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const CONE = 'M 0 0 L -14 -34 A 36 36 0 0 1 14 -34 Z'

export function openNav(opts: NavOpts): () => void {
  const { route, destination } = opts
  const ms = (n: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, n)

  const icon = ms('straight')
  const dist = h('div', { class: 'nav-dist' }, '')
  const instr = h('div', { class: 'nav-instr' }, T.waiting)
  const offLine = h('div', { class: 'nav-off', hidden: true }, T.offRoute)
  const live = h('div', { class: 'nav-sr', role: 'status', 'aria-live': 'polite' }, '')
  const banner = h('div', { class: 'nav-banner' }, h('div', { class: 'nav-ic' }, icon), h('div', { class: 'nav-txt' }, dist, instr), offLine, live)

  const etaMin = h('span', { class: 'nav-eta-min' }, '')
  const etaSub = h('span', { class: 'nav-eta-sub' }, '')
  const exitBtn = h('button', { class: 'nav-exit', type: 'button', 'aria-label': T.exit }, ms('close'))
  const liveBtn = opts.onLiveView
    ? h('button', { class: 'nav-live', type: 'button' }, ms('view_in_ar'), h('span', {}, T.live))
    : null
  const bottom = h(
    'div',
    { class: 'nav-bottom' },
    exitBtn,
    h('div', { class: 'nav-eta' }, etaMin, etaSub),
    ...(liveBtn ? [liveBtn] : []),
  )
  const recenter = h('button', { class: 'nav-recenter', type: 'button', hidden: true }, ms('navigation'), h('span', {}, T.recenter))
  const mapEl = h('div', { class: 'nav-map' })
  const root = h('section', { class: 'nav-root', 'aria-label': `${T.nav} ${T.toward} ${destination.name}` }, mapEl, banner, recenter, bottom)
  ;(opts.parent ?? document.body).append(root)

  let closed = false
  let state: NavState | undefined
  let lastFix: NavFix | null = null
  let following = true
  let announcedStep = -1
  let wasOff = false
  let arrivedFired = false
  let stopWatch: (() => void) | null = null
  let map: google.maps.Map | null = null
  let walkedLine: google.maps.Polyline | null = null
  let aheadLine: google.maps.Polyline | null = null
  let aheadEdge: google.maps.Polyline | null = null
  let dot: google.maps.Marker | null = null
  let cone: google.maps.Marker | null = null
  let pin: google.maps.Marker | null = null
  const listeners: google.maps.MapsEventListener[] = []

  const onExit = () => {
    close()
    opts.onExit()
  }
  exitBtn.addEventListener('click', onExit)
  liveBtn?.addEventListener('click', () => opts.onLiveView?.())
  recenter.addEventListener('click', () => {
    following = true
    recenter.hidden = true
    follow()
  })

  function stepText(i: number): string {
    const st = route.steps[i]
    return instructionLine(st ?? null) ?? destination.name
  }

  function render() {
    if (!state) return
    const i = state.stepIndex
    const last = i >= route.steps.length - 1
    // The banner shows the manoeuvre at the END of the current step: that is the next turn.
    const next = route.steps[i + 1] ?? null
    const glyph = last ? 'flag' : (maneuverGlyph(next?.maneuver ?? null) ?? 'straight')
    icon.textContent = glyph
    dist.textContent = formatNavDistance(state.distToManeuverM)
    const text = last ? destination.name : stepText(i + 1)
    instr.textContent = state.arrived ? T.arrive : text
    if (i !== announcedStep) {
      announcedStep = i
      live.textContent = `${formatNavDistance(state.distToManeuverM)}, ${text}`
      opts.onStepChange?.(text)
    }
    offLine.hidden = !state.offRoute
    banner.classList.toggle('is-off', state.offRoute)
    const mins = Math.max(1, Math.round(state.etaS / 60))
    etaMin.textContent = `${mins} ${T.min}`
    etaSub.textContent = `${formatNavDistance(state.remainingM)} · ${clock(new Date(Date.now() + state.etaS * 1000))}`
  }

  function drawRoute() {
    if (!map || !state) return
    const { walked, ahead } = splitPath(route, state.alongM)
    walkedLine?.setPath(walked)
    aheadLine?.setPath(ahead)
    aheadEdge?.setPath(ahead)
  }

  function headingFor(f: NavFix | null, s: NavState): number {
    if (f?.headingDeg != null && (f.speed ?? 1) > 0.4) return f.headingDeg
    return s.bearingDeg
  }

  function drawMe() {
    if (!map || !state || !lastFix) return
    const pos = state.offRoute ? { lat: lastFix.lat, lng: lastFix.lng } : state.snapped
    const hd = headingFor(lastFix, state)
    dot?.setPosition(pos)
    cone?.setPosition(pos)
    const ic = cone?.getIcon() as google.maps.Symbol | undefined
    if (cone && ic) cone.setIcon({ ...ic, rotation: hd })
  }

  function follow() {
    if (!map || !state || !following || arrivedFired) return
    const pos = state.offRoute && lastFix ? { lat: lastFix.lat, lng: lastFix.lng } : state.snapped
    const hd = headingFor(lastFix, state)
    const cam = { center: pos, heading: hd, tilt: 45, zoom: 18.5 }
    if (typeof map.moveCamera === 'function') map.moveCamera(cam)
    else map.setCenter(pos)
  }

  function onFix(f: NavFix) {
    if (closed) return
    lastFix = f
    state = progress(route, f, state)
    render()
    drawRoute()
    drawMe()
    follow()
    if (state.offRoute && !wasOff) opts.onOffRoute?.(f)
    wasOff = state.offRoute
    if (state.arrived && !arrivedFired) {
      arrivedFired = true
      following = false
      stopWatch?.()
      stopWatch = null
      opts.onArrive()
    }
  }

  // Initial banner from the route alone, before the first fix.
  if (route.path.length) {
    const [lat, lng] = route.path[0]!
    state = progress(route, { lat, lng, accuracy: 999, headingDeg: null, speed: null, t: 0 })
    render()
    instr.textContent = stepText(0)
  }

  mapsReady()
    .then(() => {
      if (closed) return
      const start = state?.snapped ?? { lat: destination.lat, lng: destination.lng }
      map = new google.maps.Map(mapEl, {
        center: start,
        zoom: 18.5,
        tilt: 45,
        heading: state?.bearingDeg ?? 0,
        // A map ID is what switches on the vector renderer; heading and tilt need it.
        mapId: 'DEMO_MAP_ID',
        renderingType: google.maps.RenderingType?.VECTOR,
        disableDefaultUI: true,
        gestureHandling: 'greedy',
        keyboardShortcuts: true,
        clickableIcons: false,
      })
      const full = route.path.map(([lat, lng]) => ({ lat, lng }))
      aheadEdge = new google.maps.Polyline({ map, path: full, strokeColor: '#1558B0', strokeWeight: 11, strokeOpacity: 1, zIndex: 1 })
      aheadLine = new google.maps.Polyline({ map, path: full, strokeColor: '#4285F4', strokeWeight: 7, strokeOpacity: 1, zIndex: 2 })
      walkedLine = new google.maps.Polyline({ map, path: [], strokeColor: '#9AA0A6', strokeWeight: 7, strokeOpacity: 1, zIndex: 1 })
      pin = new google.maps.Marker({
        map,
        position: { lat: destination.lat, lng: destination.lng },
        title: destination.name,
        zIndex: 3,
      })
      cone = new google.maps.Marker({
        map,
        position: start,
        clickable: false,
        zIndex: 4,
        icon: { path: CONE, fillColor: '#4285F4', fillOpacity: 0.3, strokeWeight: 0, scale: 1, rotation: state?.bearingDeg ?? 0, anchor: new google.maps.Point(0, 0) },
      })
      dot = new google.maps.Marker({
        map,
        position: start,
        clickable: false,
        zIndex: 5,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#1A73E8', fillOpacity: 1, strokeColor: '#FFFFFF', strokeWeight: 3 },
      })
      const leave = () => {
        if (arrivedFired) return
        following = false
        recenter.hidden = false
      }
      listeners.push(map.addListener('dragstart', leave))
      drawRoute()
      drawMe()
      follow()
    })
    .catch(() => {
      mapEl.classList.add('nav-map-missing')
    })

  stopWatch = (opts.watch ?? watchFixes)(onFix, () => {
    if (!lastFix) instr.textContent = T.waiting
  })

  function close() {
    if (closed) return
    closed = true
    stopWatch?.()
    stopWatch = null
    for (const l of listeners) l.remove()
    listeners.length = 0
    for (const o of [walkedLine, aheadLine, aheadEdge, dot, cone, pin]) o?.setMap(null)
    if (map) google.maps.event.clearInstanceListeners(map)
    map = null
    root.remove()
  }

  return close
}
