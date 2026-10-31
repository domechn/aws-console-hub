import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalView, ProposalView } from '../../../../shared/ai'
import { applyEvent, countdownTone, hiddenPending, pendingApprovals, pendingStatus } from '../../ai'
import { ApprovalCard, approvalKey, everySecond } from './ApprovalCard'
import { ProposalCard } from './ProposalCard'

const approval = (patch: Partial<ApprovalView> = {}): ApprovalView => ({
  id: 'a-0123456789ab',
  toolCallId: 'call-1',
  state: 'pending',
  service: 'secretsmanager',
  action: 'GetSecretValue',
  region: 'ap-northeast-1',
  accountName: 'Prod',
  awsAccountId: '123456789012',
  params: '{\n  "SecretId": "prod/db"\n}',
  reason: '<script>用户要看</script>',
  why: ['敏感读取：会返回密钥明文', '结果会发送给你选择的模型服务商'],
  sessionAllowed: false,
  createdAt: Date.now(),
  expiresAt: Date.now() + 300_000,
  hash: `sha256:${'a'.repeat(64)}`,
  ...patch
})
const render = (a: ApprovalView): string => renderToStaticMarkup(<ApprovalCard approval={a} accountColor="#123456" onDecide={async () => ({ ok: true })} />)

describe('ApprovalCard', () => {
  it('shows the call, why it asks, the model reason as such, the exact params, and allow / deny (no "always" for sensitive reads)', () => {
    const html = render(approval())
    expect(html).toContain('需要你的审批')
    expect(html).toContain('secretsmanager:GetSecretValue')
    expect(html).toContain('Prod · 123456789012')
    expect(html).toContain('敏感读取：会返回密钥明文')
    expect(html).toContain('>为什么需要审批<')
    expect(html).toContain('>助手的理由<')
    expect(html).toContain('只读操作')
    // Model text is text: React escapes it.
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;SecretId&quot;: &quot;prod/db&quot;')
    expect(html).toContain(`sha256:${'a'.repeat(12)}`)
    expect(html).toContain('允许一次')
    expect(html).toContain('拒绝')
    expect(html).not.toContain('本对话始终允许')
    expect(html).toContain('id="approval-a-0123456789ab"')
    // Allow buttons start disarmed (they arm after a second); deny never waits.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>允许一次/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>拒绝/)
    // A read gate: allow and deny look the same, neither primary nor red.
    expect(html).toMatch(/<button type="button" class="ai-card-btn"[^>]*>允许一次/)
    expect(html).toMatch(/<button type="button" class="ai-card-btn"[^>]*>拒绝/)
    // Shield, not a lock; the countdown sits in the head row and says what happens.
    expect(html).toContain('🛡')
    expect(html).not.toContain('🔒')
    expect(html).toMatch(/class="ai-approval-head">[^]*将在 [45]:\d\d 后自动拒绝<\/span><\/div>/)
    expect(html).not.toContain('urgent')
    // Params, then the buttons right under them, then the ids (with copy) in the footer.
    expect(html.indexOf('ai-request-params')).toBeLessThan(html.indexOf('允许一次'))
    expect(html.indexOf('>拒绝<')).toBeLessThan(html.indexOf('请求 ID a-0123456789ab'))
    expect(html).toContain('参数校验 sha256:')
    expect(html).toContain('aria-label="复制请求 ID"')
    // Region chip with its globe; no account-coloured bar fighting the amber accent.
    expect(html).toMatch(/🌐<\/span>ap-northeast-1/)
    expect(html).not.toContain('border-left-color')
  })

  it('the "exact params" sentence only when there are params; none say so plainly', () => {
    const withParams = render(approval())
    expect(withParams).toContain('执行的就是上面这些参数，助手改不了。')
    expect(withParams).not.toContain('此调用不带参数')
    const none = render(approval({ params: '{ }' }))
    expect(none).toContain('此调用不带参数')
    expect(none).not.toContain('执行的就是上面这些参数')
    expect(none).not.toContain('ai-request-params')
  })

  it('shows long approval parameters in full before any allow control', () => {
    const value = 'v'.repeat(400)
    const html = render(approval({ params: `{"Value":"${value}"}` }))
    expect(html).toContain(value)
    expect(html.indexOf(value)).toBeLessThan(html.indexOf('允许一次'))
  })

  it('layout: allow once, then deny, then the quiet session link with its full scope in the tooltip and chips', () => {
    const html = render(approval({ sessionAllowed: true, service: 'ssm', action: 'DescribeParameters' }))
    expect(html.indexOf('允许一次')).toBeLessThan(html.indexOf('>拒绝<'))
    expect(html.indexOf('>拒绝<')).toBeLessThan(html.indexOf('>本对话始终允许此操作<'))
    expect(html).toMatch(/class="ai-link-btn ai-approval-session"[^>]*title="ssm:DescribeParameters · Prod 123456789012 · ap-northeast-1/)
    expect(html).toMatch(/class="ai-approval-where">[^]*ssm:DescribeParameters[^]*Prod · 123456789012[^]*ap-northeast-1<\/span><\/div>/)
  })

  it('countdown: plain over two minutes, amber under two, red under one', () => {
    expect(countdownTone(120_000)).toBe('')
    expect(countdownTone(119_999)).toBe('soon')
    expect(countdownTone(60_000)).toBe('soon')
    expect(countdownTone(59_999)).toBe('urgent')
    expect(countdownTone(-1)).toBe('urgent')
    expect(render(approval({ expiresAt: Date.now() + 90_000 }))).toMatch(/class="ai-countdown soon"[^>]*>将在 1:[23]\d 后自动拒绝/)
    expect(render(approval({ expiresAt: Date.now() + 30_000 }))).toMatch(/class="ai-countdown urgent"[^>]*>将在 0:[23]\d 后自动拒绝/)
  })

  it('countdown follows the clock second by second (fake timers)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const a = approval({ createdAt: 1_000_000, expiresAt: 1_000_000 + 295_000 })
      // The card's clock: one tick a second, none after it stops.
      const tick = vi.fn()
      const stop = everySecond(tick)
      vi.advanceTimersByTime(999)
      expect(tick).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2001)
      expect(tick).toHaveBeenCalledTimes(3)
      stop()
      vi.advanceTimersByTime(5000)
      expect(tick).toHaveBeenCalledTimes(3)
      vi.setSystemTime(1_000_000)
      // And what each tick draws.
      expect(render(a)).toContain('将在 4:55 后自动拒绝')
      vi.advanceTimersByTime(1000)
      expect(render(a)).toContain('将在 4:54 后自动拒绝')
      vi.advanceTimersByTime(174_000)
      expect(render(a)).toMatch(/class="ai-countdown"[^>]*>将在 2:00 后自动拒绝/)
      vi.advanceTimersByTime(1000)
      expect(render(a)).toMatch(/class="ai-countdown soon"[^>]*>将在 1:59 后自动拒绝/)
      vi.advanceTimersByTime(60_000)
      expect(render(a)).toMatch(/class="ai-countdown urgent"[^>]*>将在 0:59 后自动拒绝/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers "always in this conversation" only when main says so; a decided card has no buttons', () => {
    expect(render(approval({ sessionAllowed: true }))).toContain('>本对话始终允许此操作<')
    const done = render(approval({ state: 'allowed', decision: 'session', sessionAllowed: true }))
    expect(done).toContain('已允许（本对话内一直允许此动作）')
    expect(done).not.toContain('>允许一次</button>')
    expect(done).not.toContain('>拒绝</button>')
    expect(done).not.toContain('ai-approval-session')
    expect(render(approval({ state: 'expired' }))).toContain('已超时（视为拒绝）')
    expect(render(approval({ expiresAt: Date.now() - 1 }))).not.toContain('允许一次')
  })
})

