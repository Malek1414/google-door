// Entrance editor: one draggable pin on the map plus a Google-Maps-edit style form in the
// sheet body. The user drags the pin onto the exact door, answers a few questions and saves
// a survey entrance. Without a map the position is typed as numbers.

import type { DoorType, Warning } from '../core/types'
import { MAX_PHOTO_BYTES, saveSurveyEntrance, surveyTier, type SurveyEntrance } from '../core/survey'
import { lang } from '../strings'
import type { FeatureCtx } from './ctx'
import { h } from './dom'
import './entrance-editor.css'

const de = {
  title: 'Eingang eintragen',
  dragHint: 'Genau auf die Tür ziehen',
  pinMoved: 'Stecknadel verschoben.',
  lat: 'Breitengrad',
  lon: 'Längengrad',
  noMap: 'Keine Karte verfügbar. Position als Zahlen eingeben.',
  name: 'Name (optional)',
  namePh: 'z. B. Haupteingang',
  stepFree: 'Stufenlos?',
  yes: 'Ja',
  no: 'Nein',
  unknown: 'Weiß nicht',
  ramp: 'Rampe vorhanden',
  doorType: 'Türart',
  doorNone: 'Keine Tür',
  doorHinged: 'Flügeltür',
  doorSliding: 'Schiebetür',
  doorRevolving: 'Karusselltür',
  automatic: 'Öffnet automatisch',
  bell: 'Klingel vorhanden',
  width: 'Türbreite in cm',
  tactile: 'Blindenleitsystem oder taktile Hinweise',
  note: 'Notiz',
  notePh: 'Was sollte man vor Ort wissen?',
  photo: 'Foto der Tür',
  photoAlt: 'Vorschau des Fotos',
  photoRemove: 'Foto entfernen',
  save: 'Speichern',
  cancel: 'Abbrechen',
  saving: 'Wird gespeichert.',
  saved: 'Eingang gespeichert.',
  saveFailed: 'Speichern fehlgeschlagen. Bitte erneut versuchen.',
  badCoords: 'Bitte gültige Koordinaten eingeben.',
}
const en: typeof de = {
  title: 'Add entrance',
  dragHint: 'Drag exactly onto the door',
  pinMoved: 'Pin moved.',
  lat: 'Latitude',
  lon: 'Longitude',
  noMap: 'No map available. Enter the position as numbers.',
  name: 'Name (optional)',
  namePh: 'e.g. Main entrance',
  stepFree: 'Step-free?',
  yes: 'Yes',
  no: 'No',
  unknown: 'Not sure',
  ramp: 'Ramp available',
  doorType: 'Door type',
  doorNone: 'No door',
  doorHinged: 'Hinged door',
  doorSliding: 'Sliding door',
  doorRevolving: 'Revolving door',
  automatic: 'Opens automatically',
  bell: 'Doorbell available',
  width: 'Door width in cm',
  tactile: 'Tactile paving or guidance',
  note: 'Note',
  notePh: 'What should people know on site?',
  photo: 'Photo of the door',
  photoAlt: 'Photo preview',
  photoRemove: 'Remove photo',
  save: 'Save',
  cancel: 'Cancel',
  saving: 'Saving.',
  saved: 'Entrance saved.',
  saveFailed: 'Saving failed. Please try again.',
  badCoords: 'Please enter valid coordinates.',
}
const L = lang === 'de' ? de : en

const svgUrl = (svg: string) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
// Step-free pin (same glyph as the map markers), pointed tip marks the door.
// Blue, not yellow: style.css carries the reason — blue is ISO 7001's wheelchair
// colour and Material 3's dark primary, and safety-yellow would say "warning"
// about the one door in the set that is easiest to use.
const EDIT_PIN = svgUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 64"><path d="M24 62C24 62 4 38 4 22A20 20 0 0 1 44 22C44 38 24 62 24 62Z" fill="#1a73e8" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round"/>' +
    '<g transform="translate(8 6)"><circle cx="15" cy="6.5" r="2.6" fill="#fff"/><path d="M14.5 10.5V18H21L24 24.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 14H20" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M11 14.5A6.5 6.5 0 1 0 20.5 22.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></g></svg>',
)

const MAX_PHOTO_PX = 800
const EDIT_ZOOM = 20

type YesNo = boolean | null
let uid = 0

export interface EntranceEditorOpts {
  lat: number
  lon: number
  businessId?: string
  by: 'business' | 'community'
  initial?: Partial<SurveyEntrance>
  onSaved: (e: SurveyEntrance) => void
  onCancel: () => void
}

function warningsFor(stepFree: YesNo, door: DoorType | null): Warning[] {
  const w: Warning[] = []
  if (door === 'revolving') w.push('revolving')
  if (stepFree === false) w.push('steps')
  return w
}

