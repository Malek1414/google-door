// "Inklusion" page of the "Unternehmen" tab: one Google-style menu list that bundles every
// accessibility setting of a business. Each row opens its own screen and comes back here.
// Questions and measurements are rendered here; entrances, data and the recorder are the
// existing screens. Everything is stored on the device.

import './inclusion.css'
import { ROUTE_TASK_ID, loadBusiness, loadSurvey, saveSurveyEntrance, type BusinessProfile, type SurveyEntrance } from '../core/survey'
import { ACCESS_ATTRS, emptyDetails, loadDetails, saveDetails, type Tri } from '../core/businessDetails'
import { lang } from '../strings'
import type { FeatureCtx } from './ctx'
import { h } from './dom'
import { openEntrancesManager } from './BusinessEntrances'
import { collectBusinessData, openBusinessData } from './BusinessData'

const S = {
  de: {
    title: 'Inklusion',
    back: 'Zurück',
    questions: 'Fragen zur Barrierefreiheit',
    questionsMeta: (d: number, n: number) => `${d} von ${n} beantwortet`,
    entrances: 'Eingänge',
    entrancesMeta: (n: number) => (n === 0 ? 'Noch keine Eingänge' : n === 1 ? '1 Eingang' : `${n} Eingänge`),
    record: 'Weg filmen',
    recorded: 'Gefilmt',
    notRecorded: 'Nicht gefilmt',
    measure: 'Maße nehmen',
    measureMeta: (d: number, n: number) => (n === 0 ? 'Erst einen Eingang anlegen' : d === 0 ? 'Noch nicht gemessen' : `${d} von ${n} gemessen`),
    offer: 'Barrierefreiheit anbieten',
    offerOn: 'An',
    offerOff: 'Aus',
    offerSaidOn: 'Barrierefreiheit wird angeboten.',
    offerSaidOff: 'Barrierefreiheit wird nicht mehr angeboten.',
    data: 'Gesammelte Daten',
    dataMeta: (n: number) => (n === 1 ? '1 Eintrag' : `${n} Einträge`),
    yes: 'Ja',
    no: 'Nein',
    unsure: 'Weiß nicht',
    answerSaved: 'Antwort gespeichert.',
    saveFailed: 'Speichern nicht möglich. Der Speicher des Browsers ist blockiert oder voll.',
    unnamed: 'Eingang ohne Namen',
    width: 'Türbreite',
    threshold: 'Schwellenhöhe',
    slope: 'Rampensteigung',
    cm: 'cm',
    pct: '%',
    cmLong: 'Zentimeter',
    pctLong: 'Prozent',
    save: 'Speichern',
    saved: (n: string) => `Maße gespeichert: ${n}`,
    invalid: (label: string, min: number, max: number) => `${label}: bitte eine Zahl von ${min} bis ${max}.`,
    noEntrances: 'Lege zuerst einen Eingang an.',
    addEntrance: 'Eingänge öffnen',
    hint: 'Leer lassen, wenn es nicht zutrifft.',
  },
  en: {
    title: 'Inclusion',
    back: 'Back',
    questions: 'Accessibility questions',
    questionsMeta: (d: number, n: number) => `${d} of ${n} answered`,
    entrances: 'Entrances',
    entrancesMeta: (n: number) => (n === 0 ? 'No entrances yet' : n === 1 ? '1 entrance' : `${n} entrances`),
    record: 'Film the way',
    recorded: 'Filmed',
    notRecorded: 'Not filmed',
    measure: 'Take measurements',
    measureMeta: (d: number, n: number) => (n === 0 ? 'Add an entrance first' : d === 0 ? 'Not measured yet' : `${d} of ${n} measured`),
    offer: 'Offer accessibility',
    offerOn: 'On',
    offerOff: 'Off',
    offerSaidOn: 'Accessibility is offered.',
    offerSaidOff: 'Accessibility is no longer offered.',
    data: 'Collected data',
    dataMeta: (n: number) => (n === 1 ? '1 entry' : `${n} entries`),
    yes: 'Yes',
    no: 'No',
    unsure: 'Not sure',
    answerSaved: 'Answer saved.',
    saveFailed: 'Could not save. Browser storage is blocked or full.',
    unnamed: 'Unnamed entrance',
    width: 'Door width',
    threshold: 'Threshold height',
    slope: 'Ramp slope',
    cm: 'cm',
    pct: '%',
    cmLong: 'centimetres',
    pctLong: 'percent',
    save: 'Save',
    saved: (n: string) => `Measurements saved: ${n}`,
    invalid: (label: string, min: number, max: number) => `${label}: please enter a number from ${min} to ${max}.`,
    noEntrances: 'Add an entrance first.',
    addEntrance: 'Open entrances',
    hint: 'Leave empty if it does not apply.',
  },
}
const L = S[lang === 'en' ? 'en' : 'de']