describe('ApprovalCard keyboard (plan ai-ux-redesign §3.4)', () => {
  const card = { id: 'card' }
  const key = (patch: Partial<Parameters<typeof approvalKey>[0]> = {}): Parameters<typeof approvalKey>[0] => ({
    key: 'Enter',
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: card,
    currentTarget: card,
    ...patch
  })

  it('↵ on the card does nothing until the allow buttons arm (1 s after the card appears), then allows once', () => {
    expect(approvalKey(key(), false, true)).toBeNull()
    expect(approvalKey(key(), true, false)).toBe('once')
    // The card is reachable with Tab but never takes the focus itself; its key line is tied to it.
    const html = render(approval())
    expect(html).toMatch(/role="group" tabindex="0"/)
    expect(html).not.toMatch(/autofocus/i)
    expect(html).toContain('aria-describedby="approval-keys-a-0123456789ab"')
    expect(html).toMatch(/允许一次<kbd aria-hidden="true">↵<\/kbd>/)
    expect(html).toMatch(/拒绝<kbd aria-hidden="true">Esc<\/kbd>/)
  })

  it('a held ↵ (e.repeat) never allows', () => {
    expect(approvalKey(key({ repeat: true }), true, true)).toBeNull()
    expect(approvalKey(key({ repeat: true, metaKey: true }), true, true)).toBeNull()
  })

  it('↵ (or ⌘↵) with the focus in the input, or on anything but the card itself, never allows', () => {
    const textarea = { tagName: 'TEXTAREA' }
    const button = { tagName: 'BUTTON' }
    for (const target of [textarea, button]) {
      expect(approvalKey(key({ target }), true, true)).toBeNull()
      expect(approvalKey(key({ target, metaKey: true }), true, true)).toBeNull()
      expect(approvalKey(key({ target, ctrlKey: true }), true, true)).toBeNull()
    }
    // ⇧↵ / ⌥↵ (the input's newline habits) are not an allow either.
    expect(approvalKey(key({ shiftKey: true }), true, true)).toBeNull()
    expect(approvalKey(key({ altKey: true }), true, true)).toBeNull()
  })

  it('esc denies from anywhere in the card, armed or not, held or not', () => {
    expect(approvalKey(key({ key: 'Escape' }), false, false)).toBe('deny')
    expect(approvalKey(key({ key: 'Escape', target: { tagName: 'BUTTON' }, repeat: true }), true, true)).toBe('deny')
    expect(approvalKey(key({ key: 'a' }), true, true)).toBeNull()
  })

  it('⌘↵ / Ctrl+↵ allows for the conversation only when main offers it (and is not a plain allow otherwise)', () => {
    expect(approvalKey(key({ metaKey: true }), true, false)).toBeNull()
    expect(approvalKey(key({ ctrlKey: true }), true, false)).toBeNull()
    expect(approvalKey(key({ metaKey: true }), true, true)).toBe('session')
    expect(approvalKey(key({ ctrlKey: true }), true, true)).toBe('session')
    expect(approvalKey(key({ metaKey: true }), false, true)).toBeNull()
    expect(render(approval({ sessionAllowed: true }))).toContain('⌘↵ / Ctrl+↵ 本对话始终允许')
    expect(render(approval({ sessionAllowed: false }))).not.toContain('⌘↵')
  })
})

