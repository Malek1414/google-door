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
import { openEntrancesManager } from './BusinessEntrances'
import { businessHomeHeader } from './BusinessHome'

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
      'Vorschlag an Google: Unternehmen mit vollständigen Angaben zur Barrierefreiheit werden in der Suche weiter oben angezeigt. Je vollständiger dein Profil, desto besser.',
    offerLabel: 'Barrierefreiheit anbieten',
    offerSub: 'Dein Unternehmen erscheint bei Menschen, die stufenlose Eingänge suchen.',
    offerOn: 'Barrierefreiheit wird angeboten.',
    offerOff: 'Barrierefreiheit wird nicht mehr angeboten.',
    entrancesHead: 'Eingänge verwalten',
    entrancesEmpty: 'Noch keine Eingänge. Füge den Eingang hinzu, den Besucher mit Rollstuhl, Rollator oder Kinderwagen nutzen können.',
    addEntrance: 'Eingang hinzufügen',
    unnamed: 'Eingang ohne Namen',
    stepFree: 'stufenlos',
    notStepFree: 'nicht stufenlos',
    unknown: 'stufenlos unbekannt',
    withPhoto: 'mit Foto',
    entranceSaved: 'Eingang gespeichert.',
    tasksHead: 'Aufgaben',
    tasksDone: (d: number, n: number) => `${d} von ${n} erledigt`,
    taskRoute: 'Weg vom Haupteingang zur Toilette filmen',
    taskPhoto: 'Foto vom barrierefreien Eingang',
    taskWidth: 'Türbreite messen',
    film: 'Filmen',
    filmLabel: 'Weg jetzt filmen',
    taskDone: (l: string) => `Erledigt: ${l}`,
    taskOpen: (l: string) => `Offen: ${l}`,
    edit: 'Unternehmen bearbeiten',
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
    scoreText:
      'Proposal to Google: businesses with complete accessibility data rank higher in search. The more complete your profile, the better.',
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
    tasksHead: 'Tasks',
    tasksDone: (d: number, n: number) => `${d} of ${n} done`,
    taskRoute: 'Film the way from the main entrance to the toilet',
    taskPhoto: 'Photo of the accessible entrance',
    taskWidth: 'Measure the door width',
    film: 'Film',
    filmLabel: 'Film the way now',
    taskDone: (l: string) => `Done: ${l}`,
    taskOpen: (l: string) => `Open: ${l}`,
    edit: 'Edit business',
  },
}
const L = S[lang === 'en' ? 'en' : 'de']

