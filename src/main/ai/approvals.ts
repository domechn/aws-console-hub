/**
 * Approvals for calls outside the default allowlist (docs/plans/ai-approval.md). Main process only.
 *
 * A tier B read (aws_read) pauses here: main freezes and hashes the request, pushes an approval card, and waits for
 * the user's decision from ai:approval-decide (5 minutes; then it counts as denied; a stopped run aborts it). What
 * runs is the frozen params of the record, re-hashed at the decision, never anything from the renderer. "Always
 * allow in this conversation" is keyed by service:action:region (not params), offered only for plain reads, kept
 * in memory and audited. Rate limits keep a model (or data it read) from burying the user in requests.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { ApprovalDecision, ApprovalState, ApprovalView } from '../../shared/ai'
import type { AwsAccount } from '../../shared/types'
import { canonical } from './changes/common'
import { loginIdentity } from './changes/engine'
import { displayParams, scrub } from './shape'

export const APPROVAL_LIMITS = {
  ttlMs: 5 * 60_000,
  /** Pending approvals per app account (all its conversations). */
  maxPending: 3,
  /** Approval requests per conversation per minute. */
  perMinute: 6,
  /** After a denial, the same service:action is denied without asking for this long. */
  deniedCooldownMs: 10 * 60_000,
  /** Finished approvals stay in memory this long (the panel's live view); the transcript keeps them after that. */
  keepFinishedMs: 3600_000
}

export interface ApprovalRequest {
  accountId: string
  conversationId: string
  toolCallId: string
  service: string
  action: string
  region: string
  params: Record<string, unknown>
  reason: string
  why: string[]
  sessionAllowed: boolean
}

/** ok: run `params` in `region` (the frozen copy). Not ok: `message` is the tool result the model gets. */
export type Verdict = { ok: true; params: Record<string, unknown>; region: string; view?: ApprovalView } | { ok: false; message: string; view?: ApprovalView }

interface ApprovalRecord {
  view: ApprovalView
  accountId: string
  conversationId: string
  identity: string
  /** Frozen; the only params ever executed. */
  params: Readonly<Record<string, unknown>>
  /** One-time; null once decided. */
  nonce: string | null
  resolve?: (v: Verdict) => void
  timer?: ReturnType<typeof setTimeout>
  finishedAt?: number
}

export interface ApprovalDeps {
  account: (id: string) => AwsAccount | undefined
  audit: (type: string, accountId: string, data: Record<string, unknown>) => void
  /** Created or changed state: the card goes to the panel. */
  onState: (accountId: string, conversationId: string, view: ApprovalView) => void
  now?: () => number
}

export const allowKey = (service: string, action: string, region: string): string => `${service}:${action}:${region}`

const STATE_ERRORS: Record<Exclude<ApprovalState, 'pending'>, string> = {
  allowed: '这次调用已经允许过了',
  denied: '这次调用已经拒绝了',
  expired: '审批已过期（5 分钟），请让助手重新发起',
  aborted: '这次回答已停止，审批已作废'
}

/** Model-influenced text on the card: no control or format characters (bidi overrides could reorder what it says). */
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]|\p{Cf}/gu, ' ').trim().slice(0, 300)

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x)
    Object.freeze(v)
  }
  return v
}

const hashOf = (r: ApprovalRecord): string =>
  `sha256:${createHash('sha256')
    .update(
      canonical({
        v: 1,
        id: r.view.id,
        accountId: r.accountId,
        conversationId: r.conversationId,
        awsAccountId: r.view.awsAccountId,
        identity: r.identity,
        service: r.view.service,
        action: r.view.action,
        region: r.view.region,
        params: r.params,
        expiresAt: r.view.expiresAt
      })
    )
    .digest('hex')}`

