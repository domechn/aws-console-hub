import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ConversationSummary } from '../../../../shared/ai'
import { ConversationPopover, conversationKey, groupConversations } from './ConversationPopover'

const day = 86_400_000
const now = new Date(2026, 9, 31, 12).getTime()
const row = (id: string, days: number): ConversationSummary => ({ id, title: id, updatedAt: now - days * day })

describe('groupConversations', () => {
  it('places days at local calendar boundaries and sorts newest first', () => {
    const groups = groupConversations([row('week', 6), row('today', 0), row('month', 18), row('yesterday', 1), row('old', 60), row('early', 0)], now)
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['今天', ['today', 'early']],
      ['昨天', ['yesterday']],
      ['最近 7 天', ['week']],
      ['最近 30 天', ['month']],
      ['2026年9月', ['old']]
    ])
  })
})

describe('ConversationPopover', () => {
  it('navigates 23 results with arrows, enter, escape and confirmed delete shortcut', () => {
    expect(conversationKey('ArrowDown', 0, 23, false)).toEqual({ index: 1 })
    expect(conversationKey('ArrowUp', 0, 23, false)).toEqual({ index: 0 })
    expect(conversationKey('ArrowDown', 22, 23, false)).toEqual({ index: 22 })
    expect(conversationKey('Enter', 7, 23, false)).toEqual({ open: 7 })
    expect(conversationKey('Escape', 7, 23, false)).toEqual({ close: true })
    expect(conversationKey('Backspace', 7, 23, true)).toEqual({ delete: 7 })
  })
  it('shows title search, grouped rows, current check, count and actions', () => {
    const html = renderToStaticMarkup(
      <ConversationPopover
        conversations={[row('today', 0), row('yesterday', 1)]}
        currentId="today"
        running={new Set(['yesterday'])}
        open
        onClose={() => {}}
        onOpen={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onClear={() => {}}
      />
    )
    expect(html).toContain('搜索对话标题')
    expect(html).toContain('今天')
    expect(html).toContain('昨天')
    expect(html).toContain('当前对话')
    expect(html).toContain('正在运行')
    expect(html).toContain('匹配 2 / 2 个对话')
    expect(html).toContain('删除对话')
  })
})
