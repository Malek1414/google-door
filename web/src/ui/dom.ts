// Minimal DOM builder. Text always goes through textContent / text nodes, never innerHTML,
// so data from the dataset or the backend cannot inject markup.

type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>
type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    else if (k === 'class') el.className = String(v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c)
  return el
}

const SVG_NS = 'http://www.w3.org/2000/svg'
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: (SVGElement | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  for (const c of children) el.append(c)
  return el
}

/** Replace the app root with a screen and move focus to its heading for VoiceOver. */
export function mount(screen: HTMLElement): void {
  const root = document.getElementById('app')!
  root.replaceChildren(screen)
  const heading = screen.querySelector<HTMLElement>('h1, h2')
  if (heading) {
    heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  }
}

/** Wheelchair accessibility glyph, drawn in a 32x32 box. Used on the map and in Live View. */
export function glyphPaths(stroke: string): SVGElement[] {
  return [
    s('circle', { cx: 15, cy: 6.5, r: 2.6, fill: stroke }),
    s('path', { d: 'M14.5 10.5 V18 H21 L24 24.5', fill: 'none', stroke, 'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    s('path', { d: 'M14.5 14 H20', fill: 'none', stroke, 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
    s('path', { d: 'M11 14.5 A6.5 6.5 0 1 0 20.5 22.5', fill: 'none', stroke, 'stroke-width': 2.4, 'stroke-linecap': 'round' }),
  ]
}
