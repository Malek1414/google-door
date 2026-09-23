// "Fuer dich" tab, built after the Google Maps "Für dich" tab: recent places with filter
// chips (Gespeichert / Region / Kategorie), Meine Listen, and a carousel of saved places nearby.
// Data: saved ids 'doorway.saved', recent ids 'doorway.recent', lists 'doorway.lists'.

import './foryou.css'
import { haversineM } from '../core/geo'
import type { Channel } from '../core/profile'
import { guidanceFor } from '../core/target'
import type { Entrance } from '../core/types'
import { lang } from '../strings'
import type { FeatureCtx, Panel } from './ctx'
import { glyphPaths, h, s } from './dom'

const SAVED_KEY = 'doorway.saved'
const RECENT_KEY = 'doorway.recent'
const LISTS_KEY = 'doorway.lists'
const RECENT_MAX = 10
const RECOMMEND_MAX = 5
const ROWS_COLLAPSED = 3
const WALK_M_PER_MIN = 80

type Src = 'saved' | 'recent' | 'all'
type Region = 500 | 2000 | 0
type Cat = 'free' | 'steps' | 'all'
interface List {
  id: string
  name: string
  ids: string[]
}

const L = {
  de: {
    title: 'Für dich',
    profile: 'Dein Profil',
    recentTitle: 'Letzte Orte',
    recentSub: 'Aus deinen gespeicherten und zuletzt angesehenen Eingängen',
    search: 'In deinen Orten suchen',
    searchPh: 'Suchen',
    filterSrc: 'Gespeichert',
    filterRegion: 'Region',
    filterCat: 'Kategorie',
    src: { saved: 'Gespeichert', recent: 'Zuletzt angesehen', all: 'Alle' } as Record<Src, string>,
    region: (m: Region) => (m === 0 ? 'Überall' : m === 500 ? 'Im Umkreis von 500 m' : 'Im Umkreis von 2 km'),
    cat: { free: 'Stufenlos', steps: 'Mit Stufen', all: 'Alle' } as Record<Cat, string>,
    none: 'Keine Eingänge passen zu diesen Filtern.',
    noneAtAll: 'Noch keine Orte. Öffne oder speichere einen Eingang auf der Karte.',
    entrance: 'Eingang',
    mainEntrance: 'Haupteingang',
    unnamed: 'Eingang ohne Namen',
    stepFreeYes: 'Stufenlos',
    stepFreeNo: 'Mit Stufen',
    stepFreeUnknown: 'Stufen unbekannt',
    viewed: 'Angesehen',
    recommended: 'Empfohlen',
    favourites: 'Favoriten',
    minutes: (n: number) => `${n} Min`,
    metres: (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m / 10) * 10} m`),
    save: 'Speichern',
    unsave: 'Gespeichert, nicht mehr speichern',
    more: (n: string) => `Weitere Optionen für ${n}`,
    remove: 'Entfernen',
    share: 'Teilen',
    shared: 'Link kopiert',
    removed: 'Entfernt',
    savedMsg: 'Gespeichert',
    unsavedMsg: 'Nicht mehr gespeichert',
    showAll: 'Alle ansehen',
    showLess: 'Weniger anzeigen',
    lists: 'Meine Listen',
    newList: 'Neue Liste',
    listName: 'Name der Liste',
    create: 'Erstellen',
    cancel: 'Abbrechen',
    marked: 'Markierte Orte',
    wishes: 'Wunschziele',
    sharedList: 'Freigegebene Liste',
    privateList: 'Private Liste',
    places: (n: number) => (n === 1 ? '1 Ort' : `${n} Orte`),
    deleteList: 'Liste löschen',
    listEmpty: 'Diese Liste ist leer.',
    nearby: 'Gespeicherte Orte in der Nähe',
    nearbyNone: 'Speichere einen Eingang mit dem Lesezeichen, dann erscheint er hier.',
    needStepFree: (v: boolean) => `Stufenlos nötig: ${v ? 'ja' : 'nein'}`,
    channels: 'Kanäle',
    ch: { speech: 'Sprache', visual: 'Große Anzeige', haptic: 'Vibration' } as Record<Channel, string>,
    allChannels: 'alle',
    elsewhere: (n: number) => (n === 1 ? '1 Ort liegt in einem anderen Kartenbereich' : `${n} Orte liegen in einem anderen Kartenbereich`),
  },
  en: {
    title: 'For you',
    profile: 'Your profile',
    recentTitle: 'Recent places',
    recentSub: 'From your saved and recently viewed entrances',
    search: 'Search your places',
    searchPh: 'Search',
    filterSrc: 'Saved',
    filterRegion: 'Region',
    filterCat: 'Category',
    src: { saved: 'Saved', recent: 'Recently viewed', all: 'All' } as Record<Src, string>,
    region: (m: Region) => (m === 0 ? 'Anywhere' : m === 500 ? 'Within 500 m' : 'Within 2 km'),
    cat: { free: 'Step-free', steps: 'With steps', all: 'All' } as Record<Cat, string>,
    none: 'No entrances match these filters.',
    noneAtAll: 'No places yet. Open or save an entrance on the map.',
    entrance: 'Entrance',
    mainEntrance: 'Main entrance',
    unnamed: 'Unnamed entrance',
    stepFreeYes: 'Step-free',
    stepFreeNo: 'With steps',
    stepFreeUnknown: 'Steps unknown',
    viewed: 'Viewed',
    recommended: 'Recommended',
    favourites: 'Favourites',
    minutes: (n: number) => `${n} min`,
    metres: (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`),
    save: 'Save',
    unsave: 'Saved, remove from saved',
    more: (n: string) => `More options for ${n}`,
    remove: 'Remove',
    share: 'Share',
    shared: 'Link copied',
    removed: 'Removed',
    savedMsg: 'Saved',
    unsavedMsg: 'Removed from saved',
    showAll: 'See all',
    showLess: 'Show less',
    lists: 'My lists',
    newList: 'New list',
    listName: 'List name',
    create: 'Create',
    cancel: 'Cancel',
    marked: 'Starred places',
    wishes: 'Want to go',
    sharedList: 'Shared list',
    privateList: 'Private list',
    places: (n: number) => (n === 1 ? '1 place' : `${n} places`),
    deleteList: 'Delete list',
    listEmpty: 'This list is empty.',
    nearby: 'Saved places nearby',
    nearbyNone: 'Save an entrance with the bookmark and it shows up here.',
    needStepFree: (v: boolean) => `Step-free needed: ${v ? 'yes' : 'no'}`,
    channels: 'Channels',
    ch: { speech: 'Speech', visual: 'Large visuals', haptic: 'Vibration' } as Record<Channel, string>,
    allChannels: 'all',
    elsewhere: (n: number) => (n === 1 ? '1 place is in another map area' : `${n} places are in another map area`),
  },
}
const T = lang === 'de' ? L.de : L.en

