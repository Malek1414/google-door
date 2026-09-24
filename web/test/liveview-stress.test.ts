// Live View rules that decide what a blind user is told under bad GPS.
import { describe, expect, it } from 'vitest'
import { t } from '../src/strings'
import { ARRIVE_MAX_ACCURACY_M, arrivalTrusted, LEAVE_M, openingLine, walkedAway } from '../src/ui/LiveView'

describe('Live View under bad GPS', () => {
  it('a 60 m fix never announces arrival; 5 m and unknown accuracy do', () => {
    expect(arrivalTrusted(60)).toBe(false)
    expect(arrivalTrusted(ARRIVE_MAX_ACCURACY_M + 1)).toBe(false)
    expect(arrivalTrusted(5)).toBe(true)
    expect(arrivalTrusted(null)).toBe(true)
  })

  it('a jumpy 60 m fix does not take the arrival card away; really walking off does', () => {
    expect(walkedAway(20, 60)).toBe(false) // standing at the door, GPS drifted 20 m
    expect(walkedAway(LEAVE_M + 1, 5)).toBe(true)
    expect(walkedAway(LEAVE_M - 1, 5)).toBe(false)
    expect(walkedAway(65, 60)).toBe(true)
  })

  it('the first thing Live View says is the safety line, then the destination', () => {
    const line = openingLine('Hauptbahnhof')
    expect(line.startsWith(t.arSafeSub!)).toBe(true)
    expect(line.endsWith(t.guidingTo('Hauptbahnhof'))).toBe(true)
  })
})
