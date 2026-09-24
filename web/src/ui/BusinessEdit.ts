// "Profil bearbeiten": Google Business Profile style editor for one business.
// Renders into `el`, stores through core/businessDetails, returns a cleanup function.

import './business-edit.css'
import {
  ACCESS_ATTRS,
  DAYS,
  MAX_DESCRIPTION,
  MAX_PHOTOS,
  completeness,
  emptyDetails,
  loadDetails,
  saveDetails,
  type BusinessDetails,
  type Tri,
} from '../core/businessDetails'
import { loadBusiness } from '../core/survey'
import type { FeatureCtx } from './ctx'
import { h } from './dom'

const TRI: { v: Tri; label: string }[] = [
  { v: 'ja', label: 'Ja' },
  { v: 'nein', label: 'Nein' },
  { v: 'unbekannt', label: 'Keine Angabe' },
]

let uid = 0
const nextId = (p: string) => `be-${p}-${++uid}`

function initial(businessId: string): BusinessDetails {
  const saved = loadDetails(businessId)
  if (saved) return saved
  const d = emptyDetails()
  const b = loadBusiness()
  if (b && b.id === businessId) {
    d.name = b.name
    d.address = b.address ?? ''
    if (Number.isFinite(b.lat) && Number.isFinite(b.lon)) {
      d.lat = b.lat
      d.lon = b.lon
    }
  }
  return d
}

/** Read a picked image, downscale so the long side is at most 800px, return a JPEG data URL. */
function downscale(file: File, max = 800): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.naturalWidth * k))
      c.height = Math.max(1, Math.round(img.naturalHeight * k))
      const g = c.getContext('2d')
      URL.revokeObjectURL(url)
      if (!g) return reject(new Error('no canvas'))
      g.drawImage(img, 0, 0, c.width, c.height)
      resolve(c.toDataURL('image/jpeg', 0.8))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('bad image'))
    }
    img.src = url
  })
}