describe('approval events in the panel', () => {
  it('puts the card under its call, marks the row waiting, and runs it on after the decision', () => {
    let items = applyEvent([{ kind: 'user', text: 'q' }], { type: 'tool-start', id: 'call-1', label: '调用 sqs:ListQueues' })
    items = applyEvent([...items, { kind: 'assistant', text: 'later' }], { type: 'approval', approval: approval() })
    expect(items.map((i) => (i.kind === 'tool' ? `tool:${i.status}` : i.kind))).toEqual(['user', 'tool:waiting', 'approval', 'assistant'])
    expect(pendingApprovals(items)).toEqual(['a-0123456789ab'])
    items = applyEvent(items, { type: 'approval', approval: approval({ state: 'denied', decision: 'deny' }) })
    expect(items.map((i) => (i.kind === 'tool' ? `tool:${i.status}` : i.kind === 'approval' ? `approval:${i.approval.state}` : i.kind))).toEqual(['user', 'tool:running', 'approval:denied', 'assistant'])
    expect(pendingApprovals(items)).toEqual([])
  })

  it('the status line: always while the answer waits on an approval; proposals once out of view; never anything that allows', () => {
    expect(pendingStatus(0, 0, false)).toBe('')
    expect(pendingStatus(1, 0, false)).toBe('回答已暂停，等你处理上面的审批')
    expect(pendingStatus(2, 0, true)).toBe('回答已暂停，等你处理上面的 2 个审批')
    // A proposal pauses nothing: no line while its card is on screen.
    expect(pendingStatus(0, 1, false)).toBe('')
    expect(pendingStatus(0, 1, true)).toBe('1 个变更提案等待你确认')
    expect(pendingStatus(1, 2, false)).toBe('回答已暂停，等你处理上面的审批；2 个变更提案等待你确认')
    for (const [c, p, h] of [[1, 0, true], [3, 2, true]] as const) expect(pendingStatus(c, p, h)).not.toMatch(/允许/)
  })

  it('the status line jumps only to waiting cards the list has scrolled away, first in order', () => {
    const ids = ['approval-a1', 'proposal-p1']
    // Nothing reported out of view yet (a card just arrived, or it is on screen): no jump button.
    expect(hiddenPending(ids, new Set())).toEqual([])
    expect(hiddenPending(ids, new Set(['proposal-p1']))).toEqual(['proposal-p1'])
    expect(hiddenPending(ids, new Set(['proposal-p1', 'approval-a1']))).toEqual(['approval-a1', 'proposal-p1'])
    // A decided card left behind in the set doesn't count.
    expect(hiddenPending(['proposal-p1'], new Set(['approval-a1']))).toEqual([])
  })
})

