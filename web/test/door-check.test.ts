import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkDoor,
  parseDoorCheckResult,
  runDoorCheckOnce,
  UNKNOWN_RESULT,
  verdictNote,
  verdictRows,
  type DoorCheckResult,
} from '../src/ui/doorCheck'

const res = (o: Partial<DoorCheckResult> = {}): DoorCheckResult => ({
  step: false, widthCm: 90, opens: 'automatic', note: '', confidence: 0.9, reachable: true, ...o,
})
const values = (r: DoorCheckResult) => verdictRows(r, 'de').map((x) => x.value)

describe('verdictRows: Stufe / Breite / Öffnet', () => {
  it('labels and a confident verdict', () => {
    const rows = verdictRows(res(), 'de')
    expect(rows.map((r) => r.label)).toEqual(['Stufe', 'Breite', 'Öffnet'])
    expect(rows.map((r) => r.value)).toEqual(['nein', 'ca. 90 cm', 'automatisch'])
    expect(values(res({ step: true }))[0]).toBe('ja')
  })
  it('maps every OPENS value', () => {
    const opens = (o: DoorCheckResult['opens']) => values(res({ opens: o }))[2]
    expect(opens('automatic')).toBe('automatisch')
    expect(opens('push')).toBe('drücken')
    expect(opens('pull')).toBe('ziehen')
    expect(opens('revolving')).toBe('Drehtür')
    expect(opens('none')).toBe('keine Tür')
    expect(opens('unknown')).toBe('unklar')
  })
  it('nulls are unklar, row by row', () => {
    const rows = verdictRows(res({ step: null, widthCm: null }), 'de')
    expect(rows.map((r) => r.value)).toEqual(['unklar', 'unklar', 'automatisch'])
    expect(rows.map((r) => r.unclear)).toEqual([true, true, false])
  })
  it('low confidence blanks every row and the note', () => {
    const r = res({ confidence: 0.49, note: 'Glastür, ebenerdig' })
    expect(values(r)).toEqual(['unklar', 'unklar', 'unklar'])
    expect(verdictNote(r)).toBe('')
  })
  it('rounds width to 5 cm', () => {
    expect(values(res({ widthCm: 88 }))[1]).toBe('ca. 90 cm')
  })
  it('shows the note only when present', () => {
    expect(verdictNote(res({ note: 'Glastür links' }))).toBe('Glastür links')
    expect(verdictNote(res({ note: '' }))).toBe('')
  })
  it('english labels', () => {
    expect(verdictRows(UNKNOWN_RESULT, 'en').map((r) => r.value)).toEqual(['unclear', 'unclear', 'unclear'])
  })
})

describe('parseDoorCheckResult', () => {
  it('garbage and error bodies are all-unknown', () => {
    expect(values(parseDoorCheckResult(null))).toEqual(['unklar', 'unklar', 'unklar'])
    expect(values(parseDoorCheckResult({ detail: 'Not Found' }))).toEqual(['unklar', 'unklar', 'unklar'])
  })
  it('keeps the real server shape', () => {
    const r = parseDoorCheckResult({ step: false, widthCm: 95, opens: 'pull', note: 'Holztür', confidence: 0.8 })
    expect(r).toEqual({ step: false, widthCm: 95, opens: 'pull', note: 'Holztür', confidence: 0.8, reachable: true })
  })
  it('foreign opens and non-boolean step become unknown', () => {
    const r = parseDoorCheckResult({ step: 'no', widthCm: 90, opens: 'magic', confidence: 0.9 })
    expect(r.step).toBeNull()
    expect(r.opens).toBe('unknown')
  })
})

describe('checkDoor: never throws', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('window', { DOORWAY_CONFIG: { apiBase: 'https://api.test/' } })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('posts the FrameReq body to /api/door-check', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ step: true, widthCm: 80, opens: 'push', note: '', confidence: 0.7 }) })
    const r = await checkDoor('abc')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/api/door-check')
    expect(JSON.parse(init.body)).toEqual({ frame: 'abc', headingDeg: 0 })
    expect(values(r)).toEqual(['ja', 'ca. 80 cm', 'drücken'])
  })
  it.each([404, 503])('%i is all-unklar and unreachable', async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ detail: 'x' }) })
    const r = await checkDoor('abc')
    expect(r.reachable).toBe(false)
    expect(values(r)).toEqual(['unklar', 'unklar', 'unklar'])
  })
  it('network error is all-unklar', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(values(await checkDoor('abc'))).toEqual(['unklar', 'unklar', 'unklar'])
  })
  it('no frame means no request', async () => {
    expect((await checkDoor(null)).reachable).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('one call per screen', () => {
  it('runDoorCheckOnce asks exactly once, even when unsure', async () => {
    const check = vi.fn(async () => UNKNOWN_RESULT)
    await runDoorCheckOnce(Promise.resolve('frame'), check)
    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledWith('frame')
  })
  it('DoorCheckScreen goes through runDoorCheckOnce once and has no loop', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/Approach.ts'), 'utf8')
    const screen = src.slice(src.indexOf('function DoorCheckScreen'))
    expect(screen.match(/runDoorCheckOnce\(/g)).toHaveLength(1)
    expect(screen).not.toMatch(/setInterval|requestAnimationFrame|postDoorCheck|while\s*\(/)
  })
})