/** Downscale an image file to at most 800 px on the long side, JPEG data URL. */
async function downscale(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const scale = Math.min(1, MAX_PHOTO_PX / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    // Step quality down until the data URL fits the survey store limit.
    for (const q of [0.8, 0.65, 0.5, 0.35]) {
      const out = canvas.toDataURL('image/jpeg', q)
      if (out.length <= MAX_PHOTO_BYTES) return out
    }
    throw new Error('photo too large')
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function openEntranceEditor(ctx: FeatureCtx, el: HTMLElement, opts: EntranceEditorOpts): () => void {
  const init = opts.initial ?? {}
  const id = `ee${++uid}`
  let pos = { lat: init.lat ?? opts.lat, lon: init.lon ?? opts.lon }
  let stepFree: YesNo = init.stepFree ?? null
  let photo: string | undefined = init.photo
  let closed = false

  // ---- map pin ----
  let marker: google.maps.Marker | null = null
  const listeners: google.maps.MapsEventListener[] = []
  const hint = h('p', { class: 'ee-hint', role: 'status', 'aria-live': 'polite' }, ctx.map ? L.dragHint : L.noMap)

  if (ctx.map) {
    marker = new google.maps.Marker({
      map: ctx.map,
      position: { lat: pos.lat, lng: pos.lon },
      draggable: true,
      zIndex: 9999,
      title: L.dragHint,
      icon: { url: EDIT_PIN, scaledSize: new google.maps.Size(48, 64), anchor: new google.maps.Point(24, 62) },
    })
    const sync = () => {
      const p = marker!.getPosition()
      if (p) pos = { lat: p.lat(), lon: p.lng() }
    }
    listeners.push(
      marker.addListener('dragstart', () => hint.classList.add('ee-hint-live')),
      marker.addListener('drag', sync),
      marker.addListener('dragend', () => {
        sync()
        hint.classList.remove('ee-hint-live')
        ctx.announce(L.pinMoved)
      }),
      // Tapping the map also moves the pin, easier than dragging on a small screen.
      ctx.map.addListener('click', (ev: google.maps.MapMouseEvent) => {
        if (!ev.latLng) return
        marker!.setPosition(ev.latLng)
        sync()
      }),
    )
    ctx.map.setZoom(EDIT_ZOOM)
    ctx.map.panTo({ lat: pos.lat, lng: pos.lon })
  }

  // ---- form helpers ----
  const field = (label: string, input: HTMLElement, fid: string) =>
    h('div', { class: 'ee-field' }, h('label', { class: 'ee-label', for: fid }, label), input)
  const check = (label: string, checked: boolean | undefined) => {
    const fid = `${id}-${label.length}-${Math.random().toString(36).slice(2, 6)}`
    const input = h('input', { type: 'checkbox', id: fid, class: 'ee-check-input', checked: !!checked }) as HTMLInputElement
    return { input, row: h('label', { class: 'ee-check', for: fid }, input, h('span', {}, label)) }
  }

  // coordinates fallback
  let latIn: HTMLInputElement | null = null
  let lonIn: HTMLInputElement | null = null
  let coordsBlock: HTMLElement | null = null
  if (!ctx.map) {
    latIn = h('input', { id: `${id}-lat`, class: 'ee-input', type: 'number', step: 'any', inputmode: 'decimal', value: String(pos.lat) }) as HTMLInputElement
    lonIn = h('input', { id: `${id}-lon`, class: 'ee-input', type: 'number', step: 'any', inputmode: 'decimal', value: String(pos.lon) }) as HTMLInputElement
    coordsBlock = h('div', { class: 'ee-row' }, field(L.lat, latIn, `${id}-lat`), field(L.lon, lonIn, `${id}-lon`))
  }

  const nameIn = h('input', { id: `${id}-name`, class: 'ee-input', type: 'text', placeholder: L.namePh, value: init.name ?? '', autocomplete: 'off' }) as HTMLInputElement

  // segmented Ja / Nein / Weiss nicht
  const segOpts: { v: YesNo; label: string }[] = [
    { v: true, label: L.yes },
    { v: false, label: L.no },
    { v: null, label: L.unknown },
  ]
  const segBtns = segOpts.map((o) =>
    h('button', { class: 'ee-seg-btn', type: 'button', 'aria-pressed': String(o.v === stepFree), onclick: () => setStepFree(o.v) }, o.label),
  )
  const setStepFree = (v: YesNo) => {
    stepFree = v
    segBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(segOpts[i].v === v)))
  }
  const seg = h(
    'div',
    { class: 'ee-field' },
    h('span', { class: 'ee-label', id: `${id}-sf` }, L.stepFree),
    h('div', { class: 'ee-seg', role: 'group', 'aria-labelledby': `${id}-sf` }, ...segBtns),
  )

  const initAny = init as Record<string, unknown>
  const ramp = check(L.ramp, initAny.ramp as boolean | undefined)

  const doorSel = h(
    'select',
    { id: `${id}-door`, class: 'ee-input' },
    ...([
      ['no', L.doorNone],
      ['hinged', L.doorHinged],
      ['sliding', L.doorSliding],
      ['revolving', L.doorRevolving],
    ] as const).map(([v, label]) => h('option', { value: v, selected: (init.door ?? 'yes') === v }, label)),
  ) as HTMLSelectElement
  const automatic = check(L.automatic, init.automatic)
  const bell = check(L.bell, initAny.bell as boolean | undefined)
  const widthIn = h('input', {
    id: `${id}-width`, class: 'ee-input', type: 'number', min: 40, max: 400, step: 1, inputmode: 'numeric',
    value: typeof initAny.widthCm === 'number' ? String(initAny.widthCm) : '',
  }) as HTMLInputElement
  const tactile = check(L.tactile, initAny.tactile as boolean | undefined)
  const noteIn = h('textarea', { id: `${id}-note`, class: 'ee-input ee-textarea', rows: 3, placeholder: L.notePh }) as HTMLTextAreaElement
  noteIn.value = init.note ?? ''

  // photo
  const photoIn = h('input', { id: `${id}-photo`, class: 'ee-file', type: 'file', accept: 'image/*', capture: 'environment' }) as HTMLInputElement
  const preview = h('div', { class: 'ee-preview' })
  const renderPreview = () => {
    preview.replaceChildren(
      ...(photo
        ? [
            h('img', { src: photo, alt: L.photoAlt, class: 'ee-preview-img' }),
            h('button', { class: 'gm-pill', type: 'button', onclick: () => { photo = undefined; photoIn.value = ''; renderPreview() } }, L.photoRemove),
          ]
        : []),
    )
  }
  photoIn.addEventListener('change', async () => {
    const f = photoIn.files?.[0]
    if (!f) return
    try {
      photo = await downscale(f)
    } catch {
      photo = undefined
    }
    renderPreview()
  })
  renderPreview()

  const err = h('p', { class: 'ee-error', role: 'alert' })
  const saveBtn = h('button', { class: 'gm-pill gm-pill-primary ee-btn', type: 'submit' }, L.save)
  const cancelBtn = h('button', { class: 'gm-pill ee-btn', type: 'button', onclick: () => { cleanup(); opts.onCancel() } }, L.cancel)

  const form = h(
    'form',
    { class: 'ee', novalidate: true },
    h('div', { class: 'gm-sheet-head' }, h('h2', { id: 'sheet-title', class: 'gm-sheet-title', tabindex: '-1' }, L.title)),
    hint,
    coordsBlock,
    field(L.name, nameIn, `${id}-name`),
    seg,
    ramp.row,
    field(L.doorType, doorSel, `${id}-door`),
    automatic.row,
    bell.row,
    field(L.width, widthIn, `${id}-width`),
    tactile.row,
    field(L.note, noteIn, `${id}-note`),
    h('div', { class: 'ee-field' }, h('label', { class: 'ee-label', for: `${id}-photo` }, L.photo), photoIn, preview),
    err,
    h('div', { class: 'gm-actions ee-actions' }, saveBtn, cancelBtn),
  )

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    err.textContent = ''
    if (latIn && lonIn) {
      const la = Number(latIn.value)
      const lo = Number(lonIn.value)
      if (!latIn.value || !lonIn.value || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
        err.textContent = L.badCoords
        return
      }
      pos = { lat: la, lon: lo }
    }
    const door = doorSel.value as DoorType
    const width = widthIn.value ? Math.round(Number(widthIn.value)) : undefined
    const note = noteIn.value.trim()
    const entrance = {
      ...init,
      id: init.id ?? `survey/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      buildingId: init.buildingId ?? null,
      lat: pos.lat,
      lon: pos.lon,
      name: nameIn.value.trim() || null,
      kind: init.kind ?? 'main',
      level: init.level ?? null,
      stepFree,
      tier: surveyTier({ lat: pos.lat, lon: pos.lon, stepFree }),
      confidence: 'surveyed',
      door,
      automatic: automatic.input.checked,
      approachBearing: null,
      description: note || null,
      warnings: warningsFor(stepFree, door),
      source: 'survey',
      photo,
      note: note || undefined,
      by: opts.by,
      businessId: opts.businessId ?? init.businessId,
      createdAt: new Date().toISOString(),
      ramp: ramp.input.checked,
      bell: bell.input.checked,
      tactile: tactile.input.checked,
      widthCm: width !== undefined && Number.isFinite(width) ? width : undefined,
    } as SurveyEntrance

    saveBtn.setAttribute('aria-busy', 'true')
    ctx.announce(L.saving)
    try {
      if (!saveSurveyEntrance(entrance)) throw new Error('not saved')
      ctx.announce(L.saved)
      cleanup()
      opts.onSaved(entrance)
    } catch {
      err.textContent = L.saveFailed
    } finally {
      saveBtn.removeAttribute('aria-busy')
    }
  })

  el.replaceChildren(form)
  ctx.setSheet('half')

  function cleanup(): void {
    if (closed) return
    closed = true
    listeners.forEach((l) => l.remove())
    listeners.length = 0
    marker?.setMap(null)
    marker = null
  }
  return cleanup
}
