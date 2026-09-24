// "Barrierefreiheit bearbeiten": the owner answers accessibility questions by hand, in the
// style of Google Business Profile's "Profil bearbeiten". Collapsible section cards, one
// question per row, Ja / Nein / Weiß nicht as native radio chips, numbers with units.
//
// Storage is on this device only (core/accessAnswers, per business and entrance). On save
// the answers are also applied to the owner's survey entrance (core/survey), which is what
// the user side's door card reads. The tier is always re-derived by surveyTier().

import './business-access.css'
import {
  PLACE_KEY,
  SECTIONS,
  answersFromEntrance,
  applyAnswers,
  emptyAnswers,
  isApplicable,
  loadAnswers,
  MAX_NOTE,
  parseNumber,
  progress,
  pruneAnswers,
  rangeText,
  saveAnswers,
  validate,
  type AccessAnswers,
  type AnswerKey,
  type Question,
} from '../core/accessAnswers'
import { loadBusiness, loadSurvey, saveSurveyEntrance, type BusinessProfile, type SurveyEntrance } from '../core/survey'
import type { FeatureCtx } from './ctx'
import { h } from './dom'
import { doorName } from './doorName'

let uid = 0
const icon = (name: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, name)

/** The business's own entrances, main entrance first (same order as "Eingänge"). */
export function ownEntrances(b: BusinessProfile): SurveyEntrance[] {
  return loadSurvey()
    .filter((e) => e.businessId === b.id || b.entranceIds.includes(e.id))
    .sort((x, y) => Number(y.kind === 'main') - Number(x.kind === 'main') || x.createdAt.localeCompare(y.createdAt))
}

/** Stored answers for an entrance, else a prefill from the entrance and the place answers. */
function answersFor(businessId: string, e: SurveyEntrance | null): AccessAnswers {
  const place = loadAnswers(businessId, PLACE_KEY)
  if (!e) return place ?? emptyAnswers()
  return loadAnswers(businessId, e.id) ?? answersFromEntrance(e, place ?? emptyAnswers())
}

/** Progress for the home entry, for the main entrance (or the place without one). */
export function accessProgress(b: BusinessProfile): { done: number; total: number } {
  return progress(answersFor(b.id, ownEntrances(b)[0] ?? null))
}

export interface BusinessAccessOpts {
  onDone: () => void
  /** Opens the entrance manager, offered when the business has no entrance yet. */
  onAddEntrance: () => void
}