export interface InclusionActions {
  /** Back to the dashboard. */
  onBack(): void
  /** Persist the "Barrierefreiheit anbieten" switch. Returns false when storage failed. */
  setOffer(on: boolean): boolean
}

/** Measurements stored on a survey entrance next to the editor's widthCm. */
type Measured = SurveyEntrance & { widthCm?: number; thresholdCm?: number; rampSlopePct?: number }
const MEASURES = [
  { key: 'widthCm', label: L.width, unit: L.cm, min: 40, max: 400, step: 1 },
  { key: 'thresholdCm', label: L.threshold, unit: L.cm, min: 0, max: 50, step: 0.5 },
  { key: 'rampSlopePct', label: L.slope, unit: L.pct, min: 0, max: 50, step: 0.5 },
] as const

let uid = 0
const icon = (name: string, filled = false) => h('span', { class: `ms${filled ? ' ms-fill' : ''}`, 'aria-hidden': 'true' }, name)
const hasMeasure = (e: Measured) => MEASURES.some((m) => typeof e[m.key] === 'number')

function linkedOf(b: BusinessProfile): Measured[] {
  return loadSurvey().filter((e) => b.entranceIds.includes(e.id) || e.businessId === b.id) as Measured[]
}

export function openInclusion(el: HTMLElement, ctx: FeatureCtx, businessId: string, actions: InclusionActions): () => void {
  const id = `inc${++uid}`
  let subCleanup: (() => void) | null = null
  let closed = false
  const closeSub = () => {
    subCleanup?.()
    subCleanup = null
  }
  const current = (): BusinessProfile | null => {
    const b = loadBusiness()
    return b && b.id === businessId ? b : null
  }

  const status = h('p', { class: 'inc-status', role: 'status', 'aria-live': 'polite' })
  const say = (text: string) => {
    status.textContent = text
    ctx.announce(text)
  }

  const bar = (title: string, onBack: () => void, withIcon = false) =>
    h('div', { class: 'inc-top' },
      h('button', { class: 'inc-icon-btn', type: 'button', 'aria-label': L.back, onclick: onBack }, icon('arrow_back')),
      h('h2', { class: 'inc-title', id: 'sheet-title', tabindex: '-1' }, title),
      withIcon ? h('span', { class: 'inc-badge', 'aria-hidden': 'true' }, icon('accessible', true)) : h('span', { class: 'inc-icon-btn', 'aria-hidden': 'true' }),
    )

  const show = (root: HTMLElement, focus = true) => {
    status.textContent = ''
    el.replaceChildren(root)
    el.scrollTop = 0
    ctx.setSheet('full')
    if (focus) root.querySelector<HTMLElement>('#sheet-title')?.focus({ preventScroll: true })
  }

  const openSub = (open: () => () => void) => {
    closeSub()
    try {
      subCleanup = open()
      el.scrollTop = 0
    } catch (err) {
      console.error('[doorway] inclusion sub-screen failed', err)
      renderMenu()
    }
  }
  const backToMenu = () => {
    closeSub()
    ctx.refresh()
    renderMenu()
  }

  // ---------- menu ----------
  function renderMenu(): void {
    const b = current()
    if (!b) return actions.onBack()
    const linked = linkedOf(b)
    const d = loadDetails(b.id)
    const answered = d ? ACCESS_ATTRS.filter((a) => d.access[a.id] !== 'unbekannt').length : 0
    const filmed = b.tasks.some((t) => t.id === ROUTE_TASK_ID && t.done)
    let dataCount = 0
    try {
      const data = collectBusinessData(b, ctx.entrances())
      dataCount = data.own.length + data.community.length + data.nearby.length
    } catch {
      dataCount = linked.length
    }

    const row = (name: string, title: string, meta: string, onclick: () => void) =>
      h('li', {},
        h('button', { class: 'inc-row', type: 'button', onclick },
          h('span', { class: 'inc-row-ic', 'aria-hidden': 'true' }, icon(name)),
          h('span', { class: 'inc-row-text' }, h('span', { class: 'inc-row-title' }, title), h('span', { class: 'inc-row-meta' }, meta)),
          icon('chevron_right'),
        ),
      )

    const sw = h('input', {
      id: `${id}-offer`, class: 'inc-switch', type: 'checkbox', role: 'switch', checked: b.accessibility, 'aria-describedby': `${id}-offer-meta`,
    }) as HTMLInputElement
    const offerMeta = h('span', { class: 'inc-row-meta', id: `${id}-offer-meta` }, b.accessibility ? L.offerOn : L.offerOff)
    sw.addEventListener('change', () => {
      if (!actions.setOffer(sw.checked)) {
        sw.checked = !sw.checked
        say(L.saveFailed)
        return
      }
      offerMeta.textContent = sw.checked ? L.offerOn : L.offerOff
      ctx.announce(sw.checked ? L.offerSaidOn : L.offerSaidOff)
    })

    const list = h('ul', { class: 'inc-list' },
      row('checklist', L.questions, L.questionsMeta(answered, ACCESS_ATTRS.length), renderQuestions),
      row('door_front', L.entrances, L.entrancesMeta(linked.length), () => openSub(() => openEntrancesManager(el, ctx, businessId, backToMenu))),
      row('videocam', L.record, filmed ? L.recorded : L.notRecorded, () => ctx.openRecorder()),
      row('straighten', L.measure, L.measureMeta(linked.filter(hasMeasure).length, linked.length), renderMeasure),
      h('li', {},
        h('label', { class: 'inc-row', for: `${id}-offer` },
          h('span', { class: 'inc-row-ic', 'aria-hidden': 'true' }, icon('storefront')),
          h('span', { class: 'inc-row-text' }, h('span', { class: 'inc-row-title' }, L.offer), offerMeta),
          sw,
        ),
      ),
      row('database', L.data, L.dataMeta(dataCount), () => openSub(() => openBusinessData(el, ctx, businessId, backToMenu))),
    )
    show(h('div', { class: 'inc' }, bar(L.title, actions.onBack, true), list, status))
  }

  // ---------- questions: Ja / Nein / Weiß nicht, saved on tap ----------
  function renderQuestions(): void {
    const b = current()
    if (!b) return actions.onBack()
    let details = loadDetails(b.id) ?? { ...emptyDetails(), name: b.name, address: b.address ?? '', lat: b.lat, lon: b.lon }
    const count = () => ACCESS_ATTRS.filter((a) => details.access[a.id] !== 'unbekannt').length
    const meta = h('p', { class: 'inc-sub' }, L.questionsMeta(count(), ACCESS_ATTRS.length))
    const question = (a: (typeof ACCESS_ATTRS)[number]) => {
      const btns: HTMLButtonElement[] = []
      const paint = () => btns.forEach((x) => {
        const on = x.dataset.v === details.access[a.id]
        x.classList.toggle('is-on', on)
        x.setAttribute('aria-pressed', String(on))
      })
      const opt = (v: Tri, label: string) => {
        const btn = h('button', {
          class: 'inc-seg-btn', type: 'button', 'data-v': v,
          onclick: () => {
            const next = { ...details, access: { ...details.access, [a.id]: v }, updatedAt: new Date().toISOString() }
            if (!saveDetails(b.id, next)) return say(L.saveFailed)
            details = next
            paint()
            meta.textContent = L.questionsMeta(count(), ACCESS_ATTRS.length)
            ctx.announce(L.answerSaved)
          },
        }, label) as HTMLButtonElement
        btns.push(btn)
        return btn
      }
      const group = h('div', { class: 'inc-seg', role: 'group', 'aria-labelledby': `${id}-q-${a.id}` }, opt('ja', L.yes), opt('nein', L.no), opt('unbekannt', L.unsure))
      paint()
      return h('li', { class: 'inc-q' }, h('span', { class: 'inc-q-label', id: `${id}-q-${a.id}` }, a.label), group)
    }
    show(h('div', { class: 'inc' }, bar(L.questions, renderMenu), meta, h('ul', { class: 'inc-qs' }, ...ACCESS_ATTRS.map(question)), status))
  }

  // ---------- measurements per entrance ----------
  function renderMeasure(): void {
    const b = current()
    if (!b) return actions.onBack()
    const linked = linkedOf(b)
    if (!linked.length) {
      show(h('div', { class: 'inc' }, bar(L.measure, renderMenu),
        h('p', { class: 'inc-sub' }, L.noEntrances),
        h('button', { class: 'gm-pill gm-pill-primary inc-wide', type: 'button', onclick: () => openSub(() => openEntrancesManager(el, ctx, businessId, backToMenu)) }, icon('door_front'), L.addEntrance),
        status))
      return
    }
    const card = (e: Measured, i: number) => {
      const name = e.name ?? L.unnamed
      const fid = `${id}-m${i}`
      const inputs = MEASURES.map((m) => {
        const input = h('input', {
          // Text with a decimal keypad: German users type "2,5", which type=number drops.
          id: `${fid}-${m.key}`, class: 'inc-input', type: 'text', inputmode: m.step < 1 ? 'decimal' : 'numeric', autocomplete: 'off',
          value: typeof e[m.key] === 'number' ? String(e[m.key]).replace('.', lang === 'en' ? '.' : ',') : '',
        }) as HTMLInputElement
        return { m, input }
      })
      const err = h('p', { class: 'inc-err', role: 'alert' })
      const submit = (ev: Event) => {
        ev.preventDefault()
        err.textContent = ''
        const next: Measured = { ...e }
        for (const { m, input } of inputs) {
          const raw = input.value.trim().replace(',', '.')
          if (!raw) {
            delete next[m.key]
            continue
          }
          const n = Number(raw)
          if (!Number.isFinite(n) || n < m.min || n > m.max) {
            err.textContent = L.invalid(m.label, m.min, m.max)
            input.focus()
            return
          }
          next[m.key] = m.key === 'widthCm' ? Math.round(n) : Math.round(n * 10) / 10
        }
        if (!saveSurveyEntrance(next)) return say(L.saveFailed)
        Object.assign(e, next)
        ctx.refresh()
        say(L.saved(name))
      }
      return h('li', {},
        h('form', { class: 'inc-card', novalidate: true, onsubmit: submit, 'aria-labelledby': `${fid}-h` },
          h('h3', { class: 'inc-card-title', id: `${fid}-h` }, name),
          ...inputs.map(({ m, input }) =>
            h('div', { class: 'inc-field' },
              h('label', { class: 'inc-label', for: input.id }, m.label, h('span', { class: 'sr-only' }, ` (${m.unit === '%' ? L.pctLong : L.cmLong})`)),
              h('span', { class: 'inc-unit-wrap' }, input, h('span', { class: 'inc-unit', 'aria-hidden': 'true' }, m.unit)),
            )),
          err,
          h('button', { class: 'gm-pill gm-pill-primary inc-save', type: 'submit' }, L.save),
        ),
      )
    }
    show(h('div', { class: 'inc' }, bar(L.measure, renderMenu), h('p', { class: 'inc-sub' }, L.hint), h('ul', { class: 'inc-cards' }, ...linked.map(card)), status))
  }

  renderMenu()

  return () => {
    if (closed) return
    closed = true
    closeSub()
  }
}