export function openBusinessEdit(el: HTMLElement, ctx: FeatureCtx, businessId: string, onDone: () => void): () => void {
  const d = initial(businessId)
  let closed = false

  const status = h('p', { class: 'be-status', role: 'status', 'aria-live': 'polite' })
  const scoreText = h('span', { class: 'be-score' })
  const scoreFill = h('div', { class: 'be-bar-fill' })
  const updateScore = () => {
    const n = completeness(d)
    scoreText.textContent = `${n} %`
    scoreFill.style.width = `${n}%`
  }

  const section = (title: string, ...body: (Node | null)[]) => {
    const hid = nextId('h')
    return h('section', { class: 'be-section', 'aria-labelledby': hid }, h('h3', { class: 'be-h3', id: hid }, title), ...body)
  }

  const field = (label: string, input: HTMLInputElement | HTMLTextAreaElement, extra?: Node) => {
    const id = nextId('f')
    input.id = id
    return h('div', { class: 'be-field' }, h('label', { class: 'be-label', for: id }, label), input, extra ?? null)
  }

  const text = (key: 'name' | 'category' | 'phone' | 'website' | 'address', type: string, ph: string, auto?: string) => {
    const i = h('input', { class: 'be-input', type, placeholder: ph, value: d[key], autocomplete: auto }) as HTMLInputElement
    i.addEventListener('input', () => {
      d[key] = i.value
      updateScore()
    })
    return i
  }

  // Info
  const desc = h('textarea', { class: 'be-input be-textarea', rows: 5, maxlength: MAX_DESCRIPTION, placeholder: 'Was macht dein Unternehmen aus?' }) as HTMLTextAreaElement
  desc.value = d.description
  const counter = h('p', { class: 'be-hint', 'aria-live': 'polite' })
  const setCounter = () => (counter.textContent = `${desc.value.length} von ${MAX_DESCRIPTION} Zeichen`)
  setCounter()
  desc.addEventListener('input', () => {
    d.description = desc.value.slice(0, MAX_DESCRIPTION)
    setCounter()
    updateScore()
  })

  // Standort
  const locText = h('p', { class: 'be-hint' })
  const setLocText = () =>
    (locText.textContent =
      d.lat !== null && d.lon !== null ? `Pin: ${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}` : 'Noch kein Pin gesetzt.')
  setLocText()
  const pinBtn = h(
    'button',
    {
      type: 'button',
      class: 'gm-pill be-wide',
      onclick: () => {
        const c = ctx.map?.getCenter()
        const p = c ? { lat: c.lat(), lon: c.lng() } : ctx.origin()
        d.lat = p.lat
        d.lon = p.lon
        setLocText()
        updateScore()
        ctx.announce('Pin auf die Kartenmitte gesetzt.')
      },
    },
    h('span', { class: 'ms', 'aria-hidden': 'true' }, 'location_on'),
    'Pin auf Karte neu setzen',
  )

  // Öffnungszeiten
  const hoursRows = DAYS.map((day, i) => {
    const hrs = d.hours[i]
    const cbId = nextId('day')
    const cb = h('input', { type: 'checkbox', class: 'be-check', id: cbId, checked: hrs.open }) as HTMLInputElement
    const state = h('span', { class: 'be-day-state' }, hrs.open ? 'Geöffnet' : 'Geschlossen')
    const from = h('input', { type: 'time', class: 'be-input be-time', value: hrs.from, 'aria-label': `${day} von` }) as HTMLInputElement
    const to = h('input', { type: 'time', class: 'be-input be-time', value: hrs.to, 'aria-label': `${day} bis` }) as HTMLInputElement
    const times = h('div', { class: 'be-times' }, from, h('span', { class: 'be-dash', 'aria-hidden': 'true' }, 'bis'), to)
    times.hidden = !hrs.open
    cb.addEventListener('change', () => {
      hrs.open = cb.checked
      state.textContent = cb.checked ? 'Geöffnet' : 'Geschlossen'
      times.hidden = !cb.checked
      updateScore()
    })
    from.addEventListener('change', () => from.value && (hrs.from = from.value))
    to.addEventListener('change', () => to.value && (hrs.to = to.value))
    return h(
      'div',
      { class: 'be-day' },
      h('label', { class: 'be-day-head', for: cbId }, h('span', { class: 'be-day-name' }, day), state, cb),
      times,
    )
  })

  // Fotos
  const grid = h('div', { class: 'be-photos' })
  const renderPhotos = () => {
    grid.replaceChildren(
      ...d.photos.map((src, i) =>
        h(
          'figure',
          { class: 'be-photo' },
          h('img', { src, alt: `Foto ${i + 1}` }),
          h(
            'button',
            {
              type: 'button',
              class: 'be-photo-del',
              'aria-label': `Foto ${i + 1} löschen`,
              onclick: () => {
                d.photos.splice(i, 1)
                renderPhotos()
                updateScore()
                ctx.announce('Foto gelöscht.')
              },
            },
            h('span', { class: 'ms', 'aria-hidden': 'true' }, 'delete'),
          ),
        ),
      ),
    )
  }
  renderPhotos()
  const fileId = nextId('file')
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, id: fileId, class: 'be-file' }) as HTMLInputElement
  file.addEventListener('change', async () => {
    const files = Array.from(file.files ?? []).slice(0, MAX_PHOTOS - d.photos.length)
    file.value = ''
    let added = 0
    for (const f of files) {
      try {
        d.photos.push(await downscale(f))
        added++
      } catch {
        /* skip unreadable file */
      }
    }
    if (closed) return
    renderPhotos()
    updateScore()
    status.textContent = added ? `${added} Foto${added === 1 ? '' : 's'} hinzugefügt.` : 'Foto konnte nicht gelesen werden.'
  })
  const fileLabel = h(
    'label',
    { class: 'gm-pill be-wide', for: fileId },
    h('span', { class: 'ms', 'aria-hidden': 'true' }, 'add_a_photo'),
    'Fotos hinzufügen',
  )

  // Barrierefreiheit
  const accessRows = ACCESS_ATTRS.map((a) => {
    const name = nextId('acc')
    const lid = nextId('l')
    return h(
      'div',
      { class: 'be-attr', role: 'radiogroup', 'aria-labelledby': lid },
      h('span', { class: 'be-attr-label', id: lid }, a.label),
      h(
        'div',
        { class: 'be-seg' },
        ...TRI.map((t) => {
          const r = h('input', { type: 'radio', name, value: t.v, checked: d.access[a.id] === t.v, class: 'be-seg-input' }) as HTMLInputElement
          r.addEventListener('change', () => {
            if (r.checked) {
              d.access[a.id] = t.v
              updateScore()
            }
          })
          return h('label', { class: 'be-seg-opt' }, r, h('span', {}, t.label))
        }),
      ),
    )
  })

  // Sticky bar
  const cancel = h('button', { type: 'button', class: 'gm-pill be-bar-btn', onclick: () => finish() }, 'Abbrechen')
  const save = h(
    'button',
    {
      type: 'button',
      class: 'gm-pill gm-pill-primary be-bar-btn',
      onclick: () => {
        if (!d.name.trim()) {
          status.textContent = 'Bitte gib einen Namen ein.'
          nameInput.focus()
          return
        }
        if (!saveDetails(businessId, d)) {
          status.textContent = 'Speichern nicht möglich. Der Speicher ist blockiert oder voll, eventuell Fotos löschen.'
          return
        }
        ctx.announce('Profil gespeichert.')
        finish()
      },
    },
    'Speichern',
  )

  const nameInput = text('name', 'text', 'z. B. Café am Platz', 'organization')

  const root = h(
    'form',
    { class: 'be', 'aria-label': 'Profil bearbeiten', onsubmit: (e: Event) => e.preventDefault() },
    h('h2', { id: 'sheet-title', class: 'gm-sheet-title be-title', tabindex: '-1' }, 'Profil bearbeiten'),
    h(
      'div',
      { class: 'be-card' },
      h('div', { class: 'be-score-row' }, h('span', { class: 'be-score-label' }, 'Profil vollständig'), scoreText),
      h('div', { class: 'be-bar', 'aria-hidden': 'true' }, scoreFill),
    ),
    section(
      'Info',
      field('Name des Unternehmens', nameInput),
      field('Kategorie', text('category', 'text', 'z. B. Café')),
      field('Beschreibung', desc, counter),
    ),
    section(
      'Kontakt',
      field('Telefon', text('phone', 'tel', '+49 30 1234567', 'tel')),
      field('Website', text('website', 'url', 'https://', 'url')),
    ),
    section('Standort', field('Adresse', text('address', 'text', 'Straße und Hausnummer', 'street-address')), pinBtn, locText),
    section('Öffnungszeiten', h('div', { class: 'be-days' }, ...hoursRows)),
    section('Fotos', grid, file, fileLabel, h('p', { class: 'be-hint' }, `Bis zu ${MAX_PHOTOS} Fotos.`)),
    section('Barrierefreiheit', h('div', { class: 'be-attrs' }, ...accessRows)),
    status,
    h('div', { class: 'be-actions' }, cancel, save),
  )

  function finish() {
    if (closed) return
    cleanup()
    onDone()
  }

  function cleanup() {
    closed = true
    root.remove()
  }

  updateScore()
  el.replaceChildren(root)
  ctx.setSheet('full')
  root.querySelector<HTMLElement>('#sheet-title')?.focus({ preventScroll: true })
  return cleanup
}
