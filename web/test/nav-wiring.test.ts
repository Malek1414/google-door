import { describe, expect, it } from 'vitest'
import { gpsHint, GPS_HINT_MAX_ACCURACY_M } from '../src/ui/Approach'
import { engineName, engine } from '../src/ui/approachPort'
import { startDemoApproach } from '../src/ui/approachDemo'
import { startApproach } from '../src/ui/approachEngine'

const DOOR = { lat: 52.5272097, lon: 13.3711667 }
// About 6 m south of the door.
const SOUTH = { lat: 52.5271557, lng: 13.3711667 }

describe('engine choice: real unless ?approach=demo', () => {
  it('no parameter gives the real engine', () => {
    expect(engine('')).toBe(startApproach)
    expect(engineName(engine(''))).toBe('real')
    expect(engineName(engine('?door=node/10795939972'))).toBe('real')
  })
  it('only ?approach=demo gives the scripted one', () => {
    expect(engineName(engine('?approach=demo'))).toBe('demo')
    expect(engineName(startDemoApproach)).toBe('demo')
  })
})

describe('gpsHint: what the approach says without a direction', () => {
  it('distance only without a compass', () => {
    expect(gpsHint({ ...SOUTH, accuracy: 5 }, DOOR, null)).toMatch(/^Laut GPS etwa 6 Meter\.$|^By GPS about 6 metres\.$/)
  })
  it('a direction word with a compass', () => {
    const facingNorth = gpsHint({ ...SOUTH, accuracy: 5 }, DOOR, 0)
    const facingSouth = gpsHint({ ...SOUTH, accuracy: 5 }, DOOR, 180)
    expect(facingNorth).not.toBe(facingSouth)
    expect(facingNorth).toMatch(/, /)
  })
  it('nothing with poor or missing GPS', () => {
    expect(gpsHint({ ...SOUTH, accuracy: GPS_HINT_MAX_ACCURACY_M + 1 }, DOOR, 0)).toBeNull()
    expect(gpsHint({ ...SOUTH, accuracy: Number.NaN }, DOOR, 0)).toBeNull()
    expect(gpsHint(null, DOOR, 0)).toBeNull()
  })
})
