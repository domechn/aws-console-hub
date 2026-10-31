import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ApprovalView, ChatItem } from '../../../../shared/ai'
import { applyEvent } from '../../ai'
import { ActivityGroup, groupTools, Step, StepDetail, type ToolItem } from './ActivityGroup'

const code = "const r = await aws('ec2', 'DescribeVpcs', {})\nreturn '<img src=x onerror=alert(1)>'"
const script: ToolItem = { kind: 'tool', id: 't1', label: '运行脚本', status: 'ok', summary: '12 次调用', code, calls: ['s3:ListBuckets', 's3:GetBucketTagging ×11'] }
const tool = (id: string, label: string, status: ToolItem['status'], summary?: string): ToolItem => ({ kind: 'tool', id, label, status, ...(summary ? { summary } : {}) })
const render = (tools: ToolItem[]): string => renderToStaticMarkup(<ActivityGroup tools={tools} />)

describe('groupTools', () => {
  it('folds each run of consecutive tool calls into one group; anything else (text, an approval card, a user turn) ends the run', () => {
    const items: ChatItem[] = [
      { kind: 'user', text: 'q' },
      tool('a', '查询账号身份', 'ok'),
      tool('b', '列出 S3 存储桶', 'ok'),
      { kind: 'approval', id: 'a-000000000001', approval: { id: 'a-000000000001' } as ApprovalView },
      tool('c', '运行脚本', 'ok'),
      { kind: 'assistant', text: 'x' },
      { kind: 'user', text: 'q2' },
      tool('d', '查询 EC2 实例', 'ok')
    ]
    const shape = groupTools(items).map((g) => (Array.isArray(g) ? g.map((t) => t.id).join('+') : g.kind))
    expect(shape).toEqual(['user', 'a+b', 'approval', 'c', 'assistant', 'user', 'd'])
  })
})

describe('ActivityGroup', () => {
  it('shows completed step times and their total, while missing times stay hidden', () => {
    const a = { ...tool('a', '查询 EC2 实例', 'ok'), ms: 400 }
    const b = { ...tool('b', '运行脚本', 'ok'), ms: 4400 }
    expect(render([a, b])).toContain('4.8 秒')
    expect(renderToStaticMarkup(<Step item={a} />)).toContain('0.4 秒')
    expect(render([a, tool('c', '查询指标', 'ok')])).not.toContain('0.4 秒')
  })
  it('collapsed by default: one line 「✓ N 步 · names」, steps hidden', () => {
    const html = render([tool('a', '查询 EC2 实例', 'ok', '4 个'), script, tool('c', '查询指标', 'ok')])
    expect(html).toContain('<b>3 步</b> · 查询 EC2 实例、运行脚本、查询指标')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="成功"')
    expect(html).not.toContain('ai-steps')
    expect(html).not.toContain('DescribeVpcs')
    // The same tool twice is named once.
    expect(render([tool('a', '查询指标', 'ok'), tool('b', '查询指标', 'ok')])).toContain('<b>2 步</b> · 查询指标<')
  })

  it('a failure shows on the collapsed line, in red; all failed gets the failure icon', () => {
    const html = render([tool('a', '查询账号身份', 'ok'), tool('b', '读取桶策略', 'error', 'AccessDenied')])
    expect(html).toContain('<span class="ai-act-fail"> · 1 步失败</span>')
    expect(html).toContain('class="ai-act-icon ok"')
    expect(html).toContain('aria-expanded="false"')
    expect(render([tool('b', '读取桶策略', 'error')])).toContain('class="ai-act-icon error" role="img" aria-label="失败"')
  })

  it('a step waiting for approval shows on the line and opens the group while it waits', () => {
    const html = render([tool('a', '查询 EC2 实例', 'ok'), tool('b', '调用 ssm:DescribeInstanceInformation', 'waiting')])
    expect(html).toContain('<b>2 步</b><span class="ai-act-wait"> · 等待你审批第 2 步</span>')
    expect(html).toContain('class="ai-act-icon waiting" role="img" aria-label="等待审批"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('<ol class="ai-steps">')
    expect(html).toContain('调用 ssm:DescribeInstanceInformation<span class="ai-step-summary"> · 等待你在下面的<span class="ai-keep-word">卡片</span>上审批</span>')
    // Once decided it folds again (the user never opened it by hand).
    expect(render([tool('a', '查询 EC2 实例', 'ok'), tool('b', '调用 ssm:DescribeInstanceInformation', 'ok')])).toContain('aria-expanded="false"')
  })

  it('running: the current step on the line', () => {
    const html = render([tool('a', '查询 EC2 实例', 'ok'), tool('b', '查询 CloudWatch 指标', 'running')])
    expect(html).toContain('正在查询 CloudWatch 指标… · 第 2 步')
    expect(html).toContain('aria-label="进行中"')
    expect(html).toContain('aria-expanded="true"')
  })

  it('run_script step: 「运行脚本 · N 次调用」, opening to the calls and the code (as plain text)', () => {
    const step = renderToStaticMarkup(<Step item={script} />)
    expect(step).toContain('运行脚本<span class="ai-step-summary"> · 12 次调用</span>')
    expect(step).toContain('aria-expanded="false"')
    expect(step).not.toContain('DescribeVpcs')
    const detail = renderToStaticMarkup(<StepDetail item={script} />)
    expect(detail).toContain('<code class="ai-call">s3:ListBuckets</code><code class="ai-call">s3:GetBucketTagging ×11</code>')
    expect(detail).toContain('<pre class="ai-tool-code" tabindex="0" aria-label="脚本代码（只读）">')
    expect(detail).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(detail).not.toContain('<img')
    // Other tools: a plain row, nothing to open.
    const plain = renderToStaticMarkup(<Step item={tool('t2', '查询 EC2 实例', 'ok', '4 个')} />)
    expect(plain).not.toContain('<button')
    expect(plain).toContain('查询 EC2 实例<span class="ai-step-summary"> · 4 个</span>')
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