export function openBusinessAccess(el: HTMLElement, ctx: FeatureCtx, businessId: string, opts: BusinessAccessOpts): () => void {
  const id = `ax${++uid}`
  const b = loadBusiness()
  if (!b || b.id !== businessId) {
    opts.onDone()
    return () => {}
  }
  const entrances = ownEntrances(b)
  let current: SurveyEntrance | null = entrances[0] ?? null
  let a: AccessAnswers = answersFor(b.id, current)
  let dirty = false
  let errors: Partial<Record<AnswerKey, string>> = {}

  // ---------- header, progress ----------
  const progText = h('p', { class: 'ax-prog-text', id: `${id}-prog` })
  const progFill = h('div', { class: 'ax-bar-fill' })
  const status = h('p', { class: 'ax-status', role: 'status', 'aria-live': 'polite' })
  const saveLabel = h('span', {}, 'Speichern')
  const saveIcon = icon('check')
  saveIcon.hidden = true
  const saveBtn = h('button', { class: 'ax-btn ax-btn-primary', type: 'submit' }, saveIcon, saveLabel)

  const sectionMeta = new Map<string, HTMLElement>()
  const rows = new Map<AnswerKey, { q: Question; row: HTMLElement; input?: HTMLInputElement | HTMLTextAreaElement; err?: HTMLElement; hintId?: string }>()

  function refresh(): void {
    const p = progress(a)
    progText.textContent = `${p.done} von ${p.total} Angaben`
    progFill.style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`
    for (const s of SECTIONS) {
      const live = s.questions.filter((q) => isApplicable(q, a))
      sectionMeta.get(s.id)!.textContent = `${progress(a, live).done} von ${live.length}`
    }
    for (const { q, row } of rows.values()) row.hidden = !isApplicable(q, a)
  }

  function markDirty(): void {
    if (!dirty) {
      dirty = true
      saveLabel.textContent = 'Speichern'
      saveIcon.hidden = true
      status.textContent = ''
    }
    refresh()
  }

  function showError(key: AnswerKey, text: string | undefined): void {
    const r = rows.get(key)
    if (!r?.err || !r.input) return
    r.err.textContent = text ?? ''
    r.err.hidden = !text
    if (text) {
      r.input.setAttribute('aria-invalid', 'true')
      r.input.setAttribute('aria-describedby', [r.hintId, r.err.id].filter(Boolean).join(' '))
    } else {
      r.input.removeAttribute('aria-invalid')
      if (r.hintId) r.input.setAttribute('aria-describedby', r.hintId)
      else r.input.removeAttribute('aria-describedby')
    }
  }

  // ---------- question renderers ----------
  const set = (key: AnswerKey, v: unknown) => {
    ;(a as unknown as Record<AnswerKey, unknown>)[key] = v
    markDirty()
  }

  function chips(q: Question, options: { v: string; label: string; value: unknown }[]): HTMLElement {
    const name = `${id}-${q.key}`
    const cur = a[q.key]
    return h('fieldset', { class: 'ax-q' },
      h('legend', { class: 'ax-q-label' }, q.label),
      h('div', { class: 'ax-chips' },
        ...options.map((o) => {
          const input = h('input', { class: 'ax-chip-input', type: 'radio', name, value: o.v, checked: cur === o.value }) as HTMLInputElement
          input.addEventListener('change', () => { if (input.checked) set(q.key, o.value) })
          return h('label', { class: 'ax-chip' }, input, h('span', { class: 'ax-chip-face' }, o.label))
        }),
      ),
    )
  }

  function question(q: Question): HTMLElement {
    let row: HTMLElement
    if (q.kind === 'yn') {
      row = chips(q, [{ v: 'ja', label: 'Ja', value: true }, { v: 'nein', label: 'Nein', value: false }, { v: 'unbekannt', label: 'Weiß nicht', value: null }])
      rows.set(q.key, { q, row })
    } else if (q.kind === 'choice') {
      row = chips(q, [...q.choices.map((c) => ({ ...c, value: c.v })), { v: '', label: 'Weiß nicht', value: null }])
      rows.set(q.key, { q, row })
    } else if (q.kind === 'num') {
      const fid = `${id}-${q.key}`
      const hintId = `${fid}-hint`
      const v = a[q.key] as number | null
      const input = h('input', {
        id: fid, class: 'ax-input', type: 'text', inputmode: q.int ? 'numeric' : 'decimal', autocomplete: 'off',
        value: v === null ? '' : String(v).replace('.', ','), 'aria-describedby': hintId,
      }) as HTMLInputElement
      const err = h('p', { class: 'ax-err', id: `${fid}-err`, hidden: true })
      input.addEventListener('input', () => {
        set(q.key, parseNumber(input.value))
        if (errors[q.key]) {
          errors = validate(pruneAnswers(a))
          showError(q.key, errors[q.key])
        }
      })
      input.addEventListener('blur', () => {
        errors = validate(pruneAnswers(a))
        showError(q.key, errors[q.key])
      })
      row = h('div', { class: 'ax-q' },
        h('label', { class: 'ax-q-label', for: fid }, q.label.includes(q.unitLong) ? q.label : `${q.label} in ${q.unitLong}`),
        h('div', { class: 'ax-num' }, input, h('span', { class: 'ax-unit', 'aria-hidden': 'true' }, q.unit)),
        h('p', { class: 'ax-hint', id: hintId }, `${rangeText(q)}. Leer lassen, wenn du es nicht weißt.`),
        err,
      )
      rows.set(q.key, { q, row, input, err, hintId })
    } else {
      const fid = `${id}-${q.key}`
      const countId = `${fid}-count`
      const ta = h('textarea', { id: fid, class: 'ax-input ax-textarea', rows: 4, maxlength: MAX_NOTE, placeholder: q.placeholder, 'aria-describedby': countId }) as HTMLTextAreaElement
      ta.value = a.note
      const count = h('p', { class: 'ax-hint', id: countId }, `${ta.value.length} von ${MAX_NOTE} Zeichen`)
      const err = h('p', { class: 'ax-err', id: `${fid}-err`, hidden: true })
      ta.addEventListener('input', () => {
        count.textContent = `${ta.value.length} von ${MAX_NOTE} Zeichen`
        set('note', ta.value)
      })
      row = h('div', { class: 'ax-q' }, h('label', { class: 'ax-q-label', for: fid }, q.label), ta, count, err)
      rows.set(q.key, { q, row, input: ta, err, hintId: countId })
    }
    row.dataset.key = q.key
    return row
  }

  // ---------- collapsible section cards ----------
  const bodies = new Map<string, { btn: HTMLButtonElement; body: HTMLElement }>()
  const setOpen = (sid: string, open: boolean) => {
    const s = bodies.get(sid)!
    s.btn.setAttribute('aria-expanded', String(open))
    s.body.hidden = !open
  }
  function sectionCard(s: (typeof SECTIONS)[number], open: boolean): HTMLElement {
    const bodyId = `${id}-sec-${s.id}`
    const meta = h('span', { class: 'ax-sec-meta' })
    sectionMeta.set(s.id, meta)
    const btn = h('button', { class: 'ax-sec-btn', type: 'button', 'aria-expanded': String(open), 'aria-controls': bodyId },
      h('span', { class: 'ax-sec-title' }, s.title), meta, h('span', { class: 'ms ax-chev', 'aria-hidden': 'true' }, 'expand_more'),
    ) as HTMLButtonElement
    const body = h('div', { class: 'ax-sec-body', id: bodyId, hidden: !open }, ...s.questions.map(question))
    btn.addEventListener('click', () => setOpen(s.id, btn.getAttribute('aria-expanded') !== 'true'))
    bodies.set(s.id, { btn, body })
    return h('section', { class: 'ax-card', 'data-section': s.id }, h('h3', { class: 'ax-h3' }, btn), body)
  }

  // ---------- which entrance ----------
  const nameOf = (e: SurveyEntrance) => doorName(e, ctx.origin(), ctx.buildings())
  let picker: HTMLElement
  if (entrances.length > 1) {
    const name = `${id}-door`
    picker = h('fieldset', { class: 'ax-card ax-q ax-pick' },
      h('legend', { class: 'ax-q-label' }, 'Für welchen Eingang?'),
      h('div', { class: 'ax-chips' },
        ...entrances.map((e) => {
          const input = h('input', { class: 'ax-chip-input', type: 'radio', name, value: e.id, checked: e.id === current?.id }) as HTMLInputElement
          input.addEventListener('change', () => {
            if (!input.checked) return
            if (dirty) {
              status.textContent = 'Du hast ungespeicherte Änderungen. Bitte zuerst speichern.'
              picker.querySelector<HTMLInputElement>(`input[value="${CSS.escape(current?.id ?? '')}"]`)!.checked = true
              return
            }
            current = e
            a = answersFor(b.id, e)
            render(true)
          })
          return h('label', { class: 'ax-chip' }, input, h('span', { class: 'ax-chip-face' }, nameOf(e)))
        }),
      ),
    )
  } else if (current) {
    picker = h('p', { class: 'ax-for' }, `Angaben für: ${nameOf(current)}`)
  } else {
    picker = h('div', { class: 'ax-card ax-notice' },
      h('p', {}, 'Noch kein Eingang eingetragen. Deine Angaben werden gespeichert. An der Tür sehen Besucher sie, sobald du einen Eingang einträgst.'),
      h('button', { class: 'ax-btn ax-btn-tonal', type: 'button', onclick: () => opts.onAddEntrance() }, icon('add'), 'Eingang eintragen'),
    )
  }

  // ---------- save ----------
  function save(ev: Event): void {
    ev.preventDefault()
    const clean = pruneAnswers(a)
    errors = validate(clean)
    for (const key of rows.keys()) showError(key, errors[key])
    const bad = Object.keys(errors) as AnswerKey[]
    if (bad.length) {
      for (const s of SECTIONS) if (s.questions.some((q) => bad.includes(q.key))) setOpen(s.id, true)
      status.textContent = bad.length === 1 ? 'Bitte prüfe 1 Angabe.' : `Bitte prüfe ${bad.length} Angaben.`
      ctx.announce(status.textContent)
      rows.get(bad[0])?.input?.focus()
      return
    }
    let ok = saveAnswers(b!.id, current?.id ?? PLACE_KEY, clean)
    if (ok && current) {
      const next = applyAnswers(current, clean)
      ok = saveSurveyEntrance(next)
      if (ok) current = next
    }
    if (!ok) {
      status.textContent = 'Speichern fehlgeschlagen. Der Speicher ist voll oder blockiert.'
      return
    }
    a = clean
    dirty = false
    saveLabel.textContent = 'Gespeichert'
    saveIcon.hidden = false
    const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    status.textContent = current
      ? `Gespeichert um ${time}. Besucher sehen die Angaben an der Tür.`
      : `Gespeichert um ${time}, nur auf diesem Gerät.`
    ctx.announce('Gespeichert.')
    ctx.refresh()
    refresh()
  }

  function render(focusHead: boolean): void {
    rows.clear()
    sectionMeta.clear()
    bodies.clear()
    dirty = false
    saveLabel.textContent = 'Speichern'
    saveIcon.hidden = true
    const form = h('form', { class: 'ax-form', novalidate: true, 'aria-labelledby': 'sheet-title' },
      picker,
      ...SECTIONS.map((s, i) => sectionCard(s, i === 0)),
      h('div', { class: 'ax-bar' },
        status,
        h('button', { class: 'ax-btn ax-btn-text', type: 'button', onclick: () => opts.onDone() }, 'Zurück'),
        saveBtn,
      ),
    )
    form.addEventListener('submit', save)
    el.replaceChildren(
      h('div', { class: 'ax' },
        h('header', { class: 'ax-head' },
          h('button', { class: 'ax-back', type: 'button', 'aria-label': 'Zurück zu Mein Unternehmen', onclick: () => opts.onDone() }, icon('arrow_back')),
          h('div', { class: 'ax-head-text' },
            h('h2', { id: 'sheet-title', class: 'ax-title', tabindex: '-1' }, 'Barrierefreiheit'),
            h('p', { class: 'ax-sub' }, b!.name),
          ),
        ),
        h('div', { class: 'ax-card ax-prog' },
          progText,
          h('div', { class: 'ax-bar-track', 'aria-hidden': 'true' }, progFill),
          h('p', { class: 'ax-hint' }, 'Beantworte, was du sicher weißt. „Weiß nicht“ ist besser als eine Vermutung.'),
        ),
        form,
      ),
    )
    refresh()
    if (focusHead) el.querySelector<HTMLElement>('#sheet-title')?.focus({ preventScroll: true })
  }

  render(true)
  ctx.setSheet('full')
  return () => el.replaceChildren()
}
