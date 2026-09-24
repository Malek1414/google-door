import { describe, expect, it } from 'vitest'
import { keepScreenOn, session } from '../src/session'

const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function fakes() {
  const log: string[] = []
  const nav = {
    wakeLock: {
      request: async (type: 'screen') => {
        log.push(`request:${type}`)
        return { release: async () => void log.push('release') }
      },
    },
  }
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as unknown as Document & { visibilityState: string }
  return { log, nav, doc }
}

describe('keepScreenOn: the approach screen does not lock under the user', () => {
  it('takes a screen lock at once and releases it on exit', async () => {
    const { log, nav, doc } = fakes()
    const release = keepScreenOn(nav, doc)
    await tick()
    expect(log).toEqual(['request:screen'])
    release()
    await tick()
    expect(log).toEqual(['request:screen', 'release'])
  })
  it('re-acquires after the page was hidden and resumes audio', async () => {
    const { log, nav, doc } = fakes()
    let resumed = 0
    session.audio = { state: 'suspended', resume: async () => void resumed++ } as unknown as AudioContext
    const release = keepScreenOn(nav, doc)
    await tick()
    ;(doc as { visibilityState: string }).visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    ;(doc as { visibilityState: string }).visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    await tick()
    expect(log.filter((l) => l === 'request:screen')).toHaveLength(2)
    expect(resumed).toBe(1)
    release()
    session.audio = null
  })
  it('no Wake Lock API: no lock, no throw', () => {
    const { doc } = fakes()
    expect(() => keepScreenOn({}, doc)()).not.toThrow()
  })
})
