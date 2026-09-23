// Entrances manager for the "Unternehmen" tab: lists every survey entrance of one business
// as a card with edit, delete (inline confirm), show on map and "set as main entrance".
// All data lives on the device through core/survey. Text goes through h(), never innerHTML.

import './business-entrances.css'
import {
  deleteSurveyEntrance,
  loadBusiness,
  loadSurvey,
  saveBusiness,
  saveSurveyEntrance,
  validLatLon,
  type SurveyEntrance,
} from '../core/survey'
import type { DoorType } from '../core/types'
import { lang } from '../strings'
import type { FeatureCtx } from './ctx'
import { h } from './dom'
import { openEntranceEditor } from './EntranceEditor'

const de = {
  title: 'Eingänge verwalten',
  back: 'Zurück',
  empty: 'Noch keine Eingänge eingetragen.',
  add: 'Eingang hinzufügen',
  unnamed: 'Eingang ohne Namen',
  main: 'Haupteingang',
  stepFree: 'Stufenlos',
  steps: 'Mit Stufen',
  unknown: 'Unbekannt',
  doorUnknown: 'Tür unbekannt',
  door: { no: 'Keine Tür', hinged: 'Flügeltür', sliding: 'Schiebetür', revolving: 'Karusselltür', yes: 'Tür' } as Record<DoorType, string>,
  automatic: 'automatisch',
  photoAlt: 'Foto des Eingangs',
  edit: 'Bearbeiten',
  del: 'Löschen',
  confirmDel: 'Diesen Eingang wirklich löschen?',
  confirmYes: 'Ja, löschen',
  cancel: 'Abbrechen',
  show: 'Auf Karte zeigen',
  setMain: 'Haupteingang festlegen',
  deleted: 'Eingang gelöscht.',
  deleteFailed: 'Löschen fehlgeschlagen.',
  mainSet: 'Haupteingang festgelegt.',
  saveFailed: 'Speichern fehlgeschlagen.',
  saved: 'Eingang gespeichert.',
  noMap: 'Keine Karte verfügbar.',
  shown: 'Eingang auf der Karte gezeigt.',
  count: (n: number) => (n === 1 ? '1 Eingang' : `${n} Eingänge`),
}
const en: typeof de = {
  title: 'Manage entrances',
  back: 'Back',
  empty: 'No entrances added yet.',
  add: 'Add entrance',
  unnamed: 'Unnamed entrance',
  main: 'Main entrance',
  stepFree: 'Step-free',
  steps: 'Has steps',
  unknown: 'Unknown',
  doorUnknown: 'Door unknown',
  door: { no: 'No door', hinged: 'Hinged door', sliding: 'Sliding door', revolving: 'Revolving door', yes: 'Door' },
  automatic: 'automatic',
  photoAlt: 'Photo of the entrance',
  edit: 'Edit',
  del: 'Delete',
  confirmDel: 'Really delete this entrance?',
  confirmYes: 'Yes, delete',
  cancel: 'Cancel',
  show: 'Show on map',
  setMain: 'Set as main entrance',
  deleted: 'Entrance deleted.',
  deleteFailed: 'Deleting failed.',
  mainSet: 'Main entrance set.',
  saveFailed: 'Saving failed.',
  saved: 'Entrance saved.',
  noMap: 'No map available.',
  shown: 'Entrance shown on the map.',
  count: (n: number) => (n === 1 ? '1 entrance' : `${n} entrances`),
}
const L = lang === 'de' ? de : en

let uid = 0
const icon = (name: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, name)

function entrancesOf(businessId: string): SurveyEntrance[] {
  const b = loadBusiness()
  const ids = b && b.id === businessId ? b.entranceIds : []
  return loadSurvey()
    .filter((e) => e.businessId === businessId || ids.includes(e.id))
    .sort((a, b) => Number(b.kind === 'main') - Number(a.kind === 'main') || a.createdAt.localeCompare(b.createdAt))
}

/**
 * The entrance editor saves new entrances as kind 'main'. A business has one main entrance,
 * so a newly added one is demoted when another main entrance already exists.
 */
export function keepOneMain(businessId: string, saved: SurveyEntrance): void {
  if (saved.kind !== 'main') return
  const otherMain = entrancesOf(businessId).some((e) => e.id !== saved.id && e.kind === 'main')
  if (otherMain) saveSurveyEntrance({ ...saved, kind: 'yes' })
}

