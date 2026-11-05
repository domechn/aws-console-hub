import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalView } from '../../shared/ai'
import type { AwsAccount } from '../../shared/types'
import { APPROVAL_LIMITS, ApprovalStore, type ApprovalRequest } from './approvals'
import { toChatItems } from './history'

const ACCOUNT: AwsAccount = { id: 'acc-1', kind: 'assume', name: 'Sandbox', accountId: '123456789012', role: 'Admin', viaId: 'base', defaultRegion: 'us-east-1', color: '#000' }

function setup() {
  let account: AwsAccount | undefined = { ...ACCOUNT }
  const clock = { now: 1_800_000_000_000 }
  const audits: { type: string; data: Record<string, any> }[] = []
  const shown: ApprovalView[] = []
  const store = new ApprovalStore({
    account: (id) => (id === 'acc-1' ? account : undefined),
    audit: (type, _a, data) => audits.push({ type, data }),
    onState: (_a, _c, v) => shown.push(v),
    now: () => clock.now
  })
  const req = (patch: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    accountId: 'acc-1',
    conversationId: 'conv-1',
    toolCallId: 'call-1',
    service: 'sqs',
    action: 'ListQueues',
    region: 'us-east-1',
    params: { QueueNamePrefix: 'prod', Nested: { a: [1, 2] } },
    reason: '用户想看队列',
    why: ['sqs 不在默认自动允许的服务里，需要你确认'],
    sessionAllowed: true,
    ...patch
  })
  /** Starts a request and returns it once its card is out. */
  const ask = async (patch: Partial<ApprovalRequest> = {}, signal?: AbortSignal) => {
    const before = shown.length
    const verdict = store.request(req(patch), signal)
    await vi.waitFor(() => expect(shown.length).toBeGreaterThan(before))
    return { verdict, view: shown[shown.length - 1] }
  }
  const types = () => audits.map((a) => a.type)
  return { store, clock, audits, shown, req, ask, types, setAccount: (a: AwsAccount | undefined) => (account = a) }
}

afterEach(() => vi.useRealTimers())

