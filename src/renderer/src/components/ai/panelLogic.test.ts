import { describe, expect, it } from 'vitest'
import { cardDisabledState, liveStatus, regenerationOrdinal, regenerationPreview } from './panelLogic'

describe('panel decisions', () => {
  it('previews preserved proposal results before the regenerated question', () => {
    const items = [
      { kind: 'user' as const, text: 'first' },
      { kind: 'proposal' as const, id: 'p-1', proposal: { id: 'p-1' } },
      { kind: 'user' as const, text: 'second' },
      { kind: 'assistant' as const, text: 'old answer' },
      { kind: 'card' as const, id: 'r-p-1', card: { origin: 'system' as const } }
    ]
    expect(regenerationPreview(items as never, 2, 'second')).toEqual([
      items[0], items[1], items[4], items[2]
    ])
  })
  it('keeps approval, proposal, and card actions available during a pending run', () => {
    expect(cardDisabledState(true, true, false)).toEqual({ message: true, card: false })
    expect(cardDisabledState(false, true, false)).toEqual({ message: true, card: false })
    expect(cardDisabledState(true, false, false)).toEqual({ message: true, card: false })
    expect(cardDisabledState(false, false, true)).toEqual({ message: true, card: true })
  })

  it('requires a stored user ordinal to regenerate', () => {
    expect(regenerationOrdinal({ kind: 'user', text: 'saved', ordinal: 2 })).toBe(2)
    expect(regenerationOrdinal({ kind: 'user', text: 'optimistic' })).toBeNull()
  })

  it('announces the current state rather than an old successful result', () => {
    expect(liveStatus('等待审批', true, false)).toBe('等待审批')
    expect(liveStatus(null, true, false)).toBe('正在回答')
    expect(liveStatus(null, false, false)).toBe('回答完成')
    expect(liveStatus(null, false, true)).toBe('提案执行成功')
  })
})
