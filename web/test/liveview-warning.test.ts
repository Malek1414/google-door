// Rehearsal: the Live View door warning was drawn under the camera and manoeuvre banner.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Live View door warning is above the camera', () => {
  it('is positioned with a z-index, like the manoeuvre banner', () => {
    const css = readFileSync(new URL('../src/ui/fix-live.css', import.meta.url), 'utf8')
    const rule = css.match(/\.ar > \.warning \{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/position:\s*absolute/)
    expect(Number(rule.match(/z-index:\s*(\d+)/)?.[1])).toBeGreaterThanOrEqual(6)
  })
})