describe('ApprovalStore lifecycle', () => {
  it('allow once: the call gets the frozen params the card showed, exactly once', async () => {
    const s = setup()
    const { verdict, view } = await s.ask()
    expect(view).toMatchObject({ state: 'pending', service: 'sqs', action: 'ListQueues', region: 'us-east-1', accountName: 'Sandbox', awsAccountId: '123456789012', reason: '用户想看队列', sessionAllowed: true })
    expect(view.id).toMatch(/^a-[0-9a-f]{12}$/)
    expect(view.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    // The card shows exactly what runs.
    expect(JSON.parse(view.params)).toEqual(s.req().params)
    s.store.decide('acc-1', 'conv-1', view.id, 'once')
    const v = await verdict
    expect(v).toMatchObject({ ok: true, region: 'us-east-1', params: s.req().params, view: { state: 'allowed', decision: 'once' } })
    // Double click: the second one finds it decided; nothing else resolves.
    expect(() => s.store.decide('acc-1', 'conv-1', view.id, 'once')).toThrow('已经允许过了')
    expect(s.types()).toEqual(['approval_requested', 'approval_allowed'])
    expect(s.audits[0].data).toMatchObject({ approvalId: view.id, hash: view.hash, service: 'sqs', action: 'ListQueues', actor: 'model' })
    expect(s.audits[1].data).toMatchObject({ decision: 'once', actor: 'user' })
  })

  it('shows complete secret-looking parameter values before read approval', async () => {
    const s = setup()
    const params = { Password: 'chosen-by-model', Nested: { SessionToken: 'also-chosen-by-model', AccessToken: 'access-chosen-by-model' }, NextToken: 'next' }
    const { verdict, view } = await s.ask({ params })
    expect(JSON.parse(view.params)).toEqual(params)
    s.store.decide('acc-1', 'conv-1', view.id, 'deny')
    const result = await verdict
    expect(JSON.stringify(s.audits)).not.toContain('chosen-by-model')
    expect(JSON.stringify(result.view)).not.toContain('chosen-by-model')
    expect(JSON.parse(result.view?.params ?? '{}').NextToken).toBe('next')
    expect(result.view?.params).toContain('[redacted]')
    const history = toChatItems([{ role: 'toolResult', toolCallId: 'call-1', details: { approval: result.view } }])
    expect(JSON.stringify(history)).not.toContain('chosen-by-model')
  })

  it('deny: the model is told not to retry, and the same action is not asked again for 10 minutes', async () => {
    const s = setup()
    const { verdict, view } = await s.ask()
    s.store.decide('acc-1', 'conv-1', view.id, 'deny')
    const v = await verdict
    expect(v).toMatchObject({ ok: false, message: expect.stringContaining('用户拒绝了这次调用（sqs:ListQueues）'), view: { state: 'denied' } })
    expect(!v.ok && v.message).toContain('不要换个参数或 action 重试')
    const cards = s.shown.length
    // Rapid-fire retry with other params: answered at once, no new card.
    const again = await s.store.request(s.req({ params: { QueueNamePrefix: 'other' } }))
    expect(again).toMatchObject({ ok: false, message: expect.stringContaining('拒绝过 sqs:ListQueues') })
    expect(s.shown).toHaveLength(cards)
    expect(s.types()).toContain('approval_auto_denied')
    s.clock.now += APPROVAL_LIMITS.deniedCooldownMs + 1
    void s.store.request(s.req())
    expect(s.shown.length).toBe(cards + 1)
  })

  it('times out after 5 minutes as a denial; a late click is refused', async () => {
    vi.useFakeTimers()
    const s = setup()
    const verdict = s.store.request(s.req())
    const view = s.shown[0]
    vi.advanceTimersByTime(APPROVAL_LIMITS.ttlMs)
    expect(await verdict).toMatchObject({ ok: false, message: expect.stringContaining('视为拒绝'), view: { state: 'expired' } })
    expect(() => s.store.decide('acc-1', 'conv-1', view.id, 'once')).toThrow('已过期')
    expect(s.types()).toEqual(['approval_requested', 'approval_expired'])
  })

  it('a click past the TTL (timer not fired yet) is refused as stale', async () => {
    const s = setup()
    const { verdict, view } = await s.ask()
    s.clock.now = view.expiresAt + 1
    expect(() => s.store.decide('acc-1', 'conv-1', view.id, 'once')).toThrow('已过期')
    expect(await verdict).toMatchObject({ ok: false })
  })

  it('aborting the run ends the pending approval; a click after that is refused', async () => {
    const s = setup()
    const ac = new AbortController()
    const { verdict, view } = await s.ask({}, ac.signal)
    ac.abort()
    expect(await verdict).toMatchObject({ ok: false, message: '已停止', view: { state: 'aborted' } })
    expect(() => s.store.decide('acc-1', 'conv-1', view.id, 'once')).toThrow('已停止')
    // Also without a signal: the service's abort path.
    const second = await s.ask({ toolCallId: 'call-2' })
    s.store.abortConversation('conv-1')
    expect(await second.verdict).toMatchObject({ ok: false, view: { state: 'aborted' } })
    // An already-aborted signal never shows a card.
    const cards = s.shown.length
    expect(await s.store.request(s.req(), AbortSignal.abort())).toMatchObject({ ok: false })
    expect(s.shown).toHaveLength(cards)
  })

  it('only the owning account and conversation can decide', async () => {
    const s = setup()
    const { view } = await s.ask()
    expect(() => s.store.decide('acc-2', 'conv-1', view.id, 'once')).toThrow('审批不存在')
    expect(() => s.store.decide('acc-1', 'conv-2', view.id, 'once')).toThrow('审批不存在')
    expect(() => s.store.decide('acc-1', 'conv-1', 'a-000000000000', 'once')).toThrow('审批不存在')
    expect(s.store.forToolCall('conv-1', 'call-1')?.state).toBe('pending')
    // A provider reusing tool call ids can't show this card in another conversation.
    expect(s.store.forToolCall('conv-2', 'call-1')).toBeUndefined()
  })

  it('a changed record (params swapped after the card was shown) is voided, never run', async () => {
    const s = setup()
    const { verdict, view } = await s.ask()
    const record = (s.store as unknown as { records: Map<string, { params: unknown }> }).records.get(view.id)!
    record.params = { QueueNamePrefix: 'attacker' }
    expect(() => s.store.decide('acc-1', 'conv-1', view.id, 'once')).toThrow('校验失败')
    expect(await verdict).toMatchObject({ ok: false })
    expect(s.types()).toContain('approval_tampered')
  })

  it('strips control and format characters from model-influenced card text (reason, quoted params in why)', async () => {
    const s = setup()
    const { view } = await s.ask({ reason: '安全‮的\u0007操作', why: ['桶 evil‮-bucket 不在当前账号的桶列表里'] })
    expect(view.reason).toBe('安全 的 操作')
    expect(view.why[0]).toBe('桶 evil -bucket 不在当前账号的桶列表里')
  })

  it('the account login changing while the card waits voids an allow', async () => {
    const s = setup()
    const { verdict, view } = await s.ask()
    s.setAccount({ ...ACCOUNT, role: 'OtherRole' })
    expect(() => s.store.decide('acc-1', 'conv-1', view.id, 'once')).toThrow('登录配置')
    expect(await verdict).toMatchObject({ ok: false })
  })
})

describe('ApprovalStore: "本对话内一直允许"', () => {
  it('keys on service:action:region (not params) within the conversation, audited, revocable', async () => {
    const s = setup()
    const first = await s.ask()
    s.store.decide('acc-1', 'conv-1', first.view.id, 'session')
    await first.verdict
    const cards = s.shown.length
    // Same action and region, other params: runs without a card.
    expect(await s.store.request(s.req({ params: { QueueNamePrefix: 'x' } }))).toMatchObject({ ok: true, params: { QueueNamePrefix: 'x' } })
    expect(s.shown).toHaveLength(cards)
    expect(s.types()).toContain('approval_auto')
    // Another region, another conversation: asked again.
    void s.store.request(s.req({ region: 'eu-west-1' }))
    void s.store.request(s.req({ conversationId: 'conv-2' }))
    expect(s.shown).toHaveLength(cards + 2)
    expect(s.store.sessionAllows()).toEqual([{ accountId: 'acc-1', conversationId: 'conv-1', key: 'sqs:ListQueues:us-east-1', at: expect.any(Number) }])
    expect(() => s.store.revoke('acc-2', 'conv-1', 'sqs:ListQueues:us-east-1')).toThrow('没有这条允许记录')
    s.store.revoke('acc-1', 'conv-1', 'sqs:ListQueues:us-east-1')
    expect(s.types()).toContain('approval_revoked')
    expect(s.store.sessionAllows()).toEqual([])
  })

  it('is refused for calls that may not have it (sensitive, unknown names, other accounts), and a remembered key never covers them', async () => {
    const s = setup()
    const { verdict, view } = await s.ask({ service: 'secretsmanager', action: 'GetSecretValue', sessionAllowed: false })
    expect(() => s.store.decide('acc-1', 'conv-1', view.id, 'session')).toThrow('只能允许一次')
    expect(s.store.forToolCall('conv-1', 'call-1')?.state).toBe('pending')
    s.store.decide('acc-1', 'conv-1', view.id, 'once')
    await verdict
    // Even with the key granted for a plain read, a sessionAllowed=false request still asks.
    const plain = await s.ask({ toolCallId: 'c2' })
    s.store.decide('acc-1', 'conv-1', plain.view.id, 'session')
    const cards = s.shown.length
    void s.store.request(s.req({ toolCallId: 'c3', sessionAllowed: false }))
    expect(s.shown).toHaveLength(cards + 1)
  })

  it('goes with the conversation', async () => {
    const s = setup()
    const { verdict, view } = await s.ask()
    s.store.decide('acc-1', 'conv-1', view.id, 'session')
    await verdict
    s.store.forgetConversation('conv-1')
    expect(s.store.sessionAllows()).toEqual([])
  })
})

describe('ApprovalStore: rate limits against approval fatigue', () => {
  it('a run budget counts cards only; "always allow" does not use it up', async () => {
    const s = setup()
    const perRun = { left: 1 }
    const first = s.store.request(s.req(), undefined, perRun)
    s.store.decide('acc-1', 'conv-1', s.shown[0].id, 'session')
    await first
    for (let i = 0; i < 5; i++) expect(await s.store.request(s.req({ toolCallId: `p-${i}` }), undefined, perRun)).toMatchObject({ ok: true })
    expect(await s.store.request(s.req({ action: 'ListMore' }), undefined, perRun)).toMatchObject({ ok: false, message: expect.stringContaining('已达上限') })
  })

  it('at most 3 pending per account, 6 requests per conversation per minute', async () => {
    const s = setup()
    for (let i = 0; i < APPROVAL_LIMITS.maxPending; i++) void s.store.request(s.req({ conversationId: `c-${i}`, toolCallId: `t-${i}` }))
    expect(s.store.pendingCount('acc-1')).toBe(3)
    expect(await s.store.request(s.req({ conversationId: 'c-9' }))).toMatchObject({ ok: false, message: expect.stringContaining('上限 3') })
    s.store.forgetAll()

    const t = setup()
    for (let i = 0; i < APPROVAL_LIMITS.perMinute; i++) {
      const { verdict, view } = await t.ask({ toolCallId: `t-${i}`, action: `ListThing${i}` })
      t.store.decide('acc-1', 'conv-1', view.id, 'once')
      await verdict
    }
    expect(await t.store.request(t.req({ action: 'ListMore' }))).toMatchObject({ ok: false, message: expect.stringContaining('太频繁') })
    expect(t.types().filter((x) => x === 'approval_rate_limited')).toHaveLength(1)
    t.clock.now += 61_000
    void t.store.request(t.req({ action: 'ListMore' }))
    expect(t.store.pendingCount('acc-1')).toBe(1)
  })
})
