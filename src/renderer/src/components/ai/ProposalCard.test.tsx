import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProposalView } from '../../../../shared/ai'
import { ProposalCard } from './ProposalCard'

const view = (patch: Partial<ProposalView> = {}): ProposalView => ({
  id: 'p-0123456789ab',
  state: 'pending',
  title: '终止 1 台 EC2 实例',
  risk: 'destructive',
  accountName: 'Prod',
  awsAccountId: '123456789012',
  region: 'ap-northeast-1',
  production: true,
  createdAt: Date.now(),
  expiresAt: Date.now() + 600_000,
  confirmText: 'i-0abc',
  card: {
    v: 1,
    id: 'c-0123456789ab',
    origin: 'system',
    title: '终止 1 台 EC2 实例',
    blocks: [
      { type: 'risk', level: 'destructive', reasons: ['<b>终止</b>'] },
      { type: 'diff', lines: [{ path: 'i-0abc', op: 'remove', before: 't3.large' }] }
    ],
    createdAt: 0,
    expiresAt: 1,
    state: 'active'
  },
  ...patch
})
const render = (p: ProposalView): string =>
  renderToStaticMarkup(<ProposalCard proposal={p} accountColor="#123456" onLink={() => {}} onConfirm={async () => ({ ok: true })} onCancel={async () => ({ ok: true })} />)

describe('ProposalCard', () => {
  it('shows risk, account, region, production, the system card and the first step only', () => {
    const html = render(view())
    expect(html).toContain('破坏性')
    expect(html).toContain('会修改资源')
    expect(html).toContain('Prod · 123456789012')
    expect(html).toContain('ap-northeast-1')
    expect(html).toContain('生产')
    expect(html).toContain('ai-card active system')
    expect(html).toContain('🔒')
    expect(html).toContain('&lt;b&gt;终止&lt;/b&gt;')
    expect(html).toContain('确认执行…')
    expect(html).toContain('取消')
    // The final step (and its typed input) only opens after the first click.
    expect(html).not.toContain('我确认，立即执行')
    expect(html).toContain('⏱ 10:00')
    // The system card's own expiry never greys a live proposal.
    expect(html).not.toContain('已过期')
  })

  it('has no buttons once the proposal is done, and says what happened', () => {
    for (const [state, note] of [
      ['succeeded', '已执行'],
      ['cancelled', '已取消'],
      ['superseded', '已作废'],
      ['executing', '正在执行']
    ] as const) {
      const html = render(view({ state, outcome: 'i-0abc: shutting-down' }))
      expect(html).toContain(note)
      expect(html).not.toContain('确认执行…')
    }
    expect(render(view({ expiresAt: Date.now() - 1 }))).toContain('已过期，请让助手重新生成')
    expect(render(view({ expiresAt: Date.now() - 1 }))).not.toContain('确认执行…')
  })

  it('while the impact analysis runs the first step is disabled; once it ends (done or failed) it is enabled; a raised risk is marked', () => {
    const generic = (analysis: ProposalView['analysis'], block: object) =>
      render(view({ generic: true, tier: 'B', risk: 'destructive', production: false, analysis, card: { ...view().card, v: 3, blocks: [block as never] } }))
    const running = generic({ status: 'running', calls: 1 }, { type: 'analysis', status: 'running', calls: 1 })
    expect(running).toContain('正在分析影响…（用到的查询：1）')
    expect(running).toMatch(/<button type="button" class="ai-card-btn danger" disabled="" title="影响分析完成后才能确认">确认执行…/)
    const failed = generic({ status: 'failed', calls: 0 }, { type: 'analysis', status: 'failed', calls: 0, error: '模型请求失败' })
    expect(failed).toContain('未能完成影响分析：模型请求失败，请自行核对参数')
    expect(failed).toContain('<button type="button" class="ai-card-btn danger">确认执行…')
    const raised = generic({ status: 'done', calls: 2 }, { type: 'analysis', status: 'done', calls: 2, raised: { from: 'high', to: 'destructive' } })
    expect(raised).toContain('title="AI 影响分析把风险从「高风险」提高到了「破坏性」，原因见卡片"')
    expect(raised).toContain('破坏性 ↑')
  })
})
