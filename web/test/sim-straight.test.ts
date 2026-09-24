// ?sim=1 replays a straight-line track; it must not follow a real walking route it never walks.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { replaySensors } from '../src/sim/replay'

describe('?sim=1 follows the straight line to the door (rehearsal)', () => {
  it('the replay sensors say they are a replay', () => {
    const s = replaySensors([{ t: 0, lat: 52.5, lon: 13.4, heading: 0 }, { t: 1, lat: 52.5001, lon: 13.4, heading: 0 }], { speed: 1, imageUrl: 'x.svg', label: 'Sim' })
    expect(s.replay).toBe(true)
  })

  it('Live View asks for no route while replaying', () => {
    const src = readFileSync(new URL('../src/ui/LiveView.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/if \(!routeAsked && opts\.sensors\.replay\) routeAsked = true\s*\n\s*if \(!routeAsked\) \{/)
  })
})
