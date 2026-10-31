import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Block, Card } from '../../../../shared/cards'
import { CardView, tableTsv } from './CardView'

const card = (patch: Partial<Card>): Card => ({
  v: 1,
  id: 'c-0123456789ab',
  origin: 'model',
  blocks: [{ type: 'markdown', text: 'x' }],
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  state: 'active',
  ...patch
})
const render = (c: Card): string => renderToStaticMarkup(<CardView card={c} onAction={async () => ({ ok: true })} onLink={() => {}} accountColor="#123456" />)

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i-${i}`, cells: { name: `web-${i}` }, actions: ['detail'] }))
const table = (n: number): Block => ({ type: 'table', columns: [{ key: 'name', label: '名称' }], rows: rows(n) })

describe('CardView', () => {
  it('shows cell, kv and badge text as plain text, never as HTML', () => {
    const html = render(
      card({
        title: '<b>t</b>',
        blocks: [
          { type: 'table', columns: [{ key: 'a', label: '<i>A</i>' }], rows: [{ id: 'r', cells: { a: '<img src=x onerror=alert(1)>' } }] },
          { type: 'kv', items: [{ label: 'k', value: '<script>alert(1)</script>' }] },
          { type: 'badges', items: [{ text: '<u>ok</u>', tone: 'ok' }] }
        ]
      })
    )
    expect(html).not.toMatch(/<img|<script|<b>|<i>|<u>/)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('does not draw system-only blocks on a model card, and draws them (with the lock) on a system card', () => {
    const blocks: Block[] = [
      { type: 'risk', level: 'high', reasons: ['对公网开放 22 端口'] },
      { type: 'diff', lines: [{ path: 'State', op: 'change', before: 'running', after: 'stopped' }] },
      { type: 'error', message: 'UnauthorizedOperation' }
    ]
    const model = render(card({ blocks }))
    expect(model).not.toMatch(/对公网|State|UnauthorizedOperation|🔒/)
    const system = render(card({ origin: 'system', title: '停止 1 台实例', blocks }))
    expect(system).toContain('对公网开放 22 端口')
    expect(system).toContain('running')
    expect(system).toContain('UnauthorizedOperation')
    expect(system).toContain('🔒')
    expect(system).toContain('border-left-color:#123456')
  })

  it('analysis blocks (card v3): skeleton with the query count, the failure notice, and a done analysis labelled as AI, facts with evidence, inferences, uncertainties, plain text', () => {
    const system = (b: Block): string => render(card({ v: 3, origin: 'system', blocks: [b] }))
    expect(system({ type: 'analysis', status: 'running', calls: 3 })).toContain('正在分析影响…（用到的查询：3）')
    expect(system({ type: 'analysis', status: 'failed', calls: 1, error: '超过 90 秒' })).toContain('未能完成影响分析：超过 90 秒，请自行核对参数')
    const done = system({
      type: 'analysis',
      status: 'done',
      calls: 2,
      raised: { from: 'high', to: 'destructive' },
      result: {
        summary: '<b>新策略</b>授权给任何主体',
        changes: [{ label: '主体', before: 'AWS:…:root', after: '*' }],
        impact: [
          { kind: 'fact', text: '当前策略只授权本账号', evidence: { source: 's3:GetBucketPolicy', excerpt: 'Principal.AWS = …:root' } },
          { kind: 'inference', text: '<img src=x onerror=alert(1)>任何人可读对象' }
        ],
        exposure: { level: 'unknown', who: [] },
        reversibility: { level: 'reversible', how: '恢复原策略' },
        risk: { level: 'destructive', reasons: ['Principal * 且没有 Condition'] },
        uncertainties: ['没有读取 ACL'],
        confidence: 'medium'
      }
    })
    expect(done).toContain('AI 分析（可能有误，请核对）')
    expect(done).toContain('风险已由「高」提高到「破坏性」：Principal * 且没有 Condition')
    expect(done).toContain('事实（1 条，展开看依据）')
    expect(done).toContain('依据：s3:GetBucketPolicy')
    expect(done).toContain('Principal.AWS = …:root')
    expect(done).toContain('推断</span>')
    expect(done).toContain('没有读取 ACL')
    expect(done).toContain('<th scope="col">会改变什么</th>')
    expect(done).not.toMatch(/<img|<b>/)
    expect(done).toContain('&lt;b&gt;新策略&lt;/b&gt;')
    // A model card never draws one.
    expect(render(card({ blocks: [{ type: 'analysis', status: 'done', calls: 0 }] }))).not.toContain('ai-analysis')
  })

  it('change blocks (card v2) read as text, not a diff: fields, a 项目 / 当前 / 改为 table, state chips, removals with what stays', () => {
    const system = (b: Block): string => render(card({ v: 2, origin: 'system', blocks: [b] }))
    const create = system({
      type: 'change',
      kind: 'create',
      summary: '在 internal-tools · ap-northeast-1 创建 1 台 t4g.small',
      fields: [
        { label: '实例类型', value: 't4g.small（2 vCPU · 2 GiB 内存）' },
        { label: '预估月费', value: '约 $12.26/月', note: '按需参考价' },
        { label: '标签', value: 'x'.repeat(300) }
      ]
    })
    expect(create).toContain('在 internal-tools · ap-northeast-1 创建 1 台 t4g.small')
    expect(create).toContain('<dt>实例类型</dt>')
    expect(create).toContain('按需参考价')
    // Long values are cut with 展开.
    expect(create).toContain('展开')
    expect(create).not.toContain('x'.repeat(300))

    const modify = system({
      type: 'change',
      kind: 'modify',
      summary: '修改',
      rows: [
        { target: 'i-1', item: '标签 env', before: 'dev', after: 'prod' },
        { target: 'i-1', item: '标签 team', before: '无', after: 'a' },
        { target: 'i-2', item: '标签 env', before: 'dev', after: '（删除）' }
      ]
    })
    expect(modify).toMatch(/<th scope="col">项目<\/th><th scope="col">当前<\/th><th scope="col">改为<\/th>/)
    expect(modify.match(/class="ai-change-target"/g)).toHaveLength(2)
    expect(modify).toContain('<td class="after">prod</td>')
    expect(modify).not.toMatch(/ai-diff|>[+−~]</)
    expect(system({ type: 'change', kind: 'modify', summary: 's', rows: [{ item: 'a', before: '1', after: '2' }], heads: { before: '提案时', after: '确认时' } })).toContain('<th scope="col">确认时</th>')

    const state = system({ type: 'change', kind: 'state', summary: 's', states: [{ name: 'web-1（i-0abc）', from: '运行中', to: '已停止' }] })
    expect(state).toMatch(/web-1（i-0abc）<\/span><span class="ai-chip">运行中<\/span>.*已停止/)

    const del = system({ type: 'change', kind: 'delete', summary: 's', removed: [{ name: 'web-1（i-0abc）', detail: 't3.large · 运行中' }], kept: ['卷 vol-1 会保留并继续计费'] })
    expect(del).toContain('删除后无法恢复')
    expect(del).toContain('会保留：')
    expect(del).toContain('卷 vol-1 会保留并继续计费')

    const request = system({ type: 'change', kind: 'request', summary: '在 x · y 发送通用请求 sns:Publish', fields: [], raw: '{}' })
    expect(request).toContain('<dt>参数</dt><dd class="ai-dim">无参数</dd>')
    expect(request).toContain('原始 JSON（实际发送的内容）')
    // Never on a model card.
    expect(render(card({ blocks: [{ type: 'change', kind: 'state', summary: 'MODEL-SAYS', states: [] }] }))).not.toContain('MODEL-SAYS')
  })

  it('pages tables over 20 rows and offers TSV copy', () => {
    const html = render(card({ blocks: [table(45)], actions: [{ id: 'detail', label: '详情', kind: 'reply' }] }))
    expect(html.match(/<tr>/g)).toHaveLength(21) // header + 20
    expect(html).toContain('1 / 3')
    expect(html).toContain('复制为 TSV')
    expect(html).toContain('aria-label="详情：i-0"')
    // The action column has a visible header of its own.
    expect(html).toContain('<th scope="col" class="ai-row-actions">操作</th>')
    expect(html).toContain('<td class="ai-row-actions"><span class="ai-row-actions-inner">')
    expect(tableTsv({ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ id: 'r', cells: { a: 'x\ty\nz' } }] })).toBe('A\nx y z')
  })

  it('greys a handled card: state note, buttons disabled (copy still works)', () => {
    const actions = [
      { id: 'more', label: '更多', kind: 'reply' as const },
      { id: 'cp', label: '复制 id', kind: 'copy' as const, text: 'i-1' }
    ]
    for (const [state, note] of [
      ['resolved', '已处理'],
      ['expired', '已过期'],
      ['superseded', '已被新卡片替代']
    ] as const) {
      const html = render(card({ state, actions }))
      expect(html).toContain(note)
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>更多/)
      expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>复制 id/)
    }
    // A card that ran out while on screen shows expired even before main says so.
    expect(render(card({ expiresAt: Date.now() - 1, actions }))).toContain('已过期')
    expect(render(card({ actions }))).not.toMatch(/disabled/)
  })

  it('renders a form with labels and its submit button; disabled once handled', () => {
    const form: Block = {
      type: 'form',
      submitActionId: 'go',
      fields: [
        { type: 'text', name: 'name', label: '名称', required: true },
        { type: 'select', name: 'type', label: '类型', options: [{ value: 't3.micro', label: 't3.micro' }] },
        { type: 'checkbox', name: 'ip', label: '公网 IP' }
      ]
    }
    const actions = [{ id: 'go', label: '提交', kind: 'reply' as const, style: 'primary' as const }]
    const html = render(card({ blocks: [form], actions }))
    expect(html).toMatch(/<label for="[^"]+-name">名称/)
    expect(html).toContain('>提交</button>')
    expect(render(card({ blocks: [form], actions, state: 'resolved' }))).toMatch(/<fieldset disabled="">/)
  })

  it('links console-link blocks only to console pages', () => {
    const html = render(
      card({
        blocks: [
          { type: 'console-link', label: '账单', url: 'https://us-east-1.console.aws.amazon.com/billing/home' },
          { type: 'console-link', label: '外站', url: 'https://evil.example/' }
        ]
      })
    )
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).not.toContain('evil.example')
  })
})
