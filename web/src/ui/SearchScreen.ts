// Full-screen search view, the way Maps opens it when the search pill gets focus:
// back arrow + input on top, category shortcut chips, "Letzte Suchen" with clock
// icons (localStorage, max 8) and a section of accessible places nearby.
// Live suggestions come from the caller; Enter runs the free-text query.

import './search-screen.css'
import { NORMAL_CHIPS } from '../places'
import { lang } from '../strings'
import { h } from './dom'

export interface Suggestion {
  title: string
  sub: string
  icon: string
  go(): void
}

export interface SearchScreenOpts {
  initial: string
  onQuery(q: string): void
  onPickPlaceName(name: string): void
  onClose(): void
  suggestions(q: string): Suggestion[]
}

const RECENT_KEY = 'doorway.recentSearches'
const RECENT_MAX = 8

const S = {
  de: {
    title: 'Suche',
    back: 'Zurück',
    placeholder: 'Hier suchen',
    inputLabel: 'Nach einem Ort oder Eingang suchen',
    clear: 'Eingabe löschen',
    categories: 'Kategorien',
    recent: 'Letzte Suchen',
    recentEmpty: 'Noch keine Suchen.',
    recentRemove: (q: string) => `${q} aus den letzten Suchen entfernen`,
    recentClear: 'Alle löschen',
    nearby: 'Barrierefreie Orte in der Nähe',
    suggestions: 'Vorschläge',
    noResults: 'Kein passender Ort oder Eingang.',
    count: (n: number) => (n === 1 ? '1 Vorschlag' : `${n} Vorschläge`),
    searchFor: (q: string) => `Nach „${q}“ suchen`,
    nearbyItems: [
      { title: 'Stufenlose Eingänge', sub: 'Ebenerdig oder mit Rampe', icon: 'accessible' },
      { title: 'Automatische Türen', sub: 'Öffnen ohne Kraftaufwand', icon: 'door_sliding' },
      { title: 'Barrierefreie Toiletten', sub: 'In Cafés, Bahnhöfen und Läden', icon: 'wc' },
      { title: 'Aufzüge und Rampen', sub: 'Bahnhöfe und Einkaufszentren', icon: 'elevator' },
    ],
  },
  en: {
    title: 'Search',
    back: 'Back',
    placeholder: 'Search here',
    inputLabel: 'Search for a place or an entrance',
    clear: 'Clear input',
    categories: 'Categories',
    recent: 'Recent searches',
    recentEmpty: 'No searches yet.',
    recentRemove: (q: string) => `Remove ${q} from recent searches`,
    recentClear: 'Clear all',
    nearby: 'Accessible places nearby',
    suggestions: 'Suggestions',
    noResults: 'No matching place or entrance.',
    count: (n: number) => (n === 1 ? '1 suggestion' : `${n} suggestions`),
    searchFor: (q: string) => `Search for “${q}”`,
    nearbyItems: [
      { title: 'Step-free entrances', sub: 'Level or with a ramp', icon: 'accessible' },
      { title: 'Automatic doors', sub: 'Open without force', icon: 'door_sliding' },
      { title: 'Accessible restrooms', sub: 'In cafes, stations and shops', icon: 'wc' },
      { title: 'Lifts and ramps', sub: 'Stations and shopping centres', icon: 'elevator' },
    ],
  },
}
const L = lang === 'de' ? S.de : S.en

export function loadRecentSearches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

function storeRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)))
  } catch {
    /* storage unavailable */
  }
}

/** Puts q at the front of the recent list (case-insensitive dedupe), keeps at most 8. */
export function rememberSearch(q: string): string[] {
  const clean = q.trim()
  if (!clean) return loadRecentSearches()
  const next = [clean, ...loadRecentSearches().filter((x) => x.toLowerCase() !== clean.toLowerCase())].slice(0, RECENT_MAX)
  storeRecent(next)
  return next
}

