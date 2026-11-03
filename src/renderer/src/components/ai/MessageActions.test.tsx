import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { ChatItem, ProposalView } from '../../../../shared/ai'
import { MessageActions, MessageFailure, editKey, fromUserIndex, isOlder, panelEscapeStops, truncatesChanges, turnActionsAt } from './MessageActions'

it('treats a settled card as older only after a later user turn', () => {
  const items: ChatItem[] = [{ kind: 'user', text: 'one' }, { kind: 'card', id: 'c', card: null }, { kind: 'user', text: 'two' }]
  expect(isOlder(items, 1)).toBe(true)
  expect(isOlder(items, 2)).toBe(false)
})

it('does not offer regenerate for card action turns', () => {
  const items: ChatItem[] = [{ kind: 'user', text: 'card reply', cardAction: true }, { kind: 'assistant', text: 'done' }]
  expect(turnActionsAt(items, 1)).toBeNull()
})

it('places the action bar below a regeneration notice at the end of a turn', () => {
  const items: ChatItem[] = [{ kind: 'user', text: 'one' }, { kind: 'assistant', text: 'answer' }, { kind: 'note', text: 'regenerated' }, { kind: 'user', text: 'two' }]
  expect(turnActionsAt(items, 1)).toBeNull()
  expect(turnActionsAt(items, 2)).toEqual({ userIndex: 0, text: 'answer' })
})

it('maps assistant fragments to their user item index', () => {
  const items: ChatItem[] = [{ kind: 'user', text: 'a' }, { kind: 'assistant', text: 'one' }, { kind: 'user', text: 'b' }, { kind: 'tool', id: 't', label: 'x', status: 'ok' }, { kind: 'assistant', text: 'two' }]
  expect(fromUserIndex(items, 4)).toBe(2)
  expect(fromUserIndex(items, 0)).toBe(0)
})

it('places one action bar after the last card of a turn and copies all assistant prose', () => {
  const items: ChatItem[] = [
    { kind: 'user', text: 'q' },
    { kind: 'assistant', text: 'first' },
    { kind: 'tool', id: 't', label: 'query', status: 'ok' },
    { kind: 'assistant', text: 'second', usage: { input: 20, output: 5 }, model: 'claude' },
    { kind: 'card', id: 'c', card: null },
    { kind: 'user', text: 'next' }
  ]
  expect(turnActionsAt(items, 3)).toBeNull()
  expect(turnActionsAt(items, 4)).toEqual({ userIndex: 0, text: 'first\n\nsecond', usage: { input: 20, output: 5 }, model: 'claude' })
  expect(turnActionsAt(items, 5)).toBeNull()
})

it('warns when truncation would remove a pending or executed change', () => {
  const proposal = (state: ProposalView['state']): ChatItem => ({ kind: 'proposal', id: 'p', proposal: { state } as ProposalView })
  const items: ChatItem[] = [{ kind: 'user', text: 'a' }, proposal('succeeded'), { kind: 'user', text: 'b' }, proposal('pending')]
  expect(truncatesChanges(items, 0)).toBe(true)
  expect(truncatesChanges(items, 2)).toBe(true)
  expect(truncatesChanges([{ kind: 'user', text: 'a' }, proposal('cancelled')], 0)).toBe(false)
  expect(truncatesChanges([{ kind: 'user', text: 'a' }, { kind: 'card', id: 'r-p-0123456789ab', card: null }], 0)).toBe(true)
})

it('assistant actions show supplied metadata and disable regeneration while pending', () => {
  const html = renderToStaticMarkup(<MessageActions kind="assistant" text="**hello**" model="claude" usage={{ input: 1000, output: 50, costUsd: 0.012 }} disabled onRegenerate={() => {}} />)
  expect(html).toContain('复制')
  expect(html).toContain('重新生成')
  expect(html).toContain('disabled=""')
  expect(html).toMatch(/<button type="button">复制<\/button>/)
  expect(html).toContain('claude · 1.1k tokens · ≈$0.01')
  expect(renderToStaticMarkup(<MessageActions kind="assistant" text="hi" onRegenerate={() => {}} />)).not.toContain('tokens')
})

it('assistant feedback is a local toggle with accessible labels', () => {
  const html = renderToStaticMarkup(<MessageActions kind="assistant" text="ok" feedback="up" onFeedback={() => {}} onRegenerate={() => {}} />)
  expect(html).toContain('aria-label="取消赞"')
  expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('只保存在本机')
  expect(html).toContain('aria-label="踩"')
})

it('failed and stopped replies have local retry actions and readable reasons', () => {
  const failed = renderToStaticMarkup(<MessageFailure error={'Bedrock 限流：稍后再试。\n原始错误：ThrottlingException'} diagnosticText="safe diagnostic" onRetry={() => {}} onModel={() => {}} />)
  expect(failed).toContain('复制诊断信息')
  expect(failed).toContain('回答没有完成。')
  expect(failed).toContain('Bedrock 限流')
  expect(failed).toContain('ThrottlingException')
  expect(failed).toContain('重试')
  expect(failed).toContain('已完成的查询会保留')
  expect(renderToStaticMarkup(<MessageFailure aborted onRetry={() => {}} onModel={() => {}} />)).toContain('已停止')
  expect(renderToStaticMarkup(<MessageFailure error="本月 AI 预算已用完" onRetry={() => {}} onModel={() => {}} />)).toContain('本月 AI 预算已用完')
})

it('inline edit uses command enter to submit and escape to cancel', () => {
  expect(editKey('Enter', true, false, false)).toBe('submit')
  expect(editKey('Escape', false, false, false)).toBe('cancel')
  expect(editKey('Enter', false, false, false)).toBe(null)
  expect(editKey('Enter', true, false, true)).toBe(null)
})

it('panel Escape stops only an active turn outside decision cards', () => {
  expect(panelEscapeStops('Escape', true, false, false)).toBe(true)
  expect(panelEscapeStops('Escape', true, false, true)).toBe(false)
  expect(panelEscapeStops('Escape', false, false, false)).toBe(false)
  expect(panelEscapeStops('Escape', true, true, false)).toBe(false)
  expect(panelEscapeStops('Escape', true, false, false, true)).toBe(false)
})