const proposal = (patch: Partial<ProposalView> = {}): ProposalView => ({
  id: 'p-0123456789ab',
  state: 'pending',
  title: 'iam:AttachRolePolicy（通用请求）',
  risk: 'destructive',
  accountName: 'Prod',
  awsAccountId: '123456789012',
  region: 'us-east-1',
  production: true,
  createdAt: Date.now(),
  expiresAt: Date.now() + 600_000,
  confirmText: 'iam:AttachRolePolicy@123456789012',
  generic: true,
  tier: 'C',
  dangers: ['IAM 权限类变更（策略、访问密钥、登录配置、信任关系、角色）'],
  card: {
    v: 1,
    id: 'c-0123456789ab',
    origin: 'system',
    title: 'iam:AttachRolePolicy（通用请求）',
    blocks: [
      { type: 'risk', level: 'destructive', reasons: ['需要强确认的类别：IAM 权限类变更'] },
      { type: 'request', action: 'iam:AttachRolePolicy', region: 'us-east-1', params: '{\n  "RoleName": "ci"\n}' }
    ],
    createdAt: 0,
    expiresAt: 1,
    state: 'active'
  },
  ...patch
})
const renderProposal = (p: ProposalView): string =>
  renderToStaticMarkup(<ProposalCard proposal={p} accountColor="#123456" onLink={() => {}} onConfirm={async () => ({ ok: true })} onCancel={async () => ({ ok: true })} />)

describe('ProposalCard: generic and strong approval', () => {
  it('tier C: red banner naming the danger, the request block in full, no diff', () => {
    const html = renderProposal(proposal())
    expect(html).toContain('ai-strong-banner')
    expect(html).toContain('强确认 · 此类操作需要仔细核对')
    expect(html).toContain('IAM 权限类变更')
    expect(html).toContain('通用请求')
    expect(html).toContain('&quot;RoleName&quot;: &quot;ci&quot;')
    expect(html).not.toContain('ai-diff')
    expect(html).toContain('aria-label="强确认：iam:AttachRolePolicy（通用请求）"')
    // The banner's own words make no claim about the effect.
    expect(html).toContain('没有专用适配器，应用无法预知影响')
    expect(html).not.toMatch(/危险操作|无法预估|可能无法撤销/)
  })

  it('tier B: a plain note instead of the banner', () => {
    const html = renderProposal(proposal({ tier: 'B', dangers: [], risk: 'high', confirmText: 'sns:Publish', production: false }))
    expect(html).not.toContain('ai-strong-banner')
    expect(html).toContain('没有专用适配器')
    expect(html).toContain('不做漂移检查')
  })

  it('both generic tiers show the exact request before confirmation', () => {
    const value = 'v'.repeat(400)
    for (const tier of ['B', 'C'] as const) {
      const p = proposal({ tier, card: { ...proposal().card, blocks: [{ type: 'change', kind: 'request', summary: '发送', fields: [{ label: 'Value', value }], raw: `{"Value":"${value}"}` }] } })
      const html = renderProposal(p)
      expect(html).toContain(value)
      expect(html).toMatch(/<details class="ai-change-raw" open=""/)
      expect(html.indexOf('ai-request-params')).toBeLessThan(html.indexOf('确认执行…'))
    }
  })
})
