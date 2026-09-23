import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { haversineM } from '../src/core/geo'
import { parseTrack, sampleTrack } from '../src/sim/replay'

const DOOR = { lat: 52.5272097, lon: 13.3711667 } // node/10795939972

describe('track replay', () => {
  it('parses {t, lat, lon, heading}[] and sorts by t', () => {
    const tr = parseTrack([
      { t: 1, lat: 1, lon: 1, heading: 10 },
      { t: 0, lat: 0, lon: 0, heading: null },
      { t: 2, lat: 'x', lon: 0, heading: 0 },
    ])
    expect(tr.map((p) => p.t)).toEqual([0, 1])
    expect(tr[0].heading).toBeNull()
  })
  it('rejects a track with fewer than two points', () => {
    expect(() => parseTrack([{ t: 0, lat: 0, lon: 0, heading: 0 }])).toThrow()
  })
  it('interpolates heading the short way across north', () => {
    const tr = parseTrack([
      { t: 0, lat: 0, lon: 0, heading: 350 },
      { t: 1, lat: 0, lon: 0, heading: 10 },
    ])
    expect(sampleTrack(tr, 0.5).heading).toBeCloseTo(0, 6)
  })
  it('the committed SYNTHETIC track starts ~60 m out and ends at the step-free door', () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, '../public/tracks/hbf-approach-synthetic.json'), 'utf8'))
    const tr = parseTrack(raw)
    expect(haversineM(tr[0], DOOR)).toBeGreaterThan(55)
    expect(haversineM(tr[0], DOOR)).toBeLessThan(65)
    expect(haversineM(tr[tr.length - 1], DOOR)).toBeLessThan(3)
  })
})
