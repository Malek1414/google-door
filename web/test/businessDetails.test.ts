import { describe, expect, it } from 'vitest'
import { completeness, emptyDetails, normalizeDetails } from '../src/core/businessDetails'

describe('profile completeness counts only real data', () => {
  it('a fresh business with name, pin and address is 3 of 18', () => {
    const d = { ...emptyDetails(), name: 'Café am Platz', address: 'Platz 1', lat: 52.5, lon: 13.4 }
    expect(completeness(d)).toBe(Math.round((3 / 18) * 100))
  })
  it('default opening hours do not count until the owner set them', () => {
    const d = emptyDetails()
    expect(d.hours.some((x) => x.open)).toBe(true)
    expect(completeness(d)).toBe(0)
    expect(completeness({ ...d, hoursSet: true })).toBe(Math.round((1 / 18) * 100))
  })
  it('hoursSet survives storage round trip', () => {
    expect(normalizeDetails(JSON.parse(JSON.stringify({ ...emptyDetails(), hoursSet: true }))).hoursSet).toBe(true)
    expect(normalizeDetails({}).hoursSet).toBe(false)
  })
})
