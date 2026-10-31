import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ApprovalView, ChatItem } from '../../../../shared/ai'
import { applyEvent } from '../../ai'
import { ToolDetail, ToolRow } from './ToolRow'

const code = "const r = await aws('ec2', 'DescribeVpcs', {})\nreturn '<img src=x onerror=alert(1)>'"
const script: Extract<ChatItem, { kind: 'tool' }> = { kind: 'tool', id: 't1', label: '运行脚本', status: 'ok', summary: '12 次调用', code, calls: ['s3:ListBuckets', 's3:GetBucketTagging ×11'] }

describe('ToolRow (run_script)', () => {
  it('shows 「运行脚本 · N 次调用」 collapsed, and the calls and the code (as plain text) expanded', () => {
    const row = renderToStaticMarkup(<ToolRow item={script} />)
    expect(row).toContain('运行脚本<span class="ai-tool-summary"> · 12 次调用</span>')
    expect(row).toContain('aria-expanded="false"')
    expect(row).not.toContain('DescribeVpcs')
    const detail = renderToStaticMarkup(<ToolDetail item={script} label="运行脚本" />)
    expect(detail).toContain('调用：s3:ListBuckets、s3:GetBucketTagging ×11')
    expect(detail).toContain('<pre class="ai-tool-code" aria-label="脚本代码（只读）">')
    expect(detail).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(detail).not.toContain('<img')
    // Other tools: no code block.
    expect(renderToStaticMarkup(<ToolDetail item={{ kind: 'tool', id: 't2', label: '查询 EC2 实例', status: 'ok' }} label="查询 EC2 实例" />)).not.toContain('<pre')
  })

  it('live events carry the code on start and the calls on end; the row waits while any of its cards is pending', () => {
    let items = applyEvent([], { type: 'tool-start', id: 't1', label: '运行脚本', code })
    expect(items).toEqual([{ kind: 'tool', id: 't1', label: '运行脚本', status: 'running', code }])
    const card = (id: string, state: ApprovalView['state']) => ({ type: 'approval' as const, approval: { id, toolCallId: 't1', state } as ApprovalView })
    items = applyEvent(applyEvent(items, card('a-000000000001', 'pending')), card('a-000000000002', 'pending'))
    items = applyEvent(items, card('a-000000000001', 'allowed'))
    expect(items[0]).toMatchObject({ status: 'waiting' })
    items = applyEvent(items, card('a-000000000002', 'denied'))
    expect(items[0]).toMatchObject({ status: 'running' })
    items = applyEvent(items, { type: 'tool-end', id: 't1', ok: true, summary: '2 次调用', calls: ['sqs:ListQueues ×2'] })
    expect(items[0]).toEqual({ kind: 'tool', id: 't1', label: '运行脚本', status: 'ok', summary: '2 次调用', code, calls: ['sqs:ListQueues ×2'] })
  })
})
