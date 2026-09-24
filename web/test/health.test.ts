import { describe, expect, it, vi } from 'vitest'
import { bannerText, checkHealth, degradedReason, health, onHealth, parseHealth, unreachable } from '../src/ui/healthBanner'

const ok = (o: Record<string, unknown> = {}) => parseHealth({ ok: true, maps: true, gemini: true, deps: {}, ...o })

const fetchWith = (res: Response | Error) =>
  vi.fn(async () => {
    if (res instanceof Error) throw res
    return res
  }) as unknown as typeof fetch

describe('bannerText', () => {
  it('nothing when everything works', () => {
    expect(bannerText(ok(), 'de')).toBeNull()
  })
  it('names the missing feature, in German by default wording', () => {
    expect(bannerText(ok({ maps: false }), 'de')).toBe('Routen gerade nicht verfügbar')
    expect(bannerText(ok({ gemini: false }), 'de')).toBe('Bildbeschreibung gerade nicht verfügbar')
    expect(bannerText(ok({ maps: false, gemini: false }), 'de')).toBe('Routen und Bildbeschreibung gerade nicht verfügbar')
  })
  it('an unreachable server wins over everything else', () => {
    expect(bannerText(unreachable(), 'de')).toBe('Keine Verbindung zum Server')
  })
  it('has English lines too', () => {
    expect(bannerText(ok({ maps: false }), 'en')).toMatch(/Directions/)
  })
})

describe('parseHealth', () => {
  it('a malformed body is degraded, never fine', () => {
    const h = parseHealth({ ok: true })
    expect(h.maps).toBe(false)
    expect(h.gemini).toBe(false)
    expect(parseHealth(null).reachable).toBe(false)
    expect(parseHealth({ ok: true, maps: 'yes', gemini: 1 }).maps).toBe(false)
  })
  it('keeps the per-dependency detail', () => {
    const h = parseHealth({ ok: true, maps: false, gemini: true, deps: { routes: { key: false, ok: false, lastError: 'upstream 403' } } })
    expect(h.deps.routes.lastError).toBe('upstream 403')
  })
})

describe('checkHealth', () => {
  it('reads /api/health and remembers it', async () => {
    const f = fetchWith(new Response(JSON.stringify({ ok: true, maps: false, gemini: true }), { status: 200 }))
    const seen: boolean[] = []
    const off = onHealth((h) => seen.push(h.maps))
    const h = await checkHealth(f, 'http://x')
    off()
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://x/api/health')
    expect(h.reachable).toBe(true)
    expect(h.maps).toBe(false)
    expect(health()).toBe(h)
    expect(seen).toEqual([false])
    expect(degradedReason('route', h, 'de')).toBe('Routen gerade nicht verfügbar')
    expect(degradedReason('look', h, 'de')).toBeNull()
  })
  it('a network error is unreachable, not a throw', async () => {
    const h = await checkHealth(fetchWith(new TypeError('Failed to fetch')), '')
    expect(h.reachable).toBe(false)
    expect(degradedReason('look', h, 'de')).toBe('Keine Verbindung zum Server')
  })
  it('a proxy error page (backend down behind Vite) is unreachable', async () => {
    const h = await checkHealth(fetchWith(new Response('Bad Gateway', { status: 502 })), '')
    expect(h.reachable).toBe(false)
  })
  it('a listener that throws does not break the check', async () => {
    const off = onHealth(() => {
      throw new Error('boom')
    })
    const h = await checkHealth(fetchWith(new Response(JSON.stringify({ ok: true, maps: true, gemini: true }))), '')
    off()
    expect(bannerText(h, 'de')).toBeNull()
  })
})

describe('degradedReason', () => {
  it('says nothing before the first check', () => {
    expect(degradedReason('route', null)).toBeNull()
  })
})
