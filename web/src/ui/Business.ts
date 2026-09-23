// "Unternehmen" tab: a business owner manages the accessibility of their business,
// in the style of Google Business Profile onboarding. Everything is stored on the
// device through core/survey (no backend for writes).

import './business.css'
import type { LatLon } from '../core/geo'
import {
  ROUTE_TASK_ID,
  loadBusiness,
  loadSurvey,
  saveBusiness,
  validLatLon,
  visibilityScore,
  type BusinessProfile,
  type BusinessTask,
  type SurveyEntrance,
} from '../core/survey'
import { lang } from '../strings'
import type { FeatureCtx, Panel } from './ctx'
import { h } from './dom'
import { openEntranceEditor } from './EntranceEditor'
import { openBusinessEdit } from './BusinessEdit'
import { keepOneMain, openEntrancesManager } from './BusinessEntrances'
import { businessHomeHeader, popover } from './BusinessHome'
import { openBusinessData } from './BusinessData'
import { ACCESS_ATTRS, emptyDetails, loadDetails, saveDetails, type Tri } from '../core/businessDetails'

const S = {
  de: {
    title: 'Unternehmen',
    addTitle: 'Unternehmen hinzufügen',
    addSub: 'Zeig Besuchern, welcher Eingang für sie passt.',
    nameLabel: 'Name des Unternehmens',
    namePh: 'z. B. Café am Platz',
    nameMissing: 'Bitte gib einen Namen ein.',
    addrLabel: 'Adresse (optional)',
    addrPh: 'Straße und Hausnummer',
    locLabel: 'Standort',
    locTake: 'Standort: Kartenmitte übernehmen',
    locSet: (p: LatLon) => `Standort gesetzt: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`,
    locNone: 'Noch kein Standort. Verschiebe die Karte auf dein Unternehmen und tippe auf den Knopf.',
    locMissing: 'Bitte übernimm zuerst den Standort.',
    save: 'Speichern',
    saveFailed: 'Speichern nicht möglich. Der Speicher des Browsers ist blockiert oder voll.',
    created: 'Unternehmen gespeichert.',
    noAddress: 'Keine Adresse angegeben',
    scoreLabel: 'Sichtbarkeit',
    scoreOf: (n: number) => `${n} von 100`,
    scoreText:
      'Mehr Angaben, weiter oben in der Suche.',
    offerLabel: 'Barrierefreiheit anbieten',
    offerSub: 'Sichtbar für Menschen, die stufenlos suchen.',
    offerOn: 'Barrierefreiheit wird angeboten.',
    offerOff: 'Barrierefreiheit wird nicht mehr angeboten.',
    entrancesHead: 'Eingänge verwalten',
    entrancesEmpty: 'Noch keine Eingänge.',
    addEntrance: 'Eingang hinzufügen',
    unnamed: 'Eingang ohne Namen',
    stepFree: 'stufenlos',
    notStepFree: 'nicht stufenlos',
    unknown: 'stufenlos unbekannt',
    withPhoto: 'mit Foto',
    entranceSaved: 'Eingang gespeichert.',
    tasksHead: 'Empfohlene Maßnahmen',
    tabOverview: 'Übersicht',
    tabAccess: 'Barrierefreiheit',
    questionsHead: 'Fragen zur Barrierefreiheit',
    questionsMeta: (d: number, n: number) => `${d} von ${n} beantwortet`,
    yes: 'Ja',
    no: 'Nein',
    unsure: 'Weiß nicht',
    answerSaved: 'Antwort gespeichert.',
    rankHead: 'Sichtbarkeit in der Suche',
    rankLevel: (n: number) => (n >= 70 ? 'Weit oben' : n >= 40 ? 'Höher' : 'Standard'),
    rankNext: (n: number) => (n >= 70 ? 'Du wirst bevorzugt gezeigt.' : `Noch ${n >= 40 ? 70 - n : 40 - n} Punkte bis zur nächsten Stufe.`),
    introHead: 'So wirst du besser gefunden',
    introText: 'Beantworte die Fragen zur Barrierefreiheit und trag deine Eingänge ein. Dann zeigt die Suche dich weiter oben.',
    introOk: 'Verstanden',
    tasksDone: (d: number, n: number) => `${d} von ${n} erledigt`,
    taskRoute: 'Weg vom Haupteingang zur Toilette filmen',
    taskPhoto: 'Foto vom barrierefreien Eingang',
    taskWidth: 'Türbreite messen',
    film: 'Weg filmen',
    filmLabel: 'Weg jetzt filmen',
    taskDone: (l: string) => `Erledigt: ${l}`,
    taskOpen: (l: string) => `Offen: ${l}`,
    edit: 'Unternehmen bearbeiten',
    offerHead: 'Barrierefreiheit',
    lineRoute: 'Besucher sehen vorher, wie sie zur Toilette kommen.',
    linePhoto: 'Ein Foto zeigt, welcher Eingang stufenlos ist.',
    lineWidth: 'Rollstühle brauchen mindestens 90 cm Durchgang.',
    doneLine: 'Erledigt',
    addPhoto: 'Foto hinzufügen',
    addPhotoLabel: 'Eingang mit Foto hinzufügen',
    measure: 'Türbreite eintragen',
    measureLabel: 'Türbreite bei den Eingängen eintragen',
    markDone: (l: string) => `Als erledigt markieren: ${l}`,
    markDoneShort: 'Als erledigt markieren',
    markOpenShort: 'Als offen markieren',
    hide: 'Ausblenden',
    hidden: (l: string) => `Ausgeblendet: ${l}`,
    more: (l: string) => `Weitere Optionen: ${l}`,
    switched: (n: string) => `Gewechselt zu ${n}.`,
    cancel: 'Abbrechen',
  },
  en: {
    title: 'Business',
    addTitle: 'Add your business',
    addSub: 'Show visitors which entrance works for them.',
    nameLabel: 'Business name',
    namePh: 'e.g. Café on the square',
    nameMissing: 'Please enter a name.',
    addrLabel: 'Address (optional)',
    addrPh: 'Street and number',
    locLabel: 'Location',
    locTake: 'Location: use map centre',
    locSet: (p: LatLon) => `Location set: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`,
    locNone: 'No location yet. Move the map to your business and tap the button.',
    locMissing: 'Please set the location first.',
    save: 'Save',
    saveFailed: 'Could not save. Browser storage is blocked or full.',
    created: 'Business saved.',
    noAddress: 'No address given',
    scoreLabel: 'Visibility',
    scoreOf: (n: number) => `${n} of 100`,
    scoreText: 'More details, higher in search.',
    offerLabel: 'Offer accessibility',
    offerSub: 'Your business shows up for people looking for step-free entrances.',
    offerOn: 'Accessibility is offered.',
    offerOff: 'Accessibility is no longer offered.',
    entrancesHead: 'Manage entrances',
    entrancesEmpty: 'No entrances yet. Add the entrance visitors with a wheelchair, walker or pram can use.',
    addEntrance: 'Add entrance',
    unnamed: 'Unnamed entrance',
    stepFree: 'step-free',
    notStepFree: 'not step-free',
    unknown: 'step-free unknown',
    withPhoto: 'with photo',
    entranceSaved: 'Entrance saved.',
    tasksHead: 'Recommended actions',
    tabOverview: 'Overview',
    tabAccess: 'Accessibility',
    questionsHead: 'Accessibility questions',
    questionsMeta: (d: number, n: number) => `${d} of ${n} answered`,
    yes: 'Yes',
    no: 'No',
    unsure: 'Not sure',
    answerSaved: 'Answer saved.',
    rankHead: 'Visibility in search',
    rankLevel: (n: number) => (n >= 70 ? 'Near the top' : n >= 40 ? 'Higher' : 'Standard'),
    rankNext: (n: number) => (n >= 70 ? 'You are shown first.' : `${n >= 40 ? 70 - n : 40 - n} points to the next level.`),
    introHead: 'How to be found more often',
    introText: 'Answer the accessibility questions and add your entrances. Search then shows you higher up.',
    introOk: 'Got it',
    tasksDone: (d: number, n: number) => `${d} of ${n} done`,
    taskRoute: 'Film the way from the main entrance to the toilet',
    taskPhoto: 'Photo of the accessible entrance',
    taskWidth: 'Measure the door width',
    film: 'Film the way',
    filmLabel: 'Film the way now',
    taskDone: (l: string) => `Done: ${l}`,
    taskOpen: (l: string) => `Open: ${l}`,
    edit: 'Edit business',
    offerHead: 'Accessibility',
    lineRoute: 'Visitors see in advance how to reach the toilet.',
    linePhoto: 'A photo shows which entrance is step-free.',
    lineWidth: 'Wheelchairs need at least 90 cm of clear width.',
    doneLine: 'Done',
    addPhoto: 'Add photo',
    addPhotoLabel: 'Add an entrance with a photo',
    measure: 'Enter door width',
    measureLabel: 'Enter the door width at the entrances',
    markDone: (l: string) => `Mark as done: ${l}`,
    markDoneShort: 'Mark as done',
    markOpenShort: 'Mark as open',
    hide: 'Hide',
    hidden: (l: string) => `Hidden: ${l}`,
    more: (l: string) => `More options: ${l}`,
    switched: (n: string) => `Switched to ${n}.`,
    cancel: 'Cancel',
  },
}
const L = S[lang === 'en' ? 'en' : 'de']

