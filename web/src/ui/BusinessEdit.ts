// "Unternehmensinformationen": Google Business Profile style editor for one business.
// One scrolling page with section tabs; every row edits inline and saves on its own.
// Renders into `el` (the sheet body), stores through core/businessDetails, returns a cleanup function.

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
import { loadBusiness, saveBusiness } from '../core/survey'
import type { FeatureCtx } from './ctx'
import { h } from './dom'

const TRI: { v: Tri; label: string }[] = [
  { v: 'ja', label: 'Ja' },
  { v: 'nein', label: 'Nein' },
  { v: 'unbekannt', label: 'Keine Angabe' },
]
const ADD = 'Hinzufügen'
const STORAGE_ERROR = 'Speichern nicht möglich. Der Speicher ist blockiert oder voll, eventuell Fotos löschen.'
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

let uid = 0
const nextId = (p: string) => `be-${p}-${++uid}`
const icon = (name: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, name)

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

/** An open inline editor: its controls, what to focus, and how to write the draft. Returns an error or null. */
interface Editor {
  body: Node[]
  focus: HTMLElement
  apply: (next: BusinessDetails) => string | null
  /** Field that gets aria-invalid and the error text reference. */
  field?: HTMLElement
}

type TextKey = 'name' | 'category' | 'description' | 'phone' | 'website' | 'address'