const PHOTO_TASK_ID = 'photo'
const WIDTH_TASK_ID = 'width'
const TASKS: { id: string; label: string }[] = [
  { id: ROUTE_TASK_ID, label: L.taskRoute },
  { id: PHOTO_TASK_ID, label: L.taskPhoto },
  { id: WIDTH_TASK_ID, label: L.taskWidth },
]

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
      msg,
    )
    el.replaceChildren(form)
    ctx.setSheet('full')
  }

  // ---------- steps 2 to 5: dashboard ----------
  function renderDashboard(): void {
    const stored = loadBusiness()
    if (!stored) return renderCreate()
    const b = withTasks(stored)
    const survey = loadSurvey()
    const linked = linkedEntrances(b, survey)
    const score = visibilityScore(b, survey)
    const msg = status()

    const persist = (next: BusinessProfile): boolean => {
      if (saveBusiness(next)) return true
      msg.textContent = L.saveFailed
      return false
    }

    // score
    const scoreBlock = h(
      'section',
      { class: 'bz-card', 'aria-labelledby': `${id}-score` },
      h('div', { class: 'bz-score-row' },
        h('h3', { class: 'bz-h3', id: `${id}-score` }, L.scoreLabel),
        h('span', { class: 'bz-score', 'aria-hidden': 'true' }, String(score)),
      ),
      h('div', {
        class: 'bz-bar', role: 'progressbar', 'aria-label': L.scoreLabel,
        'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': score, 'aria-valuetext': L.scoreOf(score),
      }, h('div', { class: 'bz-bar-fill', style: `width:${score}%` })),
      h('p', { class: 'gm-p bz-small' }, L.scoreText),
    )

    // accessibility toggle
    const toggle = h('input', { id: `${id}-offer`, class: 'bz-switch', type: 'checkbox', role: 'switch', checked: b.accessibility, 'aria-describedby': `${id}-offer-sub` })
    toggle.addEventListener('change', () => {
      if (!persist({ ...b, accessibility: toggle.checked })) {
        toggle.checked = !toggle.checked
        return
      }
      ctx.announce(toggle.checked ? L.offerOn : L.offerOff)
      renderDashboard()
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
          saveBusiness({ ...cur, entranceIds: ids, tasks })
          ctx.refresh()
          ctx.announce(L.entranceSaved)
          renderDashboard()
        },
        onCancel: () => {
          closeEditor()
          renderDashboard()
        },
      })
    }
    const entrances = h(
      'section',
      { class: 'bz-section', 'aria-labelledby': `${id}-ent` },
      h('h3', { class: 'bz-h3', id: `${id}-ent` }, L.entrancesHead),
      linked.length
        ? h('ul', { class: 'gm-list bz-list' }, ...linked.map(entranceRow))
        : h('p', { class: 'gm-p' }, L.entrancesEmpty),
      h('button', { class: 'gm-pill gm-pill-primary bz-wide', type: 'button', onclick: addEntrance }, icon('add'), L.addEntrance),
    )

    // tasks
    const doneCount = TASKS.filter((t) => b.tasks.find((x) => x.id === t.id)?.done).length
    const taskRow = (t: { id: string; label: string }) => {
      const done = b.tasks.find((x) => x.id === t.id)?.done === true
      const box = h('input', { id: `${id}-t-${t.id}`, class: 'bz-check', type: 'checkbox', checked: done })
      box.addEventListener('change', () => {
        const next = { ...b, tasks: b.tasks.map((x) => (x.id === t.id ? { ...x, done: box.checked } : x)) }
        if (!persist(next)) {
          box.checked = !box.checked
          return
        }
        ctx.announce(box.checked ? L.taskDone(t.label) : L.taskOpen(t.label))
        renderDashboard()
      })
      return h('li', { class: `bz-task${done ? ' bz-task-done' : ''}` },
        h('label', { class: 'bz-task-label', for: `${id}-t-${t.id}` }, box, h('span', {}, t.label)),
        t.id === ROUTE_TASK_ID
          ? h('button', { class: 'gm-pill bz-task-btn', type: 'button', 'aria-label': L.filmLabel, onclick: () => ctx.openRecorder() }, icon('videocam'), L.film)
          : null,
      )
    }
    const tasks = h(
      'section',
      { class: 'bz-section', 'aria-labelledby': `${id}-tasks` },
      h('div', { class: 'bz-score-row' },
        h('h3', { class: 'bz-h3', id: `${id}-tasks` }, L.tasksHead),
        h('span', { class: 'gm-row-meta' }, L.tasksDone(doneCount, TASKS.length)),
      ),
      h('ul', { class: 'bz-tasks' }, ...TASKS.map(taskRow)),
    )

    el.replaceChildren(
      h(
        'div',
        { class: 'bz' },
        home(b),
        scoreBlock,
        offer,
        entrances,
        tasks,
        msg,
      ),
    )
  }

  // Google Business Profile style header with the round action buttons. Each sub-screen
  // renders into the sheet and comes back to the dashboard; a failing one never kills the tab.
  function sub(open: () => () => void) {
    closeEditor()
    try {
      editorCleanup = open()
    } catch (err) {
      console.error('[doorway] business sub-screen failed', err)
      renderDashboard()
    }
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
        onPhotos: () => sub(() => openBusinessEdit(el, ctx, b.id, back)),
        onPreview: () => {
          const main = linkedEntrances(b, loadSurvey())[0]
          if (main) ctx.openDoor(main)
          else ctx.announce(L.entrancesEmpty)
        },
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