export function openEntrancesManager(el: HTMLElement, ctx: FeatureCtx, businessId: string, onDone: () => void): () => void {
  const id = `bem${++uid}`
  let editorCleanup: (() => void) | null = null
  let confirmId: string | null = null
  let closed = false

  const closeEditor = () => {
    editorCleanup?.()
    editorCleanup = null
  }

  const status = h('p', { class: 'bem-status', role: 'status', 'aria-live': 'polite' })
  const say = (text: string) => {
    status.textContent = text
    ctx.announce(text)
  }

  const openEditor = (initial?: SurveyEntrance) => {
    closeEditor()
    const b = loadBusiness()
    const start = initial
      ? { lat: initial.lat, lon: initial.lon }
      : b && validLatLon(b.lat, b.lon)
        ? { lat: b.lat, lon: b.lon }
        : (() => {
            const c = ctx.map?.getCenter()
            return c ? { lat: c.lat(), lon: c.lng() } : ctx.origin()
          })()
    editorCleanup = openEntranceEditor(ctx, el, {
      lat: start.lat,
      lon: start.lon,
      businessId,
      by: 'business',
      initial,
      onSaved: (saved) => {
        editorCleanup = null
        // The editor keeps init.id, so an edit replaces in place. Guard anyway.
        if (initial && saved.id !== initial.id) deleteSurveyEntrance(initial.id)
        linkToBusiness(saved.id, initial?.id)
        if (!initial) keepOneMain(businessId, saved)
        ctx.refresh()
        render()
        say(L.saved)
      },
      onCancel: () => {
        editorCleanup = null
        render()
      },
    })
  }

  const linkToBusiness = (newId: string, oldId?: string) => {
    // Business.ts owns the profile; only keep entranceIds consistent here.
    const b = loadBusiness()
    if (!b || b.id !== businessId) return
    const ids = b.entranceIds.filter((x) => x !== oldId)
    if (!ids.includes(newId)) ids.push(newId)
    saveBusiness({ ...b, entranceIds: ids })
  }

  const remove = (e: SurveyEntrance) => {
    confirmId = null
    if (!deleteSurveyEntrance(e.id)) {
      render()
      say(L.deleteFailed)
      return
    }
    const b = loadBusiness()
    if (b && b.id === businessId && b.entranceIds.includes(e.id)) {
      saveBusiness({ ...b, entranceIds: b.entranceIds.filter((x) => x !== e.id) })
    }
    ctx.refresh()
    render()
    say(L.deleted)
  }

  const setMain = (e: SurveyEntrance) => {
    let ok = true
    for (const other of entrancesOf(businessId)) {
      if (other.id !== e.id && other.kind === 'main') ok = saveSurveyEntrance({ ...other, kind: 'yes' }) && ok
    }
    ok = saveSurveyEntrance({ ...e, kind: 'main' }) && ok
    ctx.refresh()
    render()
    say(ok ? L.mainSet : L.saveFailed)
  }

  const show = (e: SurveyEntrance) => {
    if (!ctx.map || !validLatLon(e.lat, e.lon)) {
      say(L.noMap)
      return
    }
    ctx.map.panTo({ lat: e.lat, lng: e.lon })
    ctx.map.setZoom(20)
    ctx.setSheet('peek')
    say(L.shown)
  }

  const card = (e: SurveyEntrance, i: number) => {
    const titleId = `${id}-t${i}`
    const verdict = e.stepFree === true ? L.stepFree : e.stepFree === false ? L.steps : L.unknown
    const vClass = e.stepFree === true ? 'bem-ok' : e.stepFree === false ? 'bem-bad' : 'bem-unk'
    const door = e.door ? L.door[e.door] + (e.automatic ? `, ${L.automatic}` : '') : L.doorUnknown
    const isMain = e.kind === 'main'

    const actions =
      confirmId === e.id
        ? h(
            'div',
            { class: 'bem-confirm', role: 'group', 'aria-label': L.confirmDel },
            h('p', { class: 'bem-confirm-text' }, L.confirmDel),
            h('button', { class: 'gm-pill bem-danger', id: `${id}-yes${i}`, type: 'button', onclick: () => remove(e) }, L.confirmYes),
            h('button', { class: 'gm-pill', type: 'button', onclick: () => { confirmId = null; render(`${id}-del${i}`) } }, L.cancel),
          )
        : h(
            'div',
            { class: 'bem-actions' },
            h('button', { class: 'gm-pill', type: 'button', 'aria-describedby': titleId, onclick: () => openEditor(e) }, icon('edit'), L.edit),
            h('button', { class: 'gm-pill', type: 'button', 'aria-describedby': titleId, onclick: () => show(e) }, icon('map'), L.show),
            !isMain && h('button', { class: 'gm-pill', type: 'button', 'aria-describedby': titleId, onclick: () => setMain(e) }, icon('star'), L.setMain),
            h('button', { class: 'gm-pill', id: `${id}-del${i}`, type: 'button', 'aria-describedby': titleId, onclick: () => { confirmId = e.id; render(`${id}-yes${i}`) } }, icon('delete'), L.del),
          )

    return h(
      'li',
      { class: 'bem-card', 'aria-labelledby': titleId },
      h(
        'div',
        { class: 'bem-head' },
        e.photo
          ? h('img', { class: 'bem-thumb', src: e.photo, alt: L.photoAlt, width: 56, height: 56, loading: 'lazy' })
          : h('span', { class: 'bem-thumb bem-thumb-empty', 'aria-hidden': 'true' }, icon('door_front')),
        h(
          'div',
          { class: 'bem-text' },
          h('h4', { class: 'bem-title', id: titleId }, e.name ?? L.unnamed, isMain ? h('span', { class: 'bem-main' }, L.main) : null),
          h('p', { class: 'bem-meta' }, h('span', { class: `bem-verdict ${vClass}` }, verdict), h('span', {}, door)),
        ),
      ),
      actions,
    )
  }

  function render(focusId?: string): void {
    if (closed) return
    const list = entrancesOf(businessId)
    const headId = `${id}-h`
    const root = h(
      'section',
      { class: 'bem', 'aria-labelledby': headId },
      h(
        'div',
        { class: 'bem-top' },
        h('button', { class: 'gm-circle bem-back', type: 'button', 'aria-label': L.back, onclick: () => { cleanup(); onDone() } }, icon('arrow_back')),
        h('h3', { class: 'bem-h', id: headId }, L.title),
        h('span', { class: 'bem-count' }, L.count(list.length)),
      ),
      list.length ? h('ul', { class: 'bem-list' }, ...list.map(card)) : h('p', { class: 'gm-p bem-empty' }, L.empty),
      h('button', { class: 'gm-pill gm-pill-primary bem-add', type: 'button', onclick: () => openEditor() }, icon('add'), L.add),
      status,
    )
    el.replaceChildren(root)
    if (focusId) document.getElementById(focusId)?.focus()
  }

  function cleanup(): void {
    if (closed) return
    closed = true
    closeEditor()
  }

  render()
  ctx.setSheet('half')
  return cleanup
}