const PHOTO_TASK_ID = 'photo'
const WIDTH_TASK_ID = 'width'
const TASKS: { id: string; label: string; line: string }[] = [
  { id: ROUTE_TASK_ID, label: L.taskRoute, line: L.lineRoute },
  { id: PHOTO_TASK_ID, label: L.taskPhoto, line: L.linePhoto },
  { id: WIDTH_TASK_ID, label: L.taskWidth, line: L.lineWidth },
]

/** All businesses of this device. The active one stays under loadBusiness/saveBusiness. */
const BUSINESSES_KEY = 'doorway.businesses'

function loadBusinessList(): BusinessProfile[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BUSINESSES_KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((o): o is BusinessProfile =>
      !!o && typeof o === 'object' && typeof (o as BusinessProfile).id === 'string' && typeof (o as BusinessProfile).name === 'string'
      && Array.isArray((o as BusinessProfile).entranceIds) && Array.isArray((o as BusinessProfile).tasks))
  } catch {
    return []
  }
}

/** Insert or update a business in the device list. Storage failures are ignored here. */
function rememberBusiness(b: BusinessProfile): void {
  const list = loadBusinessList()
  const i = list.findIndex((x) => x.id === b.id)
  if (i >= 0) list[i] = b
  else list.push(b)
  try {
    localStorage.setItem(BUSINESSES_KEY, JSON.stringify(list))
  } catch {
    /* blocked or full: the active business is still saved */
  }
}