/** Material Symbols glyph. Decorative: the text next to it carries the meaning. */
const icon = (name: string) => h('span', { class: 'ms', 'aria-hidden': 'true' }, name)

function row(ic: string, title: string, sub: string, onclick: () => void, trailing?: HTMLElement | null) {
  return h(
    'li',
    { role: 'listitem' },
    h(
      'div',
      { class: 'ss-row' },
      h(
        'button',
        { class: 'ss-row-btn', type: 'button', onclick },
        h('span', { class: 'ss-row-ic' }, icon(ic)),
        h('span', { class: 'ss-row-text' }, h('span', { class: 'ss-row-title' }, title), sub ? h('span', { class: 'ss-row-sub' }, sub) : null),
      ),
      trailing ?? null,
    ),
  )
}

export function openSearchScreen(root: HTMLElement, opts: SearchScreenOpts): () => void {
  let recent = loadRecentSearches()
  let closed = false

  const input = h('input', {
    class: 'ss-input',
    type: 'search',
    value: opts.initial,
    placeholder: L.placeholder,
    'aria-label': L.inputLabel,
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    'aria-controls': 'ss-suggestions',
  }) as HTMLInputElement
  const backBtn = h('button', { class: 'ss-icon-btn', type: 'button', 'aria-label': L.back }, icon('arrow_back'))
  const clearBtn = h('button', { class: 'ss-icon-btn ss-clear', type: 'button', 'aria-label': L.clear, hidden: true }, icon('close'))
  const bar = h('div', { class: 'ss-bar' }, backBtn, input, clearBtn)

  // Category shortcuts: the same chips as the standard-mode filter row.
  const chips = h(
    'div',
    { class: 'ss-chips', role: 'group', 'aria-label': L.categories },
    ...NORMAL_CHIPS.map((c) => {
      const label = lang === 'de' ? c.labelDe : c.labelEn
      return h('button', { class: 'ss-chip', type: 'button', onclick: () => pick(label) }, icon(c.icon), label)
    }),
  )

  const recentList = h('ul', { class: 'ss-list', role: 'list' })
  const recentClear = h('button', { class: 'ss-text-btn', type: 'button', onclick: () => clearRecent() }, L.recentClear)
  const recentSection = h(
    'section',
    { class: 'ss-section', 'aria-labelledby': 'ss-recent-title' },
    h('div', { class: 'ss-section-head' }, h('h2', { id: 'ss-recent-title', class: 'ss-h2' }, L.recent), recentClear),
    recentList,
  )

  const nearbySection = h(
    'section',
    { class: 'ss-section', 'aria-labelledby': 'ss-nearby-title' },
    h('div', { class: 'ss-section-head' }, h('h2', { id: 'ss-nearby-title', class: 'ss-h2' }, L.nearby)),
    h('ul', { class: 'ss-list', role: 'list' }, ...L.nearbyItems.map((it) => row(it.icon, it.title, it.sub, () => pick(it.title)))),
  )

  const home = h('div', { class: 'ss-home' }, chips, recentSection, nearbySection)
  // A plain list of buttons: role=option around a button is invalid (nested-interactive),
  // and VoiceOver read the rows inconsistently. The live region announces the count.
  const suggestionsList = h('ul', { id: 'ss-suggestions', class: 'ss-list ss-suggest', role: 'list', 'aria-label': L.suggestions, hidden: true })
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' })

  const screen = h(
    'section',
    { class: 'ss', role: 'dialog', 'aria-modal': 'true', 'aria-label': L.title },
    h('h1', { class: 'sr-only' }, L.title),
    bar,
    h('div', { class: 'ss-body' }, suggestionsList, home),
    live,
  )

  function renderRecent() {
    recentClear.hidden = recent.length === 0
    recentList.replaceChildren(
      ...(recent.length
        ? recent.map((q) =>
            row(
              'history',
              q,
              '',
              () => submit(q),
              h('button', { class: 'ss-icon-btn ss-row-remove', type: 'button', 'aria-label': L.recentRemove(q), onclick: () => removeRecent(q) }, icon('close')),
            ),
          )
        : [h('li', { class: 'ss-empty', role: 'listitem' }, L.recentEmpty)]),
    )
  }
  function removeRecent(q: string) {
    recent = recent.filter((x) => x !== q)
    storeRecent(recent)
    renderRecent()
  }
  function clearRecent() {
    recent = []
    storeRecent(recent)
    renderRecent()
    input.focus()
  }

  function renderSuggestions() {
    const q = input.value.trim()
    clearBtn.hidden = q === ''
    if (!q) {
      suggestionsList.hidden = true
      home.hidden = false
      live.textContent = ''
      return
    }
    let hits: Suggestion[] = []
    try {
      hits = opts.suggestions(q)
    } catch {
      hits = []
    }
    const searchRow = h(
      'li',
      { role: 'listitem' },
      h(
        'div',
        { class: 'ss-row' },
        h('button', { class: 'ss-row-btn', type: 'button', onclick: () => submit(q) }, h('span', { class: 'ss-row-ic' }, icon('search')), h('span', { class: 'ss-row-text' }, h('span', { class: 'ss-row-title' }, L.searchFor(q)))),
      ),
    )
    suggestionsList.replaceChildren(
      ...hits.map((r) =>
        h(
          'li',
          { role: 'listitem' },
          h(
            'div',
            { class: 'ss-row' },
            h(
              'button',
              {
                class: 'ss-row-btn',
                type: 'button',
                onclick: () => {
                  recent = rememberSearch(r.title)
                  close()
                  r.go()
                },
              },
              h('span', { class: 'ss-row-ic' }, icon(r.icon)),
              h('span', { class: 'ss-row-text' }, h('span', { class: 'ss-row-title' }, r.title), r.sub ? h('span', { class: 'ss-row-sub' }, r.sub) : null),
            ),
          ),
        ),
      ),
      searchRow,
    )
    suggestionsList.hidden = false
    home.hidden = true
    live.textContent = hits.length ? L.count(hits.length) : L.noResults
  }

  function submit(q: string) {
    const clean = q.trim()
    if (!clean) return
    recent = rememberSearch(clean)
    close()
    opts.onQuery(clean)
  }
  function pick(name: string) {
    recent = rememberSearch(name)
    close()
    opts.onPickPlaceName(name)
  }

  function onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      close()
      return
    }
    // aria-modal is a promise: Tab and Shift+Tab wrap inside the screen.
    if (ev.key !== 'Tab') return
    const focusables = [...screen.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
    )
    if (!focusables.length) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault()
      last.focus()
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault()
      first.focus()
    }
  }
  input.addEventListener('input', renderSuggestions)
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return
    ev.preventDefault()
    submit(input.value)
  })
  clearBtn.addEventListener('click', () => {
    input.value = ''
    renderSuggestions()
    input.focus()
  })
  backBtn.addEventListener('click', () => close())
  screen.addEventListener('keydown', onKey)

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const previousOverflow = root.style.overflow
  // Everything behind the screen is inert, so neither Tab nor a VoiceOver swipe can
  // reach the map, its Google links or the sheet while the dialog is open.
  const madeInert = [...root.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.inert)
  madeInert.forEach((el) => (el.inert = true))
  root.append(screen)
  root.style.overflow = 'hidden'
  renderRecent()
  renderSuggestions()
  input.focus({ preventScroll: true })
  if (opts.initial) input.setSelectionRange(opts.initial.length, opts.initial.length)

  function close() {
    if (closed) return
    closed = true
    screen.removeEventListener('keydown', onKey)
    screen.remove()
    madeInert.forEach((el) => (el.inert = false))
    root.style.overflow = previousOverflow
    previousFocus?.focus({ preventScroll: true })
    // Every way out (back, Escape, submit, pick) reports the close, otherwise the
    // caller keeps thinking the screen is open and the search bar goes dead.
    opts.onClose()
  }
  return close
}
