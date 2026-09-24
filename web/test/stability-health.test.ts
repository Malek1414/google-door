// Loop 2 / B: the health snackbar must react to a failing backend within seconds, not
// at the next 60 s poll. data.ts reports every /api answer; the banner re-checks when an
// answer contradicts what it shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchLived, onApiResult } from '../src/data'
import { contradicts, parseHealth, unreachable } from '../src/ui/healthBanner'

const fine = parseHealth({ ok: true, maps: true, gemini: true, deps: {} })

describe('contradicts', () => {
  it('a failure while all looked fine asks for a check', () => {
    expect(contradicts(false, fine)).toBe(true)
  })
  it('a success while the server looked gone asks for a check', () => {
    expect(contradicts(true, unreachable())).toBe(true)
  })
  it('answers that agree with the banner change nothing', () => {
    expect(contradicts(true, fine)).toBe(false)
    expect(contradicts(false, unreachable())).toBe(false)
  })
  it('a degraded but reachable server is not contradicted by a success', () => {
    expect(contradicts(true, parseHealth({ ok: true, maps: false, gemini: true }))).toBe(false)
  })
  it('before the first check only a failure matters', () => {
    expect(contradicts(false, null)).toBe(true)
    expect(contradicts(true, null)).toBe(false)
  })
})

describe('onApiResult', () => {
  // apiBase() reads window.DOORWAY_CONFIG; the node test environment has no window.
  beforeEach(() => vi.stubGlobal('window', { DOORWAY_CONFIG: { apiBase: 'http://x' } }))
  afterEach(() => vi.unstubAllGlobals())

  const run = async (res: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(res))
    const seen: boolean[] = []
    const stop = onApiResult((ok) => seen.push(ok))
    await fetchLived('p1').catch(() => {})
    stop()
    return seen
  }

  it('a 5xx is reported as a failure', async () => {
    expect(await run(async () => new Response('{}', { status: 502 }))).toEqual([false])
  })
  it('a network error is reported as a failure', async () => {
    expect(await run(async () => { throw new TypeError('Failed to fetch') })).toEqual([false])
  })
  it('a 4xx is an answer from a working server', async () => {
    expect(await run(async () => new Response('{}', { status: 404 }))).toEqual([true])
  })
  it('a 200 is reported as fine', async () => {
    expect(await run(async () => new Response('{"claims":[]}', { status: 200 }))).toEqual([true])
  })
  it('a throwing watcher does not break the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"claims":[]}', { status: 200 })))
    const stop = onApiResult(() => { throw new Error('x') })
    await expect(fetchLived('p1')).resolves.toEqual([])
    stop()
  })
  it('unsubscribing stops the reports', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const seen: boolean[] = []
    const stop = onApiResult((ok) => seen.push(ok))
    stop()
    await fetchLived('p1').catch(() => {})
    expect(seen).toEqual([])
  })
})
