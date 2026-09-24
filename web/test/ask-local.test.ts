import { describe, expect, it } from 'vitest'
import { askLocal, readAloudText, UNKNOWN, type AskCtx } from '../src/core/askLocal'

const base = (over: Partial<AskCtx['entrance']> = {}, ctx: Partial<AskCtx> = {}): AskCtx => ({
  entrance: { name: 'Eingang Nord', stepFree: true, door: 'sliding', automatic: true, warnings: [], level: 0, approachBearing: null, description: null, ...over },
  name: 'Eingang Nord',
  distanceM: 42,
  relDeg: 80,
  others: [{ name: 'Eingang Süd', stepFree: true }, { name: 'Lieferzone', stepFree: null }],
  ...ctx,
})
const local = (q: string, c: AskCtx) => {
  const r = askLocal(q, c)
  if (r.kind !== 'local') throw new Error(`expected a local answer for "${q}"`)
  return r.text
}

describe('askLocal', () => {
  it('stufenlos: yes', () => expect(local('Ist der Eingang stufenlos?', base())).toMatch(/^Ja, der Eingang ist stufenlos/))
  it('stufenlos: no', () => expect(local('Ist der Eingang stufenlos?', base({ stepFree: false }))).toMatch(/^Nein/))
  it('stufenlos: null stays unknown, never no', () => {
    const a = local('Ist der Eingang stufenlos?', base({ stepFree: null }))
    expect(a).toMatch(/wissen wir noch nicht/)
    expect(a).not.toMatch(/^Nein|nicht stufenlos/)
  })
  it('gibt es Stufen, null', () => expect(local('Gibt es Stufen?', base({ stepFree: null }))).toMatch(/wissen wir noch nicht/))
  it('steps warning is added when not known false', () => expect(local('Gibt es Treppen?', base({ stepFree: null, warnings: ['steps'] }))).toMatch(/Stufen an diesem Eingang/))
  it('wheelchair in English', () => expect(local('Can I get in with a wheelchair?', base())).toMatch(/stufenlos/))
  it('width is never invented', () => expect(local('Wie breit ist die Tür?', base())).toBe(UNKNOWN))
  it('bell is never invented', () => expect(local('Gibt es eine Klingel?', base())).toBe(UNKNOWN))
  it('automatic door: yes', () => expect(local('Ist das eine automatische Tür?', base())).toMatch(/öffnet automatisch/))
  it('automatic door: not recorded is unknown', () => expect(local('Öffnet die Tür automatisch?', base({ automatic: false }))).toBe(UNKNOWN))
  it('wie weit noch', () => expect(local('Wie weit ist es noch?', base())).toBe('Noch etwa 40 Meter.'))
  it('how far, close', () => expect(local('How far is it?', base({}, { distanceM: 2 }))).toMatch(/fast da/))
  it('distance unknown', () => expect(local('Wie weit noch?', base({}, { distanceM: null }))).toBe(UNKNOWN))
  it('in welche Richtung', () => expect(local('In welche Richtung muss ich?', base())).toBe('Die Tür liegt rechts von dir.'))
  it('direction without compass uses the instruction line', () =>
    expect(local('In welche Richtung?', base({}, { relDeg: null, instruction: 'Links abbiegen · 12 m' }))).toMatch(/Links abbiegen/))
  it('direction without anything is unknown', () => expect(local('Which way?', base({}, { relDeg: null }))).toBe(UNKNOWN))
  it('wo ist die Tür', () => expect(local('Wo ist die Tür?', base({}, { relDeg: -5 }))).toBe('Die Tür liegt geradeaus vor dir. Noch etwa 40 Meter.'))
  it('anderer Eingang', () => expect(local('Gibt es einen anderen Eingang?', base())).toMatch(/2 Eingänge: Eingang Süd, Lieferzone\. Stufenlos: Eingang Süd/))
  it('anderer Eingang, none known', () => expect(local('Gibt es noch einen Eingang?', base({}, { others: [] }))).toMatch(/keinen anderen/))
  it('anderer Eingang, no data', () => expect(local('Gibt es einen anderen Eingang?', base({}, { others: null }))).toBe(UNKNOWN))
  it('wie heißt der Eingang', () => expect(local('Wie heißt der Eingang?', base())).toBe('Der Eingang heißt Eingang Nord.'))
  it('door type', () => expect(local('Was für eine Tür ist das?', base({ door: 'hinged', automatic: false }))).toBe('Es ist eine Drehflügeltür.'))
  it('door unknown', () => expect(local('Was für eine Tür?', base({ door: null, automatic: false }))).toBe(UNKNOWN))
  it('revolving', () => expect(local('Ist das eine Drehtür?', base({ door: 'revolving' }))).toMatch(/Drehtür/))
  it('heavy door unknown', () => expect(local('Ist die Tür schwer?', base())).toBe(UNKNOWN))
  it('surroundings go to the server with a frame', () => expect(askLocal('Was sehe ich?', base())).toEqual({ kind: 'remote', withFrame: true }))
  it('anything else goes to the server without a frame', () => expect(askLocal('Hat das Café heute offen?', base())).toEqual({ kind: 'remote', withFrame: false }))
})

describe('readAloudText', () => {
  it('Live View: instruction, name, distance, door, step-free, warnings, route note', () => {
    const txt = readAloudText(base({ warnings: ['heavy'] }, { instruction: 'Geradeaus · 8 m', routeNote: 'Direkte Linie, keine Route' }), { live: true })
    expect(txt).toBe('Geradeaus, 8 m. Ziel: Eingang Nord. Noch etwa 40 Meter. Es ist eine Schiebetür. Sie öffnet automatisch. Stufenlos. Achtung, schwere Tür. Direkte Linie, keine Route.')
  })
  it('null stepFree is read as unknown, never as not step-free', () => {
    const txt = readAloudText(base({ stepFree: null, door: null, automatic: false }), { live: false })
    expect(txt).toContain('Stufenlos: unbekannt.')
    expect(txt).not.toContain('Nicht stufenlos')
  })
  it('door card skips the instruction and a hidden route note', () => {
    const txt = readAloudText(base({ stepFree: false }, { instruction: 'Geradeaus · 8 m', routeNote: null }), { live: false })
    expect(txt.startsWith('Ziel: Eingang Nord.')).toBe(true)
    expect(txt).toContain('Nicht stufenlos.')
  })
})