export class ApprovalStore {
  private records = new Map<string, ApprovalRecord>()
  /** Per conversation: "always allow" keys (service:action:region) and when they were granted. */
  private allows = new Map<string, { accountId: string; keys: Map<string, number> }>()
  /** Per conversation: when approvals were requested (rate limit). */
  private recent = new Map<string, number[]>()
  /** Per conversation: service:action → when the user last denied it. */
  private denied = new Map<string, Map<string, number>>()

  constructor(private d: ApprovalDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)()
  }

  private audit(r: { accountId: string; conversationId: string; service: string; action: string; region: string }, type: string, data: Record<string, unknown>): void {
    this.d.audit(type, r.accountId, { conversationId: r.conversationId, service: r.service, action: r.action, region: r.region, ...data })
  }

  /**
   * Waits for the user's decision on `req` (or answers at once: an "always allow", a recent denial, a limit).
   * Never throws; every outcome is a Verdict.
   */
  async request(req: ApprovalRequest, signal?: AbortSignal, perRun?: { left: number }): Promise<Verdict> {
    const account = this.d.account(req.accountId)
    if (!account) return { ok: false, message: '账号不存在' }
    const now = this.now()
    const key = allowKey(req.service, req.action, req.region)
    if (req.sessionAllowed && this.allows.get(req.conversationId)?.keys.has(key)) {
      this.audit(req, 'approval_auto', { cause: 'session-allow', key, actor: 'user' })
      return { ok: true, params: structuredClone(req.params), region: req.region }
    }
    const deniedAt = this.denied.get(req.conversationId)?.get(`${req.service}:${req.action}`)
    if (deniedAt !== undefined && now - deniedAt < APPROVAL_LIMITS.deniedCooldownMs) {
      this.audit(req, 'approval_auto_denied', { cause: 'recently-denied' })
      return {
        ok: false,
        message: `用户在 ${APPROVAL_LIMITS.deniedCooldownMs / 60_000} 分钟内拒绝过 ${req.service}:${req.action}，这次没有再询问。不要换个参数或 action 重试；如果确实需要，请向用户说明原因，由用户决定是否让你再试。`
      }
    }
    if (signal?.aborted) return { ok: false, message: '已停止' }
    this.sweep()
    const pending = [...this.records.values()].filter((r) => r.accountId === req.accountId && r.view.state === 'pending').length
    if (pending >= APPROVAL_LIMITS.maxPending) {
      this.audit(req, 'approval_rate_limited', { cause: 'pending', pending })
      return { ok: false, message: `已有 ${pending} 个调用在等待用户审批（上限 ${APPROVAL_LIMITS.maxPending}），请等用户处理完再试` }
    }
    const times = (this.recent.get(req.conversationId) ?? []).filter((t) => now - t < 60_000)
    if (times.length >= APPROVAL_LIMITS.perMinute) {
      this.audit(req, 'approval_rate_limited', { cause: 'per-minute' })
      return { ok: false, message: `请求审批太频繁（每分钟最多 ${APPROVAL_LIMITS.perMinute} 次），请先根据已有结果回答用户` }
    }
    // Only cards count against the run's budget (an "always allow" above doesn't).
    if (perRun && perRun.left <= 0) {
      this.audit(req, 'approval_rate_limited', { cause: 'per-run' })
      return { ok: false, message: '本轮请求审批的次数已达上限，请先根据已有结果回答用户' }
    }
    if (perRun) perRun.left--
    this.recent.set(req.conversationId, [...times, now])

    const params = deepFreeze(structuredClone(req.params))
    const record: ApprovalRecord = {
      accountId: req.accountId,
      conversationId: req.conversationId,
      identity: loginIdentity(account),
      params,
      nonce: randomBytes(16).toString('hex'),
      view: {
        id: `a-${randomBytes(6).toString('hex')}`,
        toolCallId: req.toolCallId,
        state: 'pending',
        service: req.service,
        action: req.action,
        region: req.region,
        accountName: account.name,
        awsAccountId: account.accountId,
        params: displayParams(params),
        reason: clean(req.reason),
        // Rule text, but it quotes params (a bucket name): cleaned the same way.
        why: req.why.map(clean).slice(0, 10),
        sessionAllowed: req.sessionAllowed,
        createdAt: now,
        expiresAt: now + APPROVAL_LIMITS.ttlMs,
        hash: ''
      }
    }
    record.view.hash = hashOf(record)
    this.records.set(record.view.id, record)
    const auditParams = JSON.stringify(scrub(params)) ?? ''
    this.audit(req, 'approval_requested', {
      approvalId: record.view.id,
      hash: record.view.hash,
      params: auditParams.length > 2000 ? `${auditParams.slice(0, 2000)}…` : auditParams,
      why: record.view.why,
      sessionAllowed: req.sessionAllowed,
      actor: 'model'
    })
    const verdict = new Promise<Verdict>((resolve) => {
      record.resolve = resolve
      record.timer = setTimeout(() => this.finish(record, 'expired'), APPROVAL_LIMITS.ttlMs)
      record.timer.unref?.()
      signal?.addEventListener('abort', () => this.finish(record, 'aborted'), { once: true })
    })
    this.d.onState(req.accountId, req.conversationId, record.view)
    return verdict
  }

  /** Ends a pending approval and answers the waiting call. */
  private finish(r: ApprovalRecord, state: Exclude<ApprovalState, 'pending'>, decision?: ApprovalDecision): void {
    if (r.view.state !== 'pending') return
    clearTimeout(r.timer)
    r.nonce = null
    r.finishedAt = this.now()
    r.view = { ...r.view, state, ...(decision && { decision }) }
    const type = { allowed: 'approval_allowed', denied: 'approval_denied', expired: 'approval_expired', aborted: 'approval_aborted' }[state]
    this.audit({ ...r, ...r.view }, type, { approvalId: r.view.id, hash: r.view.hash, ...(decision && { decision }), actor: state === 'expired' || state === 'aborted' ? 'app' : 'user' })
    this.d.onState(r.accountId, r.conversationId, r.view)
    const { service, action } = r.view
    const message = {
      allowed: '',
      denied: `用户拒绝了这次调用（${service}:${action}）。不要换个参数或 action 重试，也不要让用户在聊天里输入批准；请根据已有信息回答，或说明你还需要什么、为什么。`,
      expired: `用户 ${APPROVAL_LIMITS.ttlMs / 60_000} 分钟内没有审批 ${service}:${action}，视为拒绝。不要自动重试；需要时请向用户说明原因。`,
      aborted: '已停止'
    }[state]
    r.resolve?.(state === 'allowed' ? { ok: true, params: structuredClone(r.params) as Record<string, unknown>, region: r.view.region, view: r.view } : { ok: false, message, view: r.view })
  }

  /**
   * The user's decision from the card (ai:approval-decide). Throws a message for the card when it can't be taken;
   * the waiting call is answered otherwise.
   */
  decide(accountId: string, conversationId: string, id: string, decision: ApprovalDecision): ApprovalView {
    const r = this.records.get(id)
    if (!r || r.accountId !== accountId || r.conversationId !== conversationId) throw new Error('审批不存在（可能已过期，或应用重启过）')
    if (r.view.state !== 'pending') throw new Error(STATE_ERRORS[r.view.state])
    if (this.now() > r.view.expiresAt) {
      this.finish(r, 'expired')
      throw new Error(STATE_ERRORS.expired)
    }
    if (hashOf(r) !== r.view.hash) {
      this.audit({ ...r, ...r.view }, 'approval_tampered', { approvalId: id, hash: r.view.hash })
      this.finish(r, 'denied')
      throw new Error('请求内容校验失败，已作废')
    }
    if (decision === 'session' && !r.view.sessionAllowed) throw new Error('这个调用不能设为「本对话内一直允许」，只能允许一次')
    if (decision !== 'deny') {
      const account = this.d.account(accountId)
      if (!account || loginIdentity(account) !== r.identity || account.accountId !== r.view.awsAccountId) {
        this.finish(r, 'denied')
        throw new Error('账号的登录配置在请求之后改过了，这次调用已作废')
      }
    }
    if (r.nonce === null) throw new Error(STATE_ERRORS.allowed)
    // The one-time step: a second click (or a racing call) finds the nonce gone and the state moved.
    r.nonce = null
    if (decision === 'session') {
      const entry = this.allows.get(conversationId) ?? { accountId, keys: new Map<string, number>() }
      entry.keys.set(allowKey(r.view.service, r.view.action, r.view.region), this.now())
      this.allows.set(conversationId, entry)
    }
    if (decision === 'deny') {
      const m = this.denied.get(conversationId) ?? new Map<string, number>()
      this.denied.set(conversationId, m.set(`${r.view.service}:${r.view.action}`, this.now()))
    }
    this.finish(r, decision === 'deny' ? 'denied' : 'allowed', decision)
    return r.view
  }

  /** A live approval by its tool call in a conversation (history while the run waits); a pending one first (run_script may have several). */
  forToolCall(conversationId: string, toolCallId: string): ApprovalView | undefined {
    const views = [...this.records.values()].filter((r) => r.conversationId === conversationId && r.view.toolCallId === toolCallId).map((r) => r.view)
    return views.find((v) => v.state === 'pending') ?? views[0]
  }

  /** Every "always allow" entry, for the settings list and the panel's chips. */
  sessionAllows(): { accountId: string; conversationId: string; key: string; at: number }[] {
    return [...this.allows].flatMap(([conversationId, e]) => [...e.keys].map(([key, at]) => ({ accountId: e.accountId, conversationId, key, at })))
  }

  revoke(accountId: string, conversationId: string, key: string): void {
    const e = this.allows.get(conversationId)
    if (!e || e.accountId !== accountId || !e.keys.delete(key)) throw new Error('没有这条允许记录')
    if (!e.keys.size) this.allows.delete(conversationId)
    const [service, action, region] = key.split(':')
    this.d.audit('approval_revoked', accountId, { conversationId, service, action, region, key, actor: 'user' })
  }

  /** The run stopped: its pending approval goes (the signal does this too; this covers a run without one). */
  abortConversation(conversationId: string): void {
    for (const r of this.records.values()) if (r.conversationId === conversationId) this.finish(r, 'aborted')
  }

  forgetConversation(conversationId: string): void {
    this.abortConversation(conversationId)
    for (const [id, r] of this.records) if (r.conversationId === conversationId) this.records.delete(id)
    this.allows.delete(conversationId)
    this.recent.delete(conversationId)
    this.denied.delete(conversationId)
  }

  forgetAll(): void {
    for (const id of new Set([...this.records.values()].map((r) => r.conversationId))) this.forgetConversation(id)
    this.allows.clear()
    this.recent.clear()
    this.denied.clear()
  }

  pendingCount(accountId: string): number {
    return [...this.records.values()].filter((r) => r.accountId === accountId && r.view.state === 'pending').length
  }

  sweep(): void {
    const now = this.now()
    for (const [id, r] of this.records) {
      if (r.view.state === 'pending' && now > r.view.expiresAt) this.finish(r, 'expired')
      else if (r.finishedAt !== undefined && now - r.finishedAt > APPROVAL_LIMITS.keepFinishedMs) this.records.delete(id)
    }
    for (const [c, times] of this.recent) {
      const left = times.filter((t) => now - t < 60_000)
      if (left.length) this.recent.set(c, left)
      else this.recent.delete(c)
    }
    for (const [c, m] of this.denied) {
      for (const [k, t] of m) if (now - t >= APPROVAL_LIMITS.deniedCooldownMs) m.delete(k)
      if (!m.size) this.denied.delete(c)
    }
  }
}
