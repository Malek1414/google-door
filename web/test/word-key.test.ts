import { describe, expect, it } from 'vitest'
import { wordKey } from '../src/ui/LiveView'
import { t } from '../src/strings'

describe('wordKey', () => {
  it('picks the clip from the word on screen, not from the raw bearing', () => {
    expect(wordKey(t.ahead)).toBe('straight')
    expect(wordKey(t.turnLeft)).toBe('turn_left')
    expect(wordKey(t.turnRight)).toBe('turn_right')
    expect(wordKey(t.behind)).toBeUndefined()
  })
})
