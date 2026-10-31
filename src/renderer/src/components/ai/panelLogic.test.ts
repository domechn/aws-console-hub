import { describe, expect, it } from 'vitest'
import { cardDisabledState, liveStatus, regenerationOrdinal, regenerationPreview, resultChange, pendingDecisionCount, restoreQueuedDraft, removeQueuedPreview, mergeQueuedResources, invalidatesHistoryReload } from './panelLogic'
import { draftStore } from './Composer'

describe('panel decisions', () => {
  it('only item events invalidate a pending history reload', () => {
    expect(invalidatesHistoryReload(0, 'usage')).toBe(false)
    expect(invalidatesHistoryReload(0, 'card-state')).toBe(false)
    expect(invalidatesHistoryReload(0, 'queue')).toBe(false)
    expect(invalidatesHistoryReload(1, 'text-delta')).toBe(true)
    expect(invalidatesHistoryReload(0, 'proposal-result')).toBe(true)
    expect(invalidatesHistoryReload(0, 'proposal-state')).toBe(true)
  })
  it('removes only a queued send preview while preserving later stream items', () => {
    const preview = { kind: 'user' as const, text: 'queued' }
    const streamed = { kind: 'assistant' as const, text: 'still running' }
    expect(removeQueuedPreview([preview, streamed], preview)).toEqual([streamed])
  })
  it('restores failed background queue text in its own conversation draft', () => {
    const drafts = draftStore()
    drafts.set('a/current', 'keep')
    expect(restoreQueuedDraft(drafts, 'a/current', 'a/background', 'retry')).toBeNull()
    expect(drafts.get('a/background')).toBe('retry')
    expect(drafts.get('a/current')).toBe('keep')
  })
  it('keeps each failed queued message after existing typing in arrival order', () => {
    const drafts = draftStore()
    drafts.set('a/current', 'draft')
    restoreQueuedDraft(drafts, 'a/current', 'a/current', 'first')
    restoreQueuedDraft(drafts, 'a/current', 'a/current', 'second')
    expect(restoreQueuedDraft(drafts, 'a/current', 'a/current', 'third')).toBe('draft\n\nfirst\n\nsecond\n\nthird')
  })
  it('restores queued resource chips without duplicating existing ones', () => {
    const ref = { type: 'ec2/Instance', id: 'i-1', region: 'us-east-1' }
    expect(mergeQueuedResources([{ ...ref, label: 'server' }], [ref, { ...ref, id: 'i-2' }])).toEqual([
      { ...ref, label: 'server' }, { ...ref, id: 'i-2', label: 'i-2' }
    ])
  })
  it('caps restored chips at five and keeps the known resource label', () => {
    const refs = Array.from({ length: 7 }, (_, i) => ({ type: 'ec2/Instance', id: `i-${i}`, region: 'us-east-1' }))
    expect(mergeQueuedResources([], refs, [{ ...refs[0], label: 'server' }])).toMatchObject([
      { id: 'i-0', label: 'server' }, { id: 'i-1', label: 'i-1' }, { id: 'i-2', label: 'i-2' },
      { id: 'i-3', label: 'i-3' }, { id: 'i-4', label: 'i-4' }
    ])
    expect(mergeQueuedResources([], refs, [{ ...refs[0], label: 'server' }])).toHaveLength(5)
  })
  it('offers batch denial only for two or more pending system decisions', () => {
    expect(pendingDecisionCount([{ kind: 'approval', id: 'a', approval: { state: 'pending', expiresAt: 20 } }] as never, 10)).toBe(1)
    expect(pendingDecisionCount([{ kind: 'approval', id: 'a', approval: { state: 'pending', expiresAt: 20 } }, { kind: 'proposal', id: 'p', proposal: { state: 'pending', expiresAt: 20 } }] as never, 10)).toBe(2)
    expect(pendingDecisionCount([{ kind: 'approval', id: 'a', approval: { state: 'denied', expiresAt: 20 } }] as never, 10)).toBe(0)
    expect(pendingDecisionCount([{ kind: 'approval', id: 'a', approval: { state: 'pending', expiresAt: 10 } }] as never, 10)).toBe(0)
  })
  it('uses only the matching system proposal comparison for an executed result', () => {
    const rows = [{ item: '容量', before: '1', after: '2' }]
    const items = [
      { kind: 'proposal', id: 'tool-call-42', proposal: { id: 'p-1', card: { origin: 'system', blocks: [{ type: 'change', kind: 'modify', summary: '修改', rows }] } } },
      { kind: 'card', id: 'r-p-1', card: { origin: 'system', title: '已执行 · 修改', blocks: [] } }
    ]
    expect(resultChange(items as never, 'r-p-1')).toMatchObject({ type: 'change', rows })
    expect(resultChange(items as never, 'r-p-2')).toBeNull()
    expect(resultChange([{ kind: 'card', id: 'r-p-1', card: { origin: 'model' } }] as never, 'r-p-1')).toBeNull()
  })
  it('previews preserved proposal results before the regenerated question', () => {
    const items = [
      { kind: 'user' as const, text: 'first' },
      { kind: 'proposal' as const, id: 'tool-call-42', proposal: { id: 'p-1' } },
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