function readJson<V>(key: string, fallback: V): V {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as V) : fallback
  } catch {
    return fallback
  }
}
function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* storage unavailable */
  }
}
function readIds(key: string): string[] {
  const v = readJson<unknown>(key, [])
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Remember that an entrance card was opened. Most recent first, max 10. */
export function rememberRecent(id: string): void {
  if (!id) return
  writeJson(RECENT_KEY, [id, ...readIds(RECENT_KEY).filter((x) => x !== id)].slice(0, RECENT_MAX))
}

/** User lists. Favoriten is virtual (= saved ids) and not stored here. */
function readLists(): List[] {
  const v = readJson<unknown>(LISTS_KEY, null)
  if (!Array.isArray(v)) return [
    { id: 'marked', name: T.marked, ids: [] },
    { id: 'wishes', name: T.wishes, ids: [] },
  ]
  return v.filter((x): x is List => !!x && typeof x.id === 'string' && typeof x.name === 'string' && Array.isArray(x.ids))
}

const stepFreeText = (v: boolean | null) => (v === true ? T.stepFreeYes : v === false ? T.stepFreeNo : T.stepFreeUnknown)
const tone = (e: Entrance) => (e.stepFree === true ? 'free' : e.stepFree === false ? 'steps' : 'unknown')
const nameOf = (e: Entrance) => e.name ?? T.unnamed
const walkMin = (m: number) => Math.max(1, Math.round(m / WALK_M_PER_MIN))

const icon = (name: string, cls = '') => h('span', { class: `ms ${cls}`.trim(), 'aria-hidden': 'true' }, name)

/** Coloured square with the wheelchair door glyph, stands in for a place photo. */
function thumb(e: Entrance, cls: string): HTMLElement {
  const svg = s('svg', { viewBox: '0 0 32 32', width: 34, height: 34, 'aria-hidden': 'true' }, ...glyphPaths('currentColor'))
  const el = h('span', { class: `${cls} fy-tone-${tone(e)}`, 'aria-hidden': 'true' })
  el.append(svg)
  return el
}

async function share(e: Entrance, ctx: FeatureCtx): Promise<void> {
  const url = `https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lon}`
  try {
    if (navigator.share) await navigator.share({ title: nameOf(e), url })
    else {
      await navigator.clipboard.writeText(url)
      ctx.announce(T.shared)
    }
  } catch {
    /* user cancelled */
  }
}

/** Small anchored menu. Closes on selection, Escape or outside click, returns focus. */
function openMenu(anchor: HTMLElement, items: { label: string; checked?: boolean; run: () => void }[]): void {
  document.querySelector('.fy-menu')?.remove()
  const radio = items.some((i) => i.checked !== undefined)
  const close = () => {
    menu.remove()
    document.removeEventListener('pointerdown', outside, true)
    anchor.setAttribute('aria-expanded', 'false')
  }
  const outside = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) close()
  }
  const buttons = items.map((it) =>
    h(
      'button',
      {
        type: 'button',
        class: 'fy-menu-item',
        role: radio ? 'menuitemradio' : 'menuitem',
        'aria-checked': radio ? String(!!it.checked) : undefined,
        onclick: () => {
          close()
          anchor.focus()
          it.run()
        },
      },
      radio ? icon(it.checked ? 'check' : '', 'fy-menu-check') : null,
      it.label,
    ),
  )
  const menu = h('div', { class: 'fy-menu', role: 'menu' }, ...buttons)
  menu.addEventListener('keydown', (ev) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (ev.key === 'Escape') {
      close()
      anchor.focus()
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      buttons[(i + (ev.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus()
    }
  })
  const host = anchor.closest('.fy') ?? document.body
  host.append(menu)
  const a = anchor.getBoundingClientRect()
  const hr = host.getBoundingClientRect()
  menu.style.top = `${a.bottom - hr.top + 6}px`
  menu.style.left = `${Math.max(0, Math.min(a.left - hr.left, hr.width - menu.offsetWidth))}px`
  anchor.setAttribute('aria-expanded', 'true')
  document.addEventListener('pointerdown', outside, true)
  ;(buttons.find((b) => b.getAttribute('aria-checked') === 'true') ?? buttons[0])?.focus()
}

export const forYouPanel: Panel = (el, ctx) => {
  const entrances = ctx.entrances()
  const byId = new Map(entrances.map((e) => [e.id, e] as const))
  const origin = ctx.origin()
  const dist = (e: Entrance) => haversineM(origin, e)

  const recommended = entrances
    .filter((e) => guidanceFor(e, ctx.profile).kind === 'arrow')
    .sort((a, b) => dist(a) - dist(b))
    .slice(0, RECOMMEND_MAX)

  const state = { src: 'all' as Src, region: 0 as Region, cat: 'all' as Cat, query: '', searching: false, expanded: false, openList: '', creating: false }
  const root = h('div', { class: 'fy' })

  const render = (focusSel?: string) => {
    const saved = readIds(SAVED_KEY)
    const recent = readIds(RECENT_KEY)
    const lists = readLists()
    const savedSet = new Set(saved)

    const toggleSave = (e: Entrance) => {
      const on = savedSet.has(e.id)
      writeJson(SAVED_KEY, on ? saved.filter((x) => x !== e.id) : [e.id, ...saved])
      ctx.announce(on ? T.unsavedMsg : T.savedMsg)
      render(`[data-save="${CSS.escape(e.id)}"]`)
    }
    const removeEntry = (e: Entrance) => {
      writeJson(SAVED_KEY, saved.filter((x) => x !== e.id))
      writeJson(RECENT_KEY, recent.filter((x) => x !== e.id))
      writeJson(LISTS_KEY, lists.map((l) => ({ ...l, ids: l.ids.filter((x) => x !== e.id) })))
      ctx.announce(T.removed)
      render('.fy-title')
    }

    // Pool for "Letzte Orte": source filter, then region, category and search.
    const origins = new Map<string, 'saved' | 'recent' | 'rec'>()
    if (state.src !== 'recent') for (const id of saved) origins.set(id, 'saved')
    if (state.src !== 'saved') for (const id of recent) if (!origins.has(id)) origins.set(id, 'recent')
    if (state.src === 'all') for (const e of recommended) if (!origins.has(e.id)) origins.set(e.id, 'rec')
    const missing = [...origins.keys()].filter((id) => !byId.has(id)).length
    const q = state.query.trim().toLowerCase()
    const pool = [...origins.keys()]
      .map((id) => byId.get(id))
      .filter((e): e is Entrance => !!e)
      .filter((e) => !state.region || dist(e) <= state.region)
      .filter((e) => state.cat === 'all' || (state.cat === 'free' ? e.stepFree === true : e.stepFree === false))
      .filter((e) => !q || nameOf(e).toLowerCase().includes(q))
    const shown = state.expanded ? pool : pool.slice(0, ROWS_COLLAPSED)

    const metaLine = (e: Entrance) => {
      const kind = origins.get(e.id)
      if (kind === 'saved') return h('span', { class: 'fy-row-meta' }, icon('favorite', 'fy-ic-heart'), T.favourites)
      const label = kind === 'rec' ? T.recommended : T.viewed
      return h('span', { class: 'fy-row-meta' }, `${label} · ${T.minutes(walkMin(dist(e)))}`)
    }

    const placeRow = (e: Entrance) => {
      const on = savedSet.has(e.id)
      const more: HTMLButtonElement = h(
        'button',
        { type: 'button', class: 'fy-more', 'aria-label': T.more(nameOf(e)), 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => openMenu(more, [{ label: T.remove, run: () => removeEntry(e) }, { label: T.share, run: () => void share(e, ctx) }]) },
        icon('more_horiz'),
      )
      return h(
        'li',
        { class: 'fy-row' },
        h(
          'button',
          { type: 'button', class: 'fy-row-main', onclick: () => ctx.openDoor(e) },
          thumb(e, 'fy-thumb'),
          h(
            'span',
            { class: 'fy-row-text' },
            h('span', { class: 'fy-row-title' }, nameOf(e)),
            h('span', { class: 'fy-row-cat' }, `${e.kind === 'main' ? T.mainEntrance : T.entrance} · ${stepFreeText(e.stepFree)}`),
            metaLine(e),
          ),
        ),
        h('button', { type: 'button', class: `fy-save${on ? ' is-on' : ''}`, 'data-save': e.id, 'aria-pressed': String(on), 'aria-label': `${on ? T.unsave : T.save}: ${nameOf(e)}`, onclick: () => toggleSave(e) }, icon('bookmark', on ? 'ms-fill' : '')),
        more,
      )
    }

    const chip = (id: string, label: string, active: boolean, items: { label: string; checked: boolean; run: () => void }[]) => {
      const b: HTMLButtonElement = h('button', { type: 'button', class: `fy-chip${active ? ' is-active' : ''}`, 'data-chip': id, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => openMenu(b, items) }, label, icon('arrow_drop_down'))
      return b
    }
    const set = <K extends 'src' | 'region' | 'cat'>(k: K, v: (typeof state)[K], chipId: string) => () => {
      state[k] = v
      state.expanded = false
      render(`[data-chip="${chipId}"]`)
    }

    const searchBtn = h('button', { type: 'button', class: 'fy-chip-search', 'aria-label': T.search, 'aria-expanded': String(state.searching), onclick: () => {
      state.searching = !state.searching
      if (!state.searching) state.query = ''
      render(state.searching ? '.fy-search-input' : '.fy-chip-search')
    } }, icon('search'))
    const searchInput = state.searching
      ? h('input', { class: 'fy-search-input', type: 'search', placeholder: T.searchPh, 'aria-label': T.search, value: state.query, oninput: (ev: Event) => {
          state.query = (ev.target as HTMLInputElement).value
          render('.fy-search-input')
        } })
      : null

    const chips = h(
      'div',
      { class: 'fy-chips', role: 'toolbar', 'aria-label': T.recentTitle },
      searchBtn,
      chip('src', state.src === 'all' ? T.filterSrc : T.src[state.src], state.src !== 'all', (['saved', 'recent', 'all'] as Src[]).map((v) => ({ label: T.src[v], checked: state.src === v, run: set('src', v, 'src') }))),
      chip('region', state.region ? T.region(state.region) : T.filterRegion, !!state.region, ([500, 2000, 0] as Region[]).map((v) => ({ label: T.region(v), checked: state.region === v, run: set('region', v, 'region') }))),
      chip('cat', state.cat === 'all' ? T.filterCat : T.cat[state.cat], state.cat !== 'all', (['free', 'steps', 'all'] as Cat[]).map((v) => ({ label: T.cat[v], checked: state.cat === v, run: set('cat', v, 'cat') }))),
    )

    const rows: HTMLElement[] = shown.map(placeRow)
    if (!rows.length) rows.push(h('li', { class: 'fy-empty' }, origins.size ? T.none : T.noneAtAll))
    if (missing && state.expanded) rows.push(h('li', { class: 'fy-empty' }, T.elsewhere(missing)))

    // Meine Listen: Favoriten (= saved) first, then stored lists.
    const listIcons: Record<string, [string, string]> = { fav: ['favorite', 'fy-ic-heart'], marked: ['star', 'fy-ic-star'], wishes: ['flag', 'fy-ic-flag'] }
    const allLists: (List & { shared: boolean })[] = [{ id: 'fav', name: T.favourites, ids: saved, shared: true }, ...lists.map((l) => ({ ...l, shared: l.id !== 'marked' }))]
    const listRow = (l: List & { shared: boolean }) => {
      const [ic, cls] = listIcons[l.id] ?? ['list', 'fy-ic-list']
      const open = state.openList === l.id
      const items = l.ids.map((id) => byId.get(id)).filter((e): e is Entrance => !!e)
      const moreItems = [{ label: T.share, run: () => void navigator.clipboard?.writeText(l.name).then(() => ctx.announce(T.shared)).catch(() => {}) }]
      if (l.id !== 'fav') moreItems.unshift({ label: T.deleteList, run: () => {
        writeJson(LISTS_KEY, lists.filter((x) => x.id !== l.id))
        render('.fy-new')
      } })
      const more: HTMLButtonElement = h('button', { type: 'button', class: 'fy-more', 'aria-label': T.more(l.name), 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => openMenu(more, moreItems) }, icon('more_horiz'))
      return h(
        'li',
        { class: 'fy-list' },
        h(
          'div',
          { class: 'fy-list-head' },
          h(
            'button',
            { type: 'button', class: 'fy-list-main', 'aria-expanded': String(open), 'data-list': l.id, onclick: () => {
              state.openList = open ? '' : l.id
              render(`[data-list="${CSS.escape(l.id)}"]`)
            } },
            icon(ic, `fy-list-ic ${cls}`),
            h('span', { class: 'fy-row-text' }, h('span', { class: 'fy-list-name' }, l.name), h('span', { class: 'fy-list-meta' }, `${l.shared ? T.sharedList : T.privateList} · ${T.places(l.ids.length)}`)),
          ),
          more,
        ),
        open ? h('ul', { class: 'fy-sublist' }, ...(items.length ? items.map(placeRow) : [h('li', { class: 'fy-empty' }, T.listEmpty)])) : null,
      )
    }

    const newListForm = state.creating
      ? h(
          'form',
          { class: 'fy-newform', onsubmit: (ev: Event) => {
            ev.preventDefault()
            const input = (ev.target as HTMLFormElement).querySelector('input')!
            const name = input.value.trim()
            if (!name) return input.focus()
            writeJson(LISTS_KEY, [...lists, { id: `l${Date.now().toString(36)}`, name, ids: [] }])
            state.creating = false
            render('.fy-new')
          } },
          h('input', { class: 'fy-newform-input', type: 'text', maxlength: 60, 'aria-label': T.listName, placeholder: T.listName, required: true }),
          h('button', { type: 'submit', class: 'fy-newform-ok' }, T.create),
          h('button', { type: 'button', class: 'fy-newform-cancel', onclick: () => {
            state.creating = false
            render('.fy-new')
          } }, T.cancel),
        )
      : null

    // Carousel: saved entrances by distance.
    const near = saved.map((id) => byId.get(id)).filter((e): e is Entrance => !!e).sort((a, b) => dist(a) - dist(b))
    const card = (e: Entrance) =>
      h(
        'li',
        { class: 'fy-card' },
        h(
          'button',
          { type: 'button', class: 'fy-card-btn', onclick: () => ctx.openDoor(e) },
          thumb(e, 'fy-card-img'),
          h('span', { class: 'fy-card-title' }, nameOf(e)),
          h('span', { class: 'fy-card-meta' }, `${T.metres(dist(e))} · ${stepFreeText(e.stepFree)}`),
          h('span', { class: 'fy-row-meta fy-card-list' }, icon('favorite', 'fy-ic-heart'), T.favourites),
        ),
      )

    const channels = ctx.profile.channels.length ? ctx.profile.channels.map((c) => T.ch[c]).join(', ') : T.allChannels
    const profileLine = `${T.needStepFree(ctx.profile.stepFreeRequired)}. ${T.channels}: ${channels}.`

    root.replaceChildren(
      h(
        'div',
        { class: 'gm-sheet-head fy-head' },
        h('h2', { id: 'sheet-title', class: 'gm-sheet-title fy-title', tabindex: '-1' }, T.title),
        h('button', { type: 'button', class: 'fy-round', 'aria-label': `${T.profile}: ${profileLine}`, onclick: () => ctx.announce(profileLine) }, icon('accessible')),
      ),
      h(
        'section',
        { class: 'fy-sec', 'aria-labelledby': 'fy-recent' },
        h('h3', { id: 'fy-recent', class: 'fy-h' }, T.recentTitle),
        h('p', { class: 'fy-sub' }, T.recentSub),
        chips,
        searchInput,
        h('ul', { class: 'fy-rows' }, ...rows),
        pool.length > ROWS_COLLAPSED || (state.expanded && missing)
          ? h('button', { type: 'button', class: 'fy-all', 'aria-expanded': String(state.expanded), onclick: () => {
              state.expanded = !state.expanded
              render('.fy-all')
            } }, state.expanded ? T.showLess : T.showAll, icon(state.expanded ? 'expand_less' : 'chevron_right'))
          : null,
      ),
      h(
        'section',
        { class: 'fy-sec', 'aria-labelledby': 'fy-lists' },
        h(
          'div',
          { class: 'fy-lists-head' },
          h('h3', { id: 'fy-lists', class: 'fy-h' }, T.lists),
          h('button', { type: 'button', class: 'fy-new', 'aria-expanded': String(state.creating), onclick: () => {
            state.creating = !state.creating
            render(state.creating ? '.fy-newform-input' : '.fy-new')
          } }, icon('add'), T.newList),
        ),
        newListForm,
        h('ul', { class: 'fy-lists' }, ...allLists.map(listRow)),
      ),
      h(
        'section',
        { class: 'fy-sec', 'aria-labelledby': 'fy-near' },
        h('h3', { id: 'fy-near', class: 'fy-h' }, T.nearby),
        near.length ? h('ul', { class: 'fy-cards' }, ...near.map(card)) : h('p', { class: 'fy-sub' }, T.nearbyNone),
      ),
    )
    const f = focusSel ? root.querySelector<HTMLElement>(focusSel) : null
    f?.focus()
    if (f instanceof HTMLInputElement) f.setSelectionRange(f.value.length, f.value.length)
  }

  render()
  el.replaceChildren(root)
  return () => {
    document.querySelector('.fy-menu')?.remove()
    root.remove()
  }
}