/** Recommendation cards the owner hid with "Ausblenden", per business, on this device. */
const hiddenKey = (bizId: string) => `doorway.bizHiddenTasks.${bizId}`
function loadHidden(bizId: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(hiddenKey(bizId)) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function saveHidden(bizId: string, ids: string[]): boolean {
  try {
    localStorage.setItem(hiddenKey(bizId), JSON.stringify(ids))
    return true
  } catch {
    return false
  }
}

function isDone(b: BusinessProfile, taskId: string): boolean {
  return b.tasks.find((x) => x.id === taskId)?.done === true
}

let uid = 0
const icon = (name: string, filled = false) => h('span', { class: `ms${filled ? ' ms-fill' : ''}`, 'aria-hidden': 'true' }, name)

function mapCentre(ctx: FeatureCtx): LatLon {
  const c = ctx.map?.getCenter()
  return c ? { lat: c.lat(), lon: c.lng() } : ctx.origin()
}

/** Make sure the three standard tasks exist, keeping stored done flags. */
function withTasks(b: BusinessProfile): BusinessProfile {
  const tasks: BusinessTask[] = TASKS.map((t) => ({ id: t.id, label: t.label, done: b.tasks.find((x) => x.id === t.id)?.done === true }))
  const extra = b.tasks.filter((x) => !TASKS.some((t) => t.id === x.id))
  return { ...b, tasks: [...tasks, ...extra] }
}

/**
 * Photo and door-width tasks count as done once an entrance carries that data, whichever
 * screen added it (the entrances manager does not know about tasks). Never unsets a check.
 */
function autoDone(b: BusinessProfile, linked: SurveyEntrance[]): BusinessProfile {
  const hasPhoto = linked.some((e) => typeof e.photo === 'string' && e.photo.length > 0)
  const hasWidth = linked.some((e) => typeof (e as { widthCm?: unknown }).widthCm === 'number')
  const tasks = b.tasks.map((t) =>
    !t.done && ((t.id === PHOTO_TASK_ID && hasPhoto) || (t.id === WIDTH_TASK_ID && hasWidth)) ? { ...t, done: true } : t)
  return { ...b, tasks }
}

function linkedEntrances(b: BusinessProfile, all: SurveyEntrance[]): SurveyEntrance[] {
  return all.filter((e) => b.entranceIds.includes(e.id) || e.businessId === b.id)
}

function newBusinessId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `biz/${crypto.randomUUID()}`
  } catch {
    /* fall through */
  }
  return `biz/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export const businessPanel: Panel = (el, ctx) => {
  let editorCleanup: (() => void) | null = null
  let bizTab: 'overview' | 'access' = 'overview'
  const id = `bz${++uid}`

  const closeEditor = () => {
    editorCleanup?.()
    editorCleanup = null
  }

  const status = (): HTMLElement => h('p', { class: 'bz-status', role: 'status', 'aria-live': 'polite' })

  // ---------- step 1: add business ----------
  function renderCreate(prefill?: BusinessProfile): void {
    let pos: LatLon | null = prefill && validLatLon(prefill.lat, prefill.lon) ? { lat: prefill.lat, lon: prefill.lon } : null
    const msg = status()
    const nameIn = h('input', {
      id: `${id}-name`, class: 'bz-input', type: 'text', required: true, autocomplete: 'organization',
      placeholder: L.namePh, maxlength: 120, value: prefill?.name ?? '',
    })
    const addrIn = h('input', {
      id: `${id}-addr`, class: 'bz-input', type: 'text', autocomplete: 'street-address',
      placeholder: L.addrPh, maxlength: 200, value: prefill?.address ?? '',
    })
    const locText = h('p', { class: 'gm-p bz-loc-text', id: `${id}-loc` }, pos ? L.locSet(pos) : L.locNone)
    const takeLoc = () => {
      pos = mapCentre(ctx)
      locText.textContent = L.locSet(pos)
      ctx.announce(L.locSet(pos))
    }
    const submit = (ev: Event) => {
      ev.preventDefault()
      const name = nameIn.value.trim()
      if (!name) {
        msg.textContent = L.nameMissing
        nameIn.focus()
        return
      }
      if (!pos) {
        msg.textContent = L.locMissing
        return
      }
      const address = addrIn.value.trim()
      const b = withTasks({
        id: prefill?.id ?? newBusinessId(),
        name,
        lat: pos.lat,
        lon: pos.lon,
        address: address || undefined,
        placeId: prefill?.placeId,
        accessibility: prefill?.accessibility ?? false,
        entranceIds: prefill?.entranceIds ?? [],
        tasks: prefill?.tasks ?? [],
      })
      if (!saveBusiness(b)) {
        msg.textContent = L.saveFailed
        return
      }
      rememberBusiness(b)
      ctx.announce(L.created)
      renderDashboard()
    }
    const form = h(
      'form',
      { class: 'bz', novalidate: true, onsubmit: submit, 'aria-labelledby': 'sheet-title' },
      h('div', { class: 'gm-sheet-head' }, h('h2', { id: 'sheet-title', class: 'gm-sheet-title', tabindex: '-1' }, prefill ? L.edit : L.addTitle)),
      h('p', { class: 'gm-sheet-sub' }, L.addSub),
      h('label', { class: 'bz-label', for: `${id}-name` }, L.nameLabel),
      nameIn,
      h('div', { class: 'bz-label', id: `${id}-loclabel` }, L.locLabel),
      h('button', { class: 'gm-pill bz-wide', type: 'button', onclick: takeLoc, 'aria-describedby': `${id}-loc` }, icon('my_location'), L.locTake),
      locText,
      h('label', { class: 'bz-label', for: `${id}-addr` }, L.addrLabel),
      addrIn,
      h('button', { class: 'gm-pill gm-pill-primary bz-wide bz-submit', type: 'submit' }, icon('check'), L.save),
      loadBusiness()
        ? h('button', { class: 'gm-pill bz-wide bz-cancel', type: 'button', onclick: () => renderDashboard() }, L.cancel)
        : null,
      msg,
    )
    el.replaceChildren(form)
    el.scrollTop = 0
    ctx.setSheet('full')
  }

  // ---------- steps 2 to 5: dashboard as a full-height page ----------
  // keepScroll: re-render in place (toggle, task check); otherwise start at the page top,
  // not at the scroll offset of the sub-screen the owner comes back from.
  function renderDashboard(keepScroll = false): void {
    const stored = loadBusiness()
    if (!stored) return renderCreate()
    const survey = loadSurvey()
    // In-place re-renders skip autoDone so an owner can still uncheck a task by hand.
    const b = keepScroll ? withTasks(stored) : autoDone(withTasks(stored), linkedEntrances(stored, survey))
    if (JSON.stringify(b) !== JSON.stringify(stored)) saveBusiness(b)
    rememberBusiness(b)
    const linked = linkedEntrances(b, survey)
    const answeredShare = (() => {
      const d = loadDetails(b.id)
      return d ? ACCESS_ATTRS.filter((a) => d.access[a.id] !== 'unbekannt').length / ACCESS_ATTRS.length : 0
    })()
    const score = visibilityScore(b, survey, answeredShare)
    const msg = status()

    const persist = (next: BusinessProfile): boolean => {
      if (saveBusiness(next)) {
        rememberBusiness(next)
        return true
      }
      msg.textContent = L.saveFailed
      return false
    }

    // accessibility toggle card
    const toggle = h('input', { id: `${id}-offer`, class: 'bz-switch', type: 'checkbox', role: 'switch', checked: b.accessibility, 'aria-describedby': `${id}-offer-sub` })
    toggle.addEventListener('change', () => {
      if (!persist({ ...b, accessibility: toggle.checked })) {
        toggle.checked = !toggle.checked
        return
      }
      ctx.announce(toggle.checked ? L.offerOn : L.offerOff)
      renderDashboard(true)
    })
    const offer = h(
      'label',
      { class: 'bz-card bz-toggle', for: `${id}-offer` },
      h('span', { class: 'bz-toggle-text' }, h('span', { class: 'gm-row-title' }, L.offerLabel), h('span', { class: 'gm-row-meta', id: `${id}-offer-sub` }, L.offerSub)),
      toggle,
    )

    // entrances
    const entranceRow = (e: SurveyEntrance) => {
      const verdict = e.stepFree === true ? L.stepFree : e.stepFree === false ? L.notStepFree : L.unknown
      const meta = [verdict, e.photo ? L.withPhoto : ''].filter(Boolean).join(' · ')
      return h('li', {},
        h('button', { class: 'gm-row', type: 'button', onclick: () => ctx.openDoor(e) },
          h('span', { class: `bz-dot${e.stepFree === true ? ' bz-dot-ok' : ''}`, 'aria-hidden': 'true' }, icon(e.stepFree === true ? 'accessible' : 'door_front', true)),
          h('span', { class: 'gm-row-text' }, h('span', { class: 'gm-row-title' }, e.name ?? L.unnamed), h('span', { class: 'gm-row-meta' }, meta)),
        ),
      )
    }
    const addEntrance = () => {
      closeEditor()
      const start = validLatLon(b.lat, b.lon) ? { lat: b.lat, lon: b.lon } : mapCentre(ctx)
      editorCleanup = openEntranceEditor(ctx, el, {
        lat: start.lat,
        lon: start.lon,
        businessId: b.id,
        by: 'business',
        onSaved: (e) => {
          closeEditor()
          const cur = withTasks(loadBusiness() ?? b)
          const ids = cur.entranceIds.includes(e.id) ? cur.entranceIds : [...cur.entranceIds, e.id]
          const tasks = e.photo ? cur.tasks.map((t) => (t.id === PHOTO_TASK_ID ? { ...t, done: true } : t)) : cur.tasks
          const next = { ...cur, entranceIds: ids, tasks }
          if (saveBusiness(next)) rememberBusiness(next)
          keepOneMain(b.id, e)
          ctx.refresh()
          ctx.announce(L.entranceSaved)
          renderDashboard()
        },
        onCancel: () => {
          closeEditor()
          renderDashboard()
        },
      })
      el.scrollTop = 0
    }

    // "Empfohlene Maßnahmen": one card per task, title, one line, action pill, done check
    const back = () => {
      closeEditor()
      ctx.refresh()
      renderDashboard()
    }
    const taskAction = (taskId: string): { label: string; aria: string; icon: string; run: () => void } | null => {
      if (taskId === ROUTE_TASK_ID) return { label: L.film, aria: L.filmLabel, icon: 'videocam', run: () => ctx.openRecorder() }
      if (taskId === PHOTO_TASK_ID) return { label: L.addPhoto, aria: L.addPhotoLabel, icon: 'photo_camera', run: addEntrance }
      if (taskId === WIDTH_TASK_ID) return { label: L.measure, aria: L.measureLabel, icon: 'straighten', run: () => sub(() => openEntrancesManager(el, ctx, b.id, back)) }
      return null
    }
    const doneCount = TASKS.filter((t) => b.tasks.find((x) => x.id === t.id)?.done).length
    const hiddenIds = loadHidden(b.id)
    const thumbIcon: Record<string, string> = { [ROUTE_TASK_ID]: 'videocam', [PHOTO_TASK_ID]: 'photo_camera', [WIDTH_TASK_ID]: 'straighten' }
    const setDone = (t: { id: string; label: string }, done: boolean) => {
      const next = { ...b, tasks: b.tasks.map((x) => (x.id === t.id ? { ...x, done } : x)) }
      if (!persist(next)) return
      ctx.announce(done ? L.taskDone(t.label) : L.taskOpen(t.label))
      renderDashboard(true)
    }
    const hideTask = (t: { id: string; label: string }) => {
      if (!saveHidden(b.id, [...hiddenIds.filter((x) => x !== t.id), t.id])) {
        msg.textContent = L.saveFailed
        return
      }
      ctx.announce(L.hidden(t.label))
      renderDashboard(true)
    }
    const taskCard = (t: { id: string; label: string; line: string }) => {
      const done = b.tasks.find((x) => x.id === t.id)?.done === true
      const act = done ? null : taskAction(t.id)
      const menuId = `${id}-tm-${t.id}`
      const moreBtn = h('button', {
        class: 'bz-rec-more', type: 'button', 'aria-label': L.more(t.label), 'aria-expanded': 'false', 'aria-controls': menuId,
      }, icon('more_horiz'))
      const menu = h('div', { class: 'bzh-pop bz-rec-menu', id: menuId, hidden: true },
        h('ul', { class: 'bzh-pop-list' },
          h('li', {}, h('button', { class: 'bzh-pop-btn', type: 'button', onclick: () => setDone(t, !done) },
            icon(done ? 'undo' : 'check_circle'), h('span', {}, done ? L.markOpenShort : L.markDoneShort))),
          h('li', {}, h('button', { class: 'bzh-pop-btn', type: 'button', onclick: () => hideTask(t) },
            icon('visibility_off'), h('span', {}, L.hide))),
        ),
      )
      popover(moreBtn, menu)
      return h('li', { class: `bz-rec${done ? ' bz-rec-done' : ''}` },
        h('div', { class: 'bz-rec-top' },
          h('div', { class: 'bz-rec-text' },
            h('h4', { class: 'bz-rec-title' }, t.label),
            h('p', { class: 'bz-rec-line' }, done ? L.doneLine : t.line),
          ),
          h('span', { class: 'bz-rec-thumb', 'aria-hidden': 'true' }, icon(done ? 'check' : thumbIcon[t.id] ?? 'task_alt', true)),
        ),
        h('div', { class: 'bz-rec-foot' },
          act
            ? h('button', { class: 'bz-rec-link', type: 'button', 'aria-label': act.aria, onclick: act.run }, act.label)
            : h('span', {}),
          moreBtn,
        ),
        menu,
      )
    }
    const ordered = [...TASKS].filter((t) => !hiddenIds.includes(t.id)).sort((a, c) => Number(isDone(b, a.id)) - Number(isDone(b, c.id)))
    const recs = ordered.length
      ? h(
          'section',
          { class: 'bz-sec', 'aria-labelledby': `${id}-tasks` },
          h('div', { class: 'bz-sec-head' },
            h('h3', { class: 'bz-h3', id: `${id}-tasks` }, L.tasksHead),
            h('span', { class: 'bz-sec-meta' }, L.tasksDone(doneCount, TASKS.length)),
          ),
          h('ul', { class: 'bz-recs' }, ...ordered.map(taskCard)),
        )
      : null

    const entrances = h(
      'section',
      { class: 'bz-sec', 'aria-labelledby': `${id}-ent` },
      h('h3', { class: 'bz-h3', id: `${id}-ent` }, L.entrancesHead),
      linked.length
        ? h('ul', { class: 'gm-list bz-list' }, ...linked.map(entranceRow))
        : h('p', { class: 'gm-p' }, L.entrancesEmpty),
      h('button', { class: 'gm-pill gm-pill-primary bz-wide', type: 'button', onclick: addEntrance }, icon('add'), L.addEntrance),
    )

    const visibility = h(
      'section',
      { class: 'bz-sec', 'aria-label': L.offerHead },
      offer,
    )

    // Ranking explanation: the "Profilstärke" card on top jumps here.
    const rank = h(
      'section',
      { class: 'bz-sec bz-rank', id: `${id}-rank`, 'aria-labelledby': `${id}-rank-h`, tabindex: '-1' },
      h('div', { class: 'bz-sec-head' },
        h('h3', { class: 'bz-h3', id: `${id}-rank-h` }, L.rankHead),
        h('span', { class: 'bz-rank-level' }, L.rankLevel(score)),
      ),
      h('p', { class: 'bz-rank-note' }, `${L.scoreText} ${L.rankNext(score)}`),
    )

    // First visit: one short note on why this matters, dismissed for good.
    let introSeen = true
    try {
      introSeen = localStorage.getItem('doorway.bizIntroSeen') === '1'
    } catch {
      /* storage blocked: show it */
      introSeen = false
    }
    const intro = introSeen
      ? null
      : h('section', { class: 'bz-intro', role: 'note' },
          h('span', { class: 'bz-rank-ic', 'aria-hidden': 'true' }, icon('trending_up')),
          h('div', {}, h('h3', { class: 'bz-h3' }, L.introHead), h('p', { class: 'bz-intro-text' }, L.introText)),
          h('button', {
            class: 'gm-pill gm-pill-primary', type: 'button',
            onclick: () => {
              try {
                localStorage.setItem('doorway.bizIntroSeen', '1')
              } catch {
                /* ignore */
              }
              renderDashboard(true)
            },
          }, L.introOk),
        )

    // Barrierefreiheit tab: every question can be answered directly, no video needed.
    const details = loadDetails(b.id) ?? { ...emptyDetails(), name: b.name, address: b.address ?? '', lat: b.lat, lon: b.lon }
    const answered = ACCESS_ATTRS.filter((a) => details.access[a.id] !== 'unbekannt').length
    const question = (a: (typeof ACCESS_ATTRS)[number]) => {
      const cur = details.access[a.id]
      const opt = (v: Tri, label: string) =>
        h('button', {
          class: `bz-seg-btn${cur === v ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(cur === v),
          onclick: () => {
            const next = { ...details, access: { ...details.access, [a.id]: v }, updatedAt: new Date().toISOString() }
            if (!saveDetails(b.id, next)) {
              msg.textContent = L.saveFailed
              return
            }
            ctx.announce(L.answerSaved)
            renderDashboard(true)
          },
        }, label)
      return h('li', { class: 'bz-q' },
        h('span', { class: 'bz-q-label', id: `${id}-q-${a.id}` }, a.label),
        h('div', { class: 'bz-seg', role: 'group', 'aria-labelledby': `${id}-q-${a.id}` }, opt('ja', L.yes), opt('nein', L.no), opt('unbekannt', L.unsure)),
      )
    }
    const questions = h(
      'section',
      { class: 'bz-sec', 'aria-labelledby': `${id}-q` },
      h('div', { class: 'bz-sec-head' },
        h('h3', { class: 'bz-h3', id: `${id}-q` }, L.questionsHead),
        h('span', { class: 'bz-sec-meta' }, L.questionsMeta(answered, ACCESS_ATTRS.length)),
      ),
      h('ul', { class: 'bz-qs' }, ...ACCESS_ATTRS.map(question)),
    )

    const tabBtn = (key: 'overview' | 'access', label: string) =>
      h('button', {
        class: 'gm-tabbtn', type: 'button', role: 'tab', 'aria-selected': String(bizTab === key),
        onclick: () => {
          bizTab = key
          renderDashboard()
        },
      }, label)
    const tabs = h('div', { class: 'gm-tabs bz-tabs', id: `${id}-tabs`, role: 'tablist' }, tabBtn('overview', L.tabOverview), tabBtn('access', L.tabAccess))

    const body =
      bizTab === 'overview'
        ? [intro, rank, recs]
        : [visibility, questions, entrances]
    el.replaceChildren(h('div', { class: 'bz bz-page' }, home(b), tabs, ...body.filter((x): x is HTMLElement => x !== null), msg))
    if (!keepScroll) el.scrollTop = 0
    ctx.setSheet('full')
  }

  // Page top with the round action buttons. Each sub-screen renders into the sheet and
  // comes back to the dashboard; a failing one never kills the tab.
  function sub(open: () => () => void) {
    closeEditor()
    try {
      editorCleanup = open()
      el.scrollTop = 0
    } catch (err) {
      console.error('[doorway] business sub-screen failed', err)
      renderDashboard()
    }
  }
  // Switch tab, re-render in place and bring the target into view with focus on it.
  function jumpTo(tab: 'overview' | 'access', targetId: string) {
    bizTab = tab
    renderDashboard(true)
    const target = document.getElementById(targetId)
    if (!target) return
    target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    const focusEl = target.matches('[tabindex]') ? target : target.querySelector<HTMLElement>('[aria-selected="true"]')
    focusEl?.focus({ preventScroll: true })
  }
  function home(b: BusinessProfile): HTMLElement {
    const back = () => {
      closeEditor()
      ctx.refresh()
      renderDashboard()
    }
    try {
      return businessHomeHeader(ctx, b, {
        onEdit: () => sub(() => openBusinessEdit(el, ctx, b.id, back)),
        onEntrances: () => sub(() => openEntrancesManager(el, ctx, b.id, back)),
        onRecord: () => ctx.openRecorder(),
        onData: () => sub(() => openBusinessData(el, ctx, b.id, back)),
        onPhotos: () => sub(() => openBusinessEdit(el, ctx, b.id, back)),
        onHours: () => sub(() => openBusinessEdit(el, ctx, b.id, back)),
        onAccess: () => jumpTo('access', `${id}-tabs`),
        onScore: () => jumpTo('overview', `${id}-rank`),
        onPreview: () => {
          const list = linkedEntrances(b, loadSurvey())
          const main = list.find((e) => e.kind === 'main') ?? list[0]
          if (main) ctx.openDoor(main)
          else ctx.announce(L.entrancesEmpty)
        },
        onNewBusiness: () => {
          closeEditor()
          renderCreate()
        },
        onSwitch: (otherId) => {
          const other = loadBusinessList().find((x) => x.id === otherId)
          if (!other || !saveBusiness(other)) {
            ctx.announce(L.saveFailed)
            return
          }
          ctx.refresh()
          ctx.announce(L.switched(other.name))
          renderDashboard()
        },
      }, {
        others: loadBusinessList().filter((x) => x.id !== b.id).map((x) => ({ id: x.id, name: x.name })),
        openTasks: TASKS.filter((t) => !isDone(b, t.id)).map((t) => t.label),
      })
    } catch (err) {
      console.error('[doorway] business header failed', err)
      return h('div', { class: 'gm-sheet-head' },
        h('h2', { id: 'sheet-title', class: 'gm-sheet-title', tabindex: '-1' }, b.name),
        h('button', { class: 'gm-circle bz-edit', type: 'button', 'aria-label': L.edit, onclick: () => renderCreate(b) }, icon('edit')),
      )
    }
  }

  renderDashboard()

  return () => {
    closeEditor()
    el.replaceChildren()
  }
}
