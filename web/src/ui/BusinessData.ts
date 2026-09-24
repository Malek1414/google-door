// "Gesammelte Daten": shows the business owner everything this device stores or sees about
// their business, grouped like Google's "Your data" pages, with export and full delete.
// Only real local data and the entrances already loaded for the map; nothing is estimated.
// Text goes through h(), never innerHTML.

import './business-data.css'
import { deleteAnswers } from '../core/accessAnswers'
import { ACCESS_ATTRS, BUSINESS_DETAILS_KEY, DAYS, completeness, loadDetails, type BusinessDetails, type Tri } from '../core/businessDetails'
import { haversineM } from '../core/geo'
import {
  BUSINESS_KEY,
  deleteSurveyEntrance,
  loadBusiness,
  loadSurvey,
  saveBusiness,
  validLatLon,
  type BusinessProfile,
  type SurveyEntrance,
} from '../core/survey'
import type { DoorType, Entrance } from '../core/types'
import type { FeatureCtx } from './ctx'
import { h } from './dom'
import { doorName } from './doorName'

/** Same key as the device business list in Business.ts. */
const BUSINESSES_KEY = 'doorway.businesses'
/** Radius around the business pin for community and OpenStreetMap entrances. */
export const NEARBY_M = 60

const L = {
  title: 'Gesammelte Daten',
  back: 'Zurück',
  intro: 'Alles, was diese App über dein Unternehmen gespeichert hat oder in der Nähe sieht.',
  where: 'Diese Daten liegen nur auf diesem Gerät',
  whereSub: 'Gespeichert im Browser-Speicher. Es gibt keinen Server, der sie empfängt.',
  count: (n: number) => (n === 1 ? '1 Eintrag' : `${n} Einträge`),
  profile: 'Profil',
  complete: 'Vollständigkeit',
  profileEmpty: 'Das Profil wurde noch nicht bearbeitet. Gespeichert sind nur die Angaben beim Anlegen.',
  f: {
    name: 'Name', category: 'Kategorie', description: 'Beschreibung', phone: 'Telefon', website: 'Website',
    address: 'Adresse', position: 'Standort', hours: 'Öffnungszeiten', photos: 'Profilfotos',
    offered: 'Barrierefreiheit angeboten', updated: 'Zuletzt geändert',
  },
  closed: 'geschlossen',
  hoursRange: (a: string, b: string) => `${a} bis ${b} Uhr`,
  yes: 'Ja',
  no: 'Nein',
  none: 'Keine Angabe',
  access: 'Barrierefreiheit',
  entrances: 'Eingänge',
  entrancesEmpty: 'Noch keine Eingänge eingetragen.',
  byYou: 'Von dir eingetragen',
  e: {
    position: 'Position', stepFree: 'Stufenlos', door: 'Türart', automatic: 'Öffnet automatisch', bell: 'Klingel',
    width: 'Türbreite', distance: 'Entfernung', tactile: 'Tastbare Hinweise', ramp: 'Rampe', note: 'Notiz', created: 'Eingetragen am',
  },
  door: { no: 'Keine Tür', hinged: 'Flügeltür', sliding: 'Schiebetür', revolving: 'Karusselltür', yes: 'Tür' } as Record<DoorType, string>,
  photoAlt: (n: string) => `Foto: ${n}`,
  community: 'Von der Community gemeldet',
  communitySub: `Eingänge im Umkreis von ${NEARBY_M} m um deinen Standort. Nicht von dir, nicht bearbeitbar.`,
  communityEmpty: `Keine Meldungen im Umkreis von ${NEARBY_M} m.`,
  unconfirmed: 'noch nicht bestätigt',
  fromOsm: 'Aus OpenStreetMap',
  fromPlaces: 'Aus Google Places',
  fromCommunity: 'Community-Meldung',
  distance: (m: number) => `${Math.round(m)} m entfernt`,
  noPin: 'Ohne Standort lässt sich die Umgebung nicht prüfen.',
  tasks: 'Aufgaben und Wege',
  taskDone: 'erledigt',
  taskOpen: 'offen',
  walks: 'Aufgenommene Wege werden als Datei heruntergeladen und nicht in der App gespeichert.',
  export: 'Als Datei exportieren',
  exported: 'Datei wird heruntergeladen.',
  exportFailed: 'Export nicht möglich.',
  del: 'Alle Daten dieses Unternehmens löschen',
  confirm: (n: string) => `${n} mit Profil und allen eigenen Eingängen endgültig von diesem Gerät löschen? Das lässt sich nicht rückgängig machen.`,
  confirmYes: 'Ja, endgültig löschen',
  cancel: 'Abbrechen',
  deleted: 'Alle Daten des Unternehmens wurden gelöscht.',
  deleteFailed: 'Löschen nicht vollständig möglich. Der Browser-Speicher ist blockiert.',
}

