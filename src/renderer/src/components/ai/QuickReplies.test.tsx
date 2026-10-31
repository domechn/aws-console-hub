import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalView, ChatItem, ProposalView } from '../../../../shared/ai'
import type { Card } from '../../../../shared/cards'
import { applyEvent, visibleReplies } from '../../ai'
import { QuickReplies } from './QuickReplies'

const STOP = [
  { label: '停止', text: '停止' },
  { label: '终止', text: '终止这台实例' }
]
const asked: ChatItem[] = [
  { kind: 'user', text: '怎么处理' },
  { kind: 'assistant', text: '回复「停止」或「终止」' },
  { kind: 'replies', id: 'r1', options: STOP }
]
const card = (origin: 'model' | 'system'): Card => ({ v: 1, id: 'c-0123456789ab', origin, blocks: [{ type: 'markdown', text: 'x' }], createdAt: 0, expiresAt: 1, state: 'active' })

describe('visibleReplies', () => {
  it('shows the chips of the last reply while nothing but its text came after', () => {
    expect(visibleReplies(asked)?.options).toEqual(STOP)
    expect(visibleReplies([...asked, { kind: 'assistant', text: '（补一句）' }])?.id).toBe('r1')
  })

  it('hides them once anything else comes: a user message, a tool call, a card, an approval', () => {
    expect(visibleReplies([...asked, { kind: 'user', text: '停止' }])).toBeNull()
    expect(visibleReplies([...asked, { kind: 'tool', id: 't', label: 'x', status: 'running' }])).toBeNull()
    expect(visibleReplies([...asked, { kind: 'card', id: 't', card: null }])).toBeNull()
    expect(visibleReplies([])).toBeNull()
  })

  it('never next to something answered on its own buttons: a pending approval or proposal anywhere, or a model card this turn', () => {
    const approval = { id: 'a-0123456789ab', state: 'pending', expiresAt: Date.now() + 60_000 } as ApprovalView
    const proposal = { id: 'p-0123456789ab', state: 'pending', expiresAt: Date.now() + 60_000 } as ProposalView
    expect(visibleReplies([{ kind: 'approval', id: approval.id, approval }, ...asked])).toBeNull()
    expect(visibleReplies([{ kind: 'proposal', id: 'x', proposal }, ...asked])).toBeNull()
    expect(visibleReplies([asked[0], { kind: 'card', id: 'k', card: card('model') }, ...asked.slice(1)])).toBeNull()
    // A result card (main's record of an outcome) does not count; a decided proposal neither.
    expect(visibleReplies([asked[0], { kind: 'proposal', id: 'x', proposal: { ...proposal, state: 'succeeded' } }, { kind: 'card', id: 'r-x', card: card('system') }, ...asked.slice(1)])?.id).toBe('r1')
  })

  it('applyEvent keeps one chip set: the newest', () => {
    let items = applyEvent(asked, { type: 'replies', id: 'r2', options: [{ label: '好', text: '好' }] })
    expect(items.filter((i) => i.kind === 'replies')).toEqual([{ kind: 'replies', id: 'r2', options: [{ label: '好', text: '好' }] }])
    items = applyEvent(items, { type: 'tool-start', id: 't', label: 'x' })
    expect(visibleReplies(items)).toBeNull()
  })
})

describe('QuickReplies', () => {
  it('a 「接下来」 list of keyboard-reachable buttons that sends nothing by itself', () => {
    const onSend = vi.fn()
    const html = renderToStaticMarkup(<QuickReplies options={[{ label: '看 CPU 曲线', text: '看 worker-1 的 CPU 曲线' }, ...STOP]} onSend={onSend} />)
    expect(html).toContain('role="group" aria-label="快捷回复"')
    expect(html).toContain('>接下来</div>')
    expect(html.match(/<button type="button"/g)).toHaveLength(3)
    expect(html).toMatch(/class="ai-reply" title="看 worker-1 的 CPU 曲线"><svg[^]*?<\/svg><span>看 CPU 曲线<\/span><\/button>/)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('replies that read like a change get the amber warn style and icon (and nothing else changes)', () => {
    const warn = ['停止', '终止这台实例', 'Delete the bucket', '清空', '重启 web-1', '修改超时', '撤销授权', 'Reboot it']
    const plain = ['查看详情', '列出实例', 'Show the logs']
    const html = renderToStaticMarkup(<QuickReplies options={[...warn, ...plain].map((text, i) => ({ label: `选项${i}`, text }))} onSend={() => {}} />)
    for (const t of warn) expect(html).toContain(`class="ai-reply warn" title="${t}"`)
    for (const t of plain) expect(html).toContain(`class="ai-reply" title="${t}"`)
    // Not by colour alone: a warning triangle instead of the arrow.
    expect(html.match(/M12 4 21 19.5H3z/g)).toHaveLength(warn.length)
  })

  it('a click hands the reply text to the composer send, exactly as typed', () => {
    const onSend = vi.fn()
    const buttons = (QuickReplies({ options: STOP, onSend }).props.children as [unknown, ReactElement<{ onClick: () => void }>[]])[1]
    buttons[1].props.onClick()
    expect(onSend).toHaveBeenCalledExactlyOnceWith('终止这台实例')
  })
})
