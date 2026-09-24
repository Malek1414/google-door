// Rehearsal: the Live View door warning was drawn under the camera and manoeuvre banner.
// Since the declutter it lives in the status strip under the instruction line.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Live View door warning is above the camera', () => {
  it('sits in the status strip, which is positioned with a z-index above the camera', () => {
    const css = readFileSync(new URL('../src/ui/ar.css', import.meta.url), 'utf8')
    const rule = css.match(/\.ar-status \{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/position:\s*absolute/)
    expect(Number(rule.match(/z-index:\s*(\d+)/)?.[1])).toBeGreaterThanOrEqual(5)
    const ts = readFileSync(new URL('../src/ui/LiveView.ts', import.meta.url), 'utf8')
    expect(ts).toMatch(/h\('div', \{ class: 'ar-status' \}, noRouteEl, warnEl/)
  })
})
