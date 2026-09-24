import { describe, expect, it } from 'vitest'
import { doorName } from '../src/ui/doorName'
import type { Building, Entrance } from '../src/core/types'

const door = (over: Partial<Entrance>): Entrance => ({
  id: 'd', buildingId: null, lat: 52.5, lon: 13.4, name: null, kind: 'yes', level: 0, stepFree: null, tier: 0,
  confidence: 'mapped', door: null, automatic: false, approachBearing: null, description: null, warnings: [], source: 'osm', ...over,
} as Entrance)
const me = { lat: 52.5, lon: 13.4 }

describe('unnamed doors get a name that tells them apart (a11y #8)', () => {
  it('keeps a real name', () => expect(doorName(door({ name: ' Nordeingang ' }), me)).toBe('Nordeingang'))
  it('says kind and direction from the user', () => {
    expect(doorName(door({ lat: 52.501 }), me)).toBe('Entrance to the north')
    expect(doorName(door({ lon: 13.401, kind: 'main' }), me)).toBe('Main entrance to the east')
  })
  it('two unnamed doors in different directions differ', () => {
    expect(doorName(door({ lat: 52.499 }), me)).not.toBe(doorName(door({ lon: 13.399 }), me))
  })
  it('uses the building and its side when known', () => {
    const b: Building = { id: 'b1', name: 'Hauptbahnhof', placeId: null, addr: null, centroid: [52.5, 13.4], accessSummary: { tier: 0, stepFree: null, confidence: 'mapped' } as Building['accessSummary'], entranceIds: [], stats: { total: 1, stepFree: 0, notStepFree: 0, unknown: 1 } }
    expect(doorName(door({ buildingId: 'b1', lat: 52.4995 }), me, [b])).toBe('Entrance, south side, Hauptbahnhof')
  })
})