const icon = (name: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, name)
let uid = 0

const yn = (v: unknown): string => (v === true ? L.yes : v === false ? L.no : L.none)
const verdict = (v: boolean | null): string => (v === true ? L.yes : v === false ? L.no : L.none)
const triText = (t: Tri): string => (t === 'ja' ? L.yes : t === 'nein' ? L.no : L.none)
const pos = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`
const date = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? L.none : d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })
}
type Extra = { widthCm?: unknown; bell?: unknown; tactile?: unknown; ramp?: unknown }

/** Everything collected about one business. Pure apart from reading storage. */
export interface CollectedData {
  business: BusinessProfile
  details: BusinessDetails | null
  own: SurveyEntrance[]
  community: { entry: SurveyEntrance; distanceM: number }[]
  nearby: { entrance: Entrance; distanceM: number }[]
}

export function collectBusinessData(business: BusinessProfile, loaded: Entrance[]): CollectedData {
  const survey = loadSurvey()
  const own = survey.filter((e) => e.businessId === business.id || business.entranceIds.includes(e.id))
  const pin = validLatLon(business.lat, business.lon) ? { lat: business.lat, lon: business.lon } : null
  const near = <T extends { lat: number; lon: number }>(list: T[]) =>
    pin ? list.filter((e) => validLatLon(e.lat, e.lon)).map((e) => ({ e, d: haversineM(pin, e) })).filter((x) => x.d <= NEARBY_M).sort((a, b) => a.d - b.d) : []
  const ownIds = new Set(own.map((e) => e.id))
  const community = near(survey.filter((e) => e.by === 'community' && !ownIds.has(e.id))).map((x) => ({ entry: x.e, distanceM: x.d }))
  // Survey entries are already listed above; only entrances that came from the map data remain.
  const external = loaded.filter((e) => !e.id.startsWith('survey/') && !e.id.startsWith('survey-'))
  const nearby = near(external).map((x) => ({ entrance: x.e, distanceM: x.d }))
  return { business, details: loadDetails(business.id), own, community, nearby }
}

function exportJson(data: CollectedData): void {
  const payload = {
    exportiertAm: new Date().toISOString(),
    speicherort: L.where,
    unternehmen: data.business,
    profil: data.details,
    eingaenge: data.own,
    communityMeldungen: data.community.map((c) => ({ ...c.entry, entfernungM: Math.round(c.distanceM) })),
    openStreetMap: data.nearby.map((n) => ({ ...n.entrance, entfernungM: Math.round(n.distanceM) })),
    aufgaben: data.business.tasks,
    wege: L.walks,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const slug = data.business.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'unternehmen'
  const a = h('a', { href: url, download: `doorway-daten-${slug}.json` })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Remove the business, its profile details and its own survey entries. Returns false if any write failed. */
export function deleteBusinessData(business: BusinessProfile): boolean {
  let ok = true
  const survey = loadSurvey()
  for (const e of survey) {
    if (e.businessId === business.id || business.entranceIds.includes(e.id)) ok = deleteSurveyEntrance(e.id) && ok
  }
  try {
    const raw = localStorage.getItem(BUSINESS_DETAILS_KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    if (all && typeof all === 'object' && business.id in all) {
      delete all[business.id]
      localStorage.setItem(BUSINESS_DETAILS_KEY, JSON.stringify(all))
    }
    ok = deleteAnswers(business.id) && ok
    const listRaw = JSON.parse(localStorage.getItem(BUSINESSES_KEY) ?? '[]') as unknown
    const rest = Array.isArray(listRaw) ? listRaw.filter((x) => !(x && typeof x === 'object' && (x as { id?: unknown }).id === business.id)) : []
    localStorage.setItem(BUSINESSES_KEY, JSON.stringify(rest))
    if (loadBusiness()?.id === business.id) {
      const next = rest.find((x): x is BusinessProfile => !!x && typeof x === 'object' && typeof (x as BusinessProfile).id === 'string')
      if (next) ok = saveBusiness(next) && ok
      else localStorage.removeItem(BUSINESS_KEY)
    }
  } catch {
    ok = false
  }
  return ok
}

export function openBusinessData(el: HTMLElement, ctx: FeatureCtx, businessId: string, onDone: () => void): () => void {
  const id = `bd${++uid}`
  let closed = false
  let confirming = false
  const status = h('p', { class: 'bd-status', role: 'status', 'aria-live': 'polite' })
  const say = (t: string) => {
    status.textContent = t
    ctx.announce(t)
  }
  const leave = () => {
    closed = true
    onDone()
  }

  const row = (label: string, value: string | Node) =>
    h('div', { class: 'bd-row' }, h('dt', { class: 'bd-k' }, label), h('dd', { class: 'bd-v' }, value))
  const section = (key: string, ic: string, title: string, count: string | null, ...body: (Node | null)[]) =>
    h('section', { class: 'bd-sec', 'aria-labelledby': `${id}-${key}` },
      h('div', { class: 'bd-sec-head' },
        h('span', { class: 'bd-sec-icon', 'aria-hidden': 'true' }, icon(ic)),
        h('h3', { class: 'bd-h', id: `${id}-${key}` }, title),
        count ? h('span', { class: 'bd-count' }, count) : null,
      ),
      ...body,
    )

  function profileSection(d: CollectedData): HTMLElement {
    const b = d.business
    const x = d.details
    const rows: HTMLElement[] = []
    const add = (k: string, v: string | null | undefined) => {
      if (v && v.trim()) rows.push(row(k, v))
    }
    add(L.f.name, x?.name || b.name)
    add(L.f.category, x?.category)
    add(L.f.description, x?.description)
    add(L.f.phone, x?.phone)
    add(L.f.website, x?.website)
    add(L.f.address, x?.address || b.address)
    const lat = x?.lat ?? (validLatLon(b.lat, b.lon) ? b.lat : null)
    const lon = x?.lon ?? (validLatLon(b.lat, b.lon) ? b.lon : null)
    if (lat !== null && lon !== null) add(L.f.position, pos(lat, lon))
    if (x) {
      rows.push(h('div', { class: 'bd-row bd-row-stack' },
        h('dt', { class: 'bd-k' }, L.f.hours),
        h('dd', { class: 'bd-hours' }, ...x.hours.flatMap((hh, i) => [
          h('span', { class: 'bd-day' }, DAYS[i]),
          h('span', { class: 'bd-time' }, hh.open ? L.hoursRange(hh.from, hh.to) : L.closed),
        ])),
      ))
      if (x.photos.length) add(L.f.photos, String(x.photos.length))
    }
    add(L.f.offered, b.accessibility ? L.yes : L.no)
    if (x?.updatedAt) add(L.f.updated, date(x.updatedAt))
    const pct = x ? completeness(x) : null
    return section('profile', 'storefront', L.profile, L.count(rows.length),
      pct !== null
        ? h('div', { class: 'bd-score' },
            h('div', { class: 'bd-score-row' }, h('span', { class: 'bd-k' }, L.complete), h('span', { class: 'bd-pct' }, `${pct} %`)),
            h('div', { class: 'bd-bar', role: 'progressbar', 'aria-label': L.complete, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct },
              h('div', { class: 'bd-bar-fill', style: `width:${pct}%` })),
          )
        : h('p', { class: 'bd-p' }, L.profileEmpty),
      h('dl', { class: 'bd-dl' }, ...rows),
    )
  }

  function accessSection(d: CollectedData): HTMLElement {
    const x = d.details
    const given = x ? ACCESS_ATTRS.filter((a) => x.access[a.id] !== 'unbekannt').length : 0
    return section('access', 'accessible', L.access, `${given} von ${ACCESS_ATTRS.length} beantwortet`,
      h('dl', { class: 'bd-dl' }, ...ACCESS_ATTRS.map((a) => {
        const t: Tri = x ? x.access[a.id] : 'unbekannt'
        return row(a.label, h('span', { class: `bd-tri bd-tri-${t}` }, triText(t)))
      })),
    )
  }

  function entranceCard(e: SurveyEntrance): HTMLElement {
    const x = e as SurveyEntrance & Extra
    const name = doorName(e, ctx.origin(), ctx.buildings())
    const note = e.note ?? e.description ?? ''
    return h('li', { class: 'bd-card' },
      h('div', { class: 'bd-card-head' },
        e.photo
          ? h('img', { class: 'bd-thumb', src: e.photo, alt: L.photoAlt(name), width: 56, height: 56, loading: 'lazy' })
          : h('span', { class: 'bd-thumb bd-thumb-empty', 'aria-hidden': 'true' }, icon('door_front')),
        h('div', { class: 'bd-card-text' },
          h('h4', { class: 'bd-card-title' }, name),
          h('p', { class: 'bd-src' }, L.byYou),
        ),
      ),
      h('dl', { class: 'bd-dl' },
        row(L.e.position, pos(e.lat, e.lon)),
        row(L.e.stepFree, verdict(e.stepFree)),
        row(L.e.door, e.door ? L.door[e.door] : L.none),
        row(L.e.automatic, yn(e.automatic)),
        row(L.e.bell, yn(x.bell)),
        row(L.e.width, typeof x.widthCm === 'number' ? `${x.widthCm} cm` : L.none),
        row(L.e.tactile, yn(x.tactile)),
        row(L.e.ramp, yn(x.ramp)),
        note ? row(L.e.note, note) : null,
        row(L.e.created, date(e.createdAt)),
      ),
    )
  }

  function communitySection(d: CollectedData): HTMLElement {
    const pin = validLatLon(d.business.lat, d.business.lon)
    const items = [
      ...d.community.map((c) => h('li', { class: 'bd-card' },
        h('div', { class: 'bd-card-text' },
          h('h4', { class: 'bd-card-title' }, doorName(c.entry, ctx.origin(), ctx.buildings())),
          h('p', { class: 'bd-src' }, `${L.fromCommunity}, ${L.unconfirmed}`),
        ),
        h('dl', { class: 'bd-dl' },
          row(L.e.position, pos(c.entry.lat, c.entry.lon)),
          row(L.e.stepFree, verdict(c.entry.stepFree)),
          row(L.e.created, date(c.entry.createdAt)),
          row(L.e.distance, L.distance(c.distanceM)),
        ),
      )),
      ...d.nearby.map((n) => h('li', { class: 'bd-card' },
        h('div', { class: 'bd-card-text' },
          h('h4', { class: 'bd-card-title' }, doorName(n.entrance, ctx.origin(), ctx.buildings())),
          h('p', { class: 'bd-src' }, n.entrance.source === 'places' ? L.fromPlaces : L.fromOsm),
        ),
        h('dl', { class: 'bd-dl' },
          row(L.e.stepFree, verdict(n.entrance.stepFree)),
          row(L.e.door, n.entrance.door ? L.door[n.entrance.door] : L.none),
          row(L.e.distance, L.distance(n.distanceM)),
        ),
      )),
    ]
    return section('community', 'groups', L.community, L.count(items.length),
      h('p', { class: 'bd-p' }, pin ? L.communitySub : L.noPin),
      items.length ? h('ul', { class: 'bd-list' }, ...items) : pin ? h('p', { class: 'bd-p' }, L.communityEmpty) : null,
    )
  }

  function tasksSection(d: CollectedData): HTMLElement {
    const t = d.business.tasks
    return section('tasks', 'checklist', L.tasks, `${t.filter((x) => x.done).length} von ${t.length} erledigt`,
      h('dl', { class: 'bd-dl' }, ...t.map((x) => row(x.label, h('span', { class: x.done ? 'bd-tri bd-tri-ja' : 'bd-tri' }, x.done ? L.taskDone : L.taskOpen)))),
      h('p', { class: 'bd-p bd-note' }, icon('info'), h('span', {}, L.walks)),
    )
  }

  function render(focusId?: string): void {
    if (closed) return
    const b = loadBusiness()
    if (!b || b.id !== businessId) return leave()
    const d = collectBusinessData(b, ctx.entrances())
    // The sheet's region is labelled by #sheet-title; this screen replaces its h2.
    const headId = 'sheet-title'

    const actions = confirming
      ? h('div', { class: 'bd-confirm', role: 'group', 'aria-labelledby': `${id}-ct` },
          h('p', { class: 'bd-confirm-text', id: `${id}-ct` }, L.confirm(b.name)),
          h('button', { class: 'gm-pill bd-danger bd-wide', id: `${id}-yes`, type: 'button', onclick: () => remove(d) }, icon('delete_forever'), L.confirmYes),
          h('button', { class: 'gm-pill bd-wide', type: 'button', onclick: () => { confirming = false; render(`${id}-del`) } }, L.cancel),
        )
      : h('div', { class: 'bd-actions' },
          h('button', { class: 'gm-pill bd-wide', type: 'button', onclick: () => {
            try {
              exportJson(collectBusinessData(loadBusiness() ?? b, ctx.entrances()))
              say(L.exported)
            } catch {
              say(L.exportFailed)
            }
          } }, icon('download'), L.export),
          h('button', { class: 'gm-pill bd-wide bd-del', id: `${id}-del`, type: 'button', onclick: () => { confirming = true; render(`${id}-yes`) } }, icon('delete'), L.del),
        )

    // No own region name: the sheet region is already named by #sheet-title (axe landmark-unique).
    const root = h('div', { class: 'bd' },
      h('div', { class: 'bd-top' },
        h('button', { class: 'gm-circle bd-back', type: 'button', 'aria-label': L.back, onclick: leave }, icon('arrow_back')),
        h('h2', { class: 'bd-title', id: headId, tabindex: '-1' }, L.title),
      ),
      h('p', { class: 'bd-intro' }, L.intro),
      h('div', { class: 'bd-where' }, icon('smartphone'), h('div', {}, h('p', { class: 'bd-where-t' }, L.where), h('p', { class: 'bd-where-s' }, L.whereSub))),
      profileSection(d),
      accessSection(d),
      section('entrances', 'door_front', L.entrances, L.count(d.own.length),
        d.own.length ? h('ul', { class: 'bd-list' }, ...d.own.map(entranceCard)) : h('p', { class: 'bd-p' }, L.entrancesEmpty)),
      communitySection(d),
      tasksSection(d),
      actions,
      status,
    )
    el.replaceChildren(root)
    document.getElementById(focusId ?? headId)?.focus({ preventScroll: true })
  }

  function remove(d: CollectedData): void {
    const ok = deleteBusinessData(d.business)
    ctx.refresh()
    ctx.announce(ok ? L.deleted : L.deleteFailed)
    leave()
  }

  render()
  el.scrollTop = 0
  ctx.setSheet('full')
  return () => {
    closed = true
  }
}