export function openBusinessEdit(el: HTMLElement, ctx: FeatureCtx, businessId: string, onDone: () => void): () => void {
  const d = initial(businessId)
  let closed = false
  const refreshers: (() => void)[] = []

  const statusLine = () => h('p', { class: 'be-status', role: 'status', 'aria-live': 'polite' })
  const pinStatus = statusLine()
  const photoStatus = statusLine()
  const scoreText = h('span', { class: 'be-score' })
  const scoreFill = h('div', { class: 'be-bar-fill' })
  const refresh = () => {
    const n = completeness(d)
    scoreText.textContent = `${n} %`
    scoreFill.style.width = `${n}%`
    for (const r of refreshers) r()
  }

  /** Name, address and pin also live on the business profile the dashboard shows. */
  const syncProfile = () => {
    const b = loadBusiness()
    if (!b || b.id !== businessId) return
    const address = d.address.trim()
    saveBusiness({
      ...b,
      name: d.name.trim(),
      address: address || undefined,
      ...(d.lat !== null && d.lon !== null ? { lat: d.lat, lon: d.lon } : {}),
    })
  }

  /** Apply a change to a copy, store it, and only then take it over. */
  const persist = (change: (next: BusinessDetails) => string | null): string | null => {
    const next = structuredClone(d)
    const err = change(next)
    if (err) return err
    if (!saveDetails(businessId, next)) return STORAGE_ERROR
    Object.assign(d, next)
    syncProfile()
    refresh()
    return null
  }

  // Only one row edits at a time; opening another closes the current one without saving.
  let closeOpen: (() => void) | null = null

  /** A "label + value or Hinzufügen" row with a pencil. Tapping it swaps in its inline editor. */
  const row = (label: string, value: () => string, build: () => Editor) => {
    const item = h('div', { class: 'be-item' })
    const valueEl = h('span', { class: 'be-value' })
    const btn = h(
      'button',
      { type: 'button', class: 'be-row' },
      h('span', { class: 'be-row-text' }, h('span', { class: 'be-row-label' }, label), valueEl),
      h('span', { class: 'be-pencil' }, icon('edit')),
    )
    const paint = () => {
      const v = value()
      valueEl.textContent = v || ADD
      valueEl.classList.toggle('be-value-empty', !v)
    }
    refreshers.push(paint)
    paint()

    const close = (focusRow: boolean) => {
      if (closeOpen === closer) closeOpen = null
      item.replaceChildren(btn)
      if (focusRow) btn.focus()
    }
    const closer = () => close(false)

    btn.addEventListener('click', () => {
      closeOpen?.()
      closeOpen = closer
      const ed = build()
      const errEl = h('p', { class: 'be-error', id: nextId('err'), role: 'alert' })
      if (ed.field) ed.field.setAttribute('aria-describedby', [ed.field.getAttribute('aria-describedby'), errEl.id].filter(Boolean).join(' '))
      const save = () => {
        const err = persist(ed.apply)
        if (err) {
          errEl.textContent = err
          if (ed.field) {
            ed.field.setAttribute('aria-invalid', 'true')
            ed.field.focus()
          }
          return
        }
        ctx.announce(`${label} gespeichert.`)
        close(true)
      }
      const form = h(
        'form',
        {
          class: 'be-edit',
          'aria-label': `${label} bearbeiten`,
          onsubmit: (e: Event) => {
            e.preventDefault()
            save()
          },
          onkeydown: (e: Event) => {
            if ((e as KeyboardEvent).key === 'Escape') {
              e.stopPropagation()
              close(true)
            }
          },
        },
        ...ed.body,
        errEl,
        h(
          'div',
          { class: 'be-edit-actions' },
          h('button', { type: 'button', class: 'be-text-btn', onclick: () => close(true) }, 'Abbrechen'),
          h('button', { type: 'submit', class: 'gm-pill gm-pill-primary be-save' }, 'Speichern'),
        ),
      )
      item.replaceChildren(form)
      ed.focus.focus({ preventScroll: true })
      form.scrollIntoView({ block: 'nearest' })
    })
    item.append(btn)
    return item
  }

  const textRow = (
    key: TextKey,
    label: string,
    opts: { type?: string; ph?: string; auto?: string; max: number; required?: string; multiline?: boolean; inputmode?: string },
  ) =>
    row(
      label,
      () => d[key].trim(),
      () => {
        const id = nextId('f')
        const input = (
          opts.multiline
            ? h('textarea', { class: 'be-input be-textarea', id, rows: 5, maxlength: opts.max, placeholder: opts.ph })
            : h('input', { class: 'be-input', id, type: opts.type ?? 'text', maxlength: opts.max, placeholder: opts.ph, autocomplete: opts.auto, inputmode: opts.inputmode, enterkeyhint: 'done' })
        ) as HTMLInputElement | HTMLTextAreaElement
        input.value = d[key]
        const body: Node[] = [h('label', { class: 'be-label', for: id }, label), input]
        if (opts.multiline) {
          const counter = h('p', { class: 'be-hint', id: nextId('c'), 'aria-live': 'polite' })
          const count = () => (counter.textContent = `${input.value.length} von ${opts.max} Zeichen`)
          count()
          input.addEventListener('input', count)
          input.setAttribute('aria-describedby', counter.id)
          body.push(counter)
        }
        input.addEventListener('input', () => input.removeAttribute('aria-invalid'))
        return {
          body,
          focus: input,
          field: input,
          apply: (next) => {
            const v = input.value.slice(0, opts.max)
            if (opts.required && !v.trim()) return opts.required
            next[key] = v
            return null
          },
        }
      },
    )

  const section = (key: string, title: string, ...body: Node[]) => {
    const hid = nextId('h')
    return h('section', { class: 'be-section', 'aria-labelledby': hid, 'data-tab': key }, h('h3', { class: 'be-h3', id: hid }, title), ...body)
  }

  // Standort: coordinates card plus the "set pin" action, saved immediately.
  const coords = h('span', { class: 'be-coords-text' })
  refreshers.push(() => {
    coords.textContent = d.lat !== null && d.lon !== null ? `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}` : 'Noch kein Pin gesetzt'
  })
  const pinRow = h(
    'button',
    {
      type: 'button',
      class: 'be-row be-action',
      onclick: () => {
        closeOpen?.()
        const c = ctx.map?.getCenter()
        const p = c ? { lat: c.lat(), lon: c.lng() } : ctx.origin()
        const err = persist((next) => {
          next.lat = p.lat
          next.lon = p.lon
          return null
        })
        pinStatus.textContent = err ?? ''
        if (!err) ctx.announce('Pin auf die Kartenmitte gesetzt.')
      },
    },
    h('span', { class: 'be-row-text' }, h('span', { class: 'be-row-label' }, 'Pin auf Karte neu setzen'), h('span', { class: 'be-value' }, 'Kartenmitte übernehmen')),
    h('span', { class: 'be-pencil' }, icon('my_location')),
  )

  // Öffnungszeiten: one row per day; defaults show as "Hinzufügen" until the owner saved hours once.
  const dayRows = DAYS.map((day, i) =>
    row(
      day,
      () => {
        if (!d.hoursSet) return ''
        const x = d.hours[i]
        return x.open ? `${x.from} bis ${x.to}` : 'Geschlossen'
      },
      () => {
        const x = d.hours[i]
        const cbId = nextId('open')
        const cb = h('input', { type: 'checkbox', class: 'be-check', id: cbId, checked: x.open }) as HTMLInputElement
        const from = h('input', { type: 'time', class: 'be-input be-time', value: x.from, 'aria-label': `${day} von` }) as HTMLInputElement
        const to = h('input', { type: 'time', class: 'be-input be-time', value: x.to, 'aria-label': `${day} bis` }) as HTMLInputElement
        const times = h('div', { class: 'be-times' }, from, h('span', { class: 'be-dash', 'aria-hidden': 'true' }, 'bis'), to)
        times.hidden = !x.open
        cb.addEventListener('change', () => (times.hidden = !cb.checked))
        return {
          body: [
            h('p', { class: 'be-label', 'aria-hidden': 'true' }, day),
            h('label', { class: 'be-switch', for: cbId }, h('span', {}, 'Geöffnet'), cb),
            times,
          ],
          focus: cb,
          field: from,
          apply: (next) => {
            if (cb.checked && (!HHMM.test(from.value) || !HHMM.test(to.value))) return 'Bitte beide Uhrzeiten angeben.'
            next.hours[i] = { open: cb.checked, from: HHMM.test(from.value) ? from.value : x.from, to: HHMM.test(to.value) ? to.value : x.to }
            next.hoursSet = true
            return null
          },
        }
      },
    ),
  )

  // Fotos: grid with an add tile; every change is stored right away.
  const grid = h('div', { class: 'be-photos' })
  const fileId = nextId('file')
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, id: fileId, class: 'be-file' }) as HTMLInputElement
  const addTile = h('label', { class: 'be-photo be-photo-add', for: fileId }, icon('add_a_photo'), h('span', {}, 'Fotos hinzufügen'))
  const photoCount = h('p', { class: 'be-hint' })
  const renderPhotos = () => {
    const tiles = d.photos.map((src, i) =>
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
              const err = persist((next) => {
                next.photos.splice(i, 1)
                return null
              })
              photoStatus.textContent = err ?? ''
              if (!err) ctx.announce('Foto gelöscht.')
            },
          },
          icon('delete'),
        ),
      ),
    )
    grid.replaceChildren(...(d.photos.length < MAX_PHOTOS ? [file, addTile] : []), ...tiles)
    photoCount.textContent = `${d.photos.length} von ${MAX_PHOTOS} Fotos`
  }
  refreshers.push(renderPhotos)
  file.addEventListener('change', async () => {
    const files = Array.from(file.files ?? []).slice(0, MAX_PHOTOS - d.photos.length)
    file.value = ''
    const added: string[] = []
    for (const f of files) {
      try {
        added.push(await downscale(f))
      } catch {
        /* skip unreadable file */
      }
    }
    if (closed) return
    if (!added.length) {
      photoStatus.textContent = 'Foto konnte nicht gelesen werden.'
      return
    }
    const err = persist((next) => {
      next.photos.push(...added.slice(0, MAX_PHOTOS - next.photos.length))
      return null
    })
    photoStatus.textContent = err ?? `${added.length} Foto${added.length === 1 ? '' : 's'} hinzugefügt.`
  })

  // Barrierefreiheit: Ja / Nein / Keine Angabe per attribute.
  const accessRows = ACCESS_ATTRS.map((a) =>
    row(
      a.label,
      () => (d.access[a.id] === 'unbekannt' ? '' : (TRI.find((t) => t.v === d.access[a.id])?.label ?? '')),
      () => {
        const name = nextId('acc')
        const radios = TRI.map(
          (t) => h('input', { type: 'radio', name, value: t.v, checked: d.access[a.id] === t.v, class: 'be-seg-input' }) as HTMLInputElement,
        )
        return {
          body: [
            h(
              'fieldset',
              { class: 'be-fieldset' },
              h('legend', { class: 'be-label' }, a.label),
              h('div', { class: 'be-seg' }, ...radios.map((r, k) => h('label', { class: 'be-seg-opt' }, r, h('span', {}, TRI[k].label)))),
            ),
          ],
          focus: radios.find((r) => r.checked) ?? radios[0],
          apply: (next) => {
            const pick = radios.find((r) => r.checked)
            next.access[a.id] = (pick?.value as Tri) ?? 'unbekannt'
            return null
          },
        }
      },
    ),
  )

  const sections = [
    section(
      'info',
      'Informationen zum Unternehmen',
      textRow('name', 'Unternehmensname', { ph: 'z. B. Café am Platz', auto: 'organization', max: 200, required: 'Bitte gib einen Namen ein.' }),
      textRow('category', 'Unternehmenskategorie', { ph: 'z. B. Café', max: 200 }),
      textRow('description', 'Beschreibung', { ph: 'Was macht dein Unternehmen aus?', max: MAX_DESCRIPTION, multiline: true }),
    ),
    section(
      'kontakt',
      'Kontaktdaten',
      textRow('phone', 'Telefonnummer', { type: 'tel', ph: '+49 30 1234567', auto: 'tel', max: 50 }),
      textRow('website', 'Website', { type: 'url', ph: 'https://', auto: 'url', max: 500, inputmode: 'url' }),
    ),
    section(
      'standort',
      'Standort',
      textRow('address', 'Unternehmensstandort', { ph: 'Straße und Hausnummer', auto: 'street-address', max: 300 }),
      h('div', { class: 'be-coords', role: 'group', 'aria-label': 'Pin' }, h('span', { class: 'be-coords-pin' }, icon('location_on')), coords),
      pinRow,
      pinStatus,
    ),
    section('zeiten', 'Öffnungszeiten', ...dayRows),
    section(
      'mehr',
      'Mehr',
      h('h4', { class: 'be-h4' }, 'Fotos'),
      grid,
      photoCount,
      photoStatus,
      h('h4', { class: 'be-h4' }, 'Barrierefreiheit'),
      ...accessRows,
    ),
  ]

  // Header: back, title, section tabs with teal underline that follow the scroll position.
  const TABS: [string, string][] = [
    ['info', 'Info'],
    ['kontakt', 'Kontakt'],
    ['standort', 'Standort'],
    ['zeiten', 'Öffnungszeiten'],
    ['mehr', 'Mehr'],
  ]
  const tabBtns = TABS.map(([key, label]) =>
    h(
      'button',
      {
        type: 'button',
        class: 'be-tab',
        'data-tab': key,
        onclick: () => {
          const s = sections.find((x) => x.dataset.tab === key)
          if (!s) return
          const top = el.scrollTop + s.getBoundingClientRect().top - el.getBoundingClientRect().top - header.offsetHeight
          el.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
          setActive(key)
          const hd = s.querySelector<HTMLElement>('.be-h3')
          if (hd) {
            hd.tabIndex = -1
            hd.focus({ preventScroll: true })
          }
        },
      },
      label,
    ),
  )
  const tabs = h('nav', { class: 'be-tabs', 'aria-label': 'Abschnitte' }, ...tabBtns)
  let active = ''
  const setActive = (key: string) => {
    if (key === active) return
    active = key
    for (const b of tabBtns) {
      const on = b.dataset.tab === key
      b.classList.toggle('be-tab-on', on)
      if (on) {
        b.setAttribute('aria-current', 'true')
        // Only the tab strip scrolls sideways; scrollIntoView would also stop the page scroll.
        const l = b.offsetLeft - tabs.offsetLeft
        if (l < tabs.scrollLeft) tabs.scrollLeft = l - 12
        else if (l + b.offsetWidth > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = l + b.offsetWidth - tabs.clientWidth + 12
      } else b.removeAttribute('aria-current')
    }
  }
  const header = h(
    'div',
    { class: 'be-top' },
    h(
      'div',
      { class: 'be-bar-row' },
      h('button', { type: 'button', class: 'be-icon-btn', 'aria-label': 'Zurück', onclick: () => finish() }, icon('arrow_back')),
      h('h2', { class: 'be-title' }, 'Unternehmensinformationen'),
      h('span', { class: 'be-icon-btn', 'aria-hidden': 'true' }),
    ),
    tabs,
  )

  const onScroll = () => {
    const limit = el.getBoundingClientRect().top + header.offsetHeight + 24
    let cur = TABS[0][0]
    for (const s of sections) if (s.getBoundingClientRect().top <= limit) cur = s.dataset.tab ?? cur
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) cur = TABS[TABS.length - 1][0]
    setActive(cur)
  }
  el.addEventListener('scroll', onScroll, { passive: true })

  const root = h(
    'div',
    { class: 'be' },
    header,
    h(
      'div',
      { class: 'be-score-box' },
      h('div', { class: 'be-score-row' }, h('span', { class: 'be-score-label' }, 'Profil vollständig'), scoreText),
      h('div', { class: 'be-bar', 'aria-hidden': 'true' }, scoreFill),
    ),
    ...sections,
  )

  function finish() {
    if (closed) return
    cleanup()
    onDone()
  }

  function cleanup() {
    closed = true
    el.removeEventListener('scroll', onScroll)
    root.remove()
  }

  refresh()
  setActive('info')
  el.replaceChildren(root)
  ctx.setSheet('full')
  return cleanup
}
