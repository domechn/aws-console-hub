/**
 * ProposalStore and the confirmation path (plan §9.1). Main process only.
 *
 * propose: policy → write table (or the generic adapter: no adapter, or an adapter's forbidden param) → param
 *          schema → rate limits → snapshot (read-only) → plan → DryRun where AWS has one (else an IAM policy
 *          simulation) → risk → a frozen, hashed record with a one-time nonce. No write is sent: every
 *          AWS call before confirmation goes through `guard`, which only lets reads, DryRun requests and the
 *          CloudFormation change-set calls (a plan, not a change) through.
 * confirm: owner, state, TTL, hash, typed text, policy, login identity → nonce consumed (synchronously, so a double
 *          click or a racing call finds it gone) → caller identity (sts) → drift check (snapshot again) → policy
 *          once more → execute with the stored params → verify.
 * Nothing the model says reaches confirm: it is called only from the ai:proposal-confirm IPC (the panel's buttons),
 * which sends a proposal id and the typed text, never params.
 */
import { createHash, randomBytes } from 'node:crypto'
import { Value } from 'typebox/value'
import { AI_CHANGE_SERVICES, OTHER_SERVICES, RISK_LABEL, type ProposalState, type ProposalView, type Risk } from '../../../shared/ai'
import type { AnalysisBlockData, AnalysisResult } from '../../../shared/cards'
import { REGIONS } from '../../../shared/catalog'
import type { AwsAccount } from '../../../shared/types'
import type { AwsInputMembers, AwsSupports } from '../aws'
import { classifyAction } from '../classify'
import { fence, scrub } from '../shape'
import { proposalCard, type ProposalCardInput } from './card'
import { awsError, bump, canonical, fieldDiff, isProdTagged, needsTyped, requestIdOf, RISKS, type ChangeAdapter, type ChangeCtx, type Plan } from './common'
import { genericAdapter } from './generic'
import { lookupChange } from './registry'

export const PROPOSAL_LIMITS = {
  ttlMs: 10 * 60_000,
  /** Pending proposals per conversation. */
  maxPending: 3,
  /** Proposal attempts per conversation per minute. */
  perMinute: 5,
  /** Finished proposals stay in memory this long (for the panel); the transcript is the record after that. */
  keepFinishedMs: 24 * 3600_000
}

export const READ_ONLY_MESSAGE =
  '当前账号是只读模式，不能提出变更。请告诉用户：可以在 AI 面板顶部点「只读」开启「允许 AI 助手提出变更」（每个变更仍需用户确认），或在账号设置里打开。'

const REGION_IDS = new Set(REGIONS.map((r) => r.id))
/** Writes allowed before confirmation: they create or delete a plan, not a resource. EC2 DryRun requests also pass. */
const PLAN_CALLS = new Set(['cloudformation:CreateChangeSet', 'cloudformation:DeleteChangeSet'])
/**
 * Reads aws_read may not make that adapters need: one harmless EC2 attribute (aws_read refuses the call for userData),
 * the tagging API's lookup, and the IAM policy simulation of the permission pre-check. None changes anything.
 */
const ADAPTER_READS = new Set(['ec2:DescribeInstanceAttribute', 'tag:GetResources', 'iam:SimulatePrincipalPolicy'])

/** The model's propose_change arguments: untrusted, every field checked. */
export interface ProposeInput {
  service?: unknown
  action?: unknown
  params?: unknown
  reason?: unknown
  region?: unknown
}

export type Outcome =
  | { status: 'succeeded'; summary: string; requestId?: string }
  | { status: 'failed'; error: string }
  | { status: 'drifted'; changes: string[] }

export interface ProposalRecord {
  /** The adapter that planned it (a generic one is built per proposal, so it is kept, not looked up again). */
  adapter: ChangeAdapter
  id: string
  conversationId: string
  appAccountId: string
  awsAccountId: string
  accountName: string
  /** The account's login (index.ts `identity`): if it changes, the proposal no longer holds. */
  identity: string
  region: string
  service: string
  action: string
  /** Frozen; the only params ever executed. */
  params: Readonly<Record<string, unknown>>
  /** Dedupe key: the model's input as given. */
  inputKey: string
  hash: string
  reason: string
  createdAt: number
  expiresAt: number
  plan: Plan
  risk: Risk
  reasons: string[]
  production: boolean
  /** Canonical drift projection of the snapshot taken at proposal time. */
  baseline: string
  confirmText?: string
  /** One-time; null once confirmed, cancelled or expired. Never leaves this module. */
  nonce: string | null
  state: ProposalState
  outcome?: string
  finishedAt?: number
  view: ProposalView
  /** What the card is built from: the analysis rebuilds it with its block and the risk it may have raised. */
  cardInput: ProposalCardInput
  /** The AI impact analysis (generic proposals, when on). Advisory: it never touches params or hash. `stop` ends it with the proposal. */
  analysis?: {
    status: 'running' | 'done' | 'failed'
    calls: number
    startedAt: number
    error?: string
    result?: AnalysisResult
    raised?: { from: Risk; to: Risk }
    stop: AbortController
  }
}

export type AnalysisOutcome = { ok: true; result: AnalysisResult; calls: number } | { ok: false; reason: string; calls: number }

const analysisBlock = (a: ProposalRecord['analysis']): AnalysisBlockData | undefined =>
  a && { type: 'analysis', status: a.status, calls: a.calls, ...(a.error && { error: a.error }), ...(a.result && { result: a.result }), ...(a.raised && { raised: a.raised }) }

export interface EngineDeps {
  aws: (accountId: string, service: string, action: string, params: Record<string, unknown>, region: string) => Promise<unknown>
  account: (id: string) => AwsAccount | undefined
  audit: (type: string, accountId: string, data: Record<string, unknown>) => void
  /** A proposal changed state (not on creation: the tool result carries that). */
  onState: (p: ProposalRecord) => void
  /** Generic changes: whether the app can make the call at all (no card for one that could never run). */
  supports?: AwsSupports
  /** Generic EC2 changes: the operation's input members (DryRun only when it has one). Absent: no DryRun. */
  inputMembers?: AwsInputMembers
  now?: () => number
}

/** Same fields as index.ts `identity`: what a login is for. */
export const loginIdentity = (a: AwsAccount): string => [a.accountId, a.role, a.viaId, a.command].join('|')

/**
 * Why the account's AI policy refuses a change on `service` (at `risk`, once known), or null. Checked when the
 * proposal is made, when it is confirmed and right before it runs, against the account as it is at that moment.
 */
export function policyProblem(a: AwsAccount | undefined, service: string, risk?: Risk): string | null {
  if (a?.aiAllowWrite !== true) return '这个账号现在是只读模式'
  // A service without an adapter is governed by the "其他服务" entry; one with an adapter by its own, generic or not.
  const entry = AI_CHANGE_SERVICES.some((s) => s.id === service && s.id !== OTHER_SERVICES) ? service : OTHER_SERVICES
  if (a.aiServices && !a.aiServices.includes(entry)) {
    return `这个账号的 AI 策略不允许对 ${service} 提出变更（${entry === OTHER_SERVICES ? '没有勾选「其他服务」；' : ''}账号设置 → AI 策略）`
  }
  if (risk && a.aiMaxRisk && RISKS.indexOf(risk) > RISKS.indexOf(a.aiMaxRisk)) {
    return `风险「${RISK_LABEL[risk]}」超过了这个账号允许的上限「${RISK_LABEL[a.aiMaxRisk]}」（账号设置 → AI 策略）`
  }
  return null
}

/**
 * The IAM principal behind GetCallerIdentity's ARN, for SimulatePrincipalPolicy: users as they are, an assumed role
 * as its role (a role with a path is not found, and the pre-check says it could not run). Root and federated
 * users can't be simulated.
 */
export function principalArn(callerArn: string | undefined): string | null {
  const m = /^arn:(aws[a-z-]*):(iam|sts)::(\d{12}):(.+)$/.exec(callerArn ?? '')
  if (!m) return null
  const [, partition, kind, account, rest] = m
  if (kind === 'iam' && rest.startsWith('user/')) return callerArn as string
  const role = kind === 'sts' ? /^assumed-role\/([\w+=,.@-]{1,64})\//.exec(rest)?.[1] : undefined
  return role ? `arn:${partition}:iam::${account}:role/${role}` : null
}

const hashOf = (p: ProposalRecord): string =>
  `sha256:${createHash('sha256')
    .update(
      canonical({
        v: 1,
        id: p.id,
        conversationId: p.conversationId,
        appAccountId: p.appAccountId,
        awsAccountId: p.awsAccountId,
        identity: p.identity,
        region: p.region,
        service: p.service,
        action: p.action,
        params: p.params,
        expiresAt: p.expiresAt,
        confirmText: p.confirmText ?? null
      })
    )
    .digest('hex')}`

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x)
    Object.freeze(v)
  }
  return v
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

const STATE_ERRORS: Record<Exclude<ProposalState, 'pending'>, string> = {
  executing: '这个提案正在执行',
  succeeded: '这个提案已经执行过了',
  failed: '这个提案已经执行过（失败），请让助手重新生成',
  cancelled: '这个提案已取消',
  expired: '提案已过期，请让助手重新生成',
  superseded: '这个提案已作废，请让助手重新生成'
}

/** A refusal the model is told as is; `why` is the audit row's cause. */
class Refused extends Error {
  constructor(
    message: string,
    readonly why = 'precheck'
  ) {
    super(message)
  }
}

export class ProposalEngine {
  private proposals = new Map<string, ProposalRecord>()
  /** Per conversation: when proposals were attempted (rate limit). */
  private attempts = new Map<string, number[]>()

  constructor(private d: EngineDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)()
  }

  /** AWS calls for an account and region. `guarded`: before confirmation, so no write can get through. */
  private ctx(accountId: string, region: string, proposalId: string, guarded: boolean): ChangeCtx {
    return {
      region,
      proposalId,
      call: async (service, action, params, at) => {
        if (guarded) {
          const key = `${service}:${action}`
          const read = classifyAction(service, action).class === 'read' || ADAPTER_READS.has(key)
          // Only EC2 honours DryRun; elsewhere the SDK would drop the flag and send the write for real.
          const dryRun = service === 'ec2' && params.DryRun === true
          if (!read && !dryRun && !PLAN_CALLS.has(key)) throw new Error(`内部错误：确认之前不能发送写请求（${key}）`)
        }
        return this.d.aws(accountId, service, action, params, at ?? region)
      }
    }
  }

  private audit(p: { appAccountId: string; conversationId: string }, type: string, data: Record<string, unknown>): void {
    this.d.audit(type, p.appAccountId, { conversationId: p.conversationId, ...data })
  }

  /**
   * A proposal from the model's propose_change input. Throws a message for the model when it is refused; nothing
   * is written to AWS either way. `reused`: the same proposal is already pending, so no new card. `analyze`: a generic
   * proposal starts with its impact analysis running (the caller runs it: `record.analysis.stop` is its signal).
   */
  async propose(
    c: { accountId: string; conversationId: string; region: string },
    input: ProposeInput,
    opts: { analyze?: boolean } = {}
  ): Promise<{ view: ProposalView; reused: boolean }> {
    const account = this.d.account(c.accountId)
    if (!account) throw new Error('账号不存在')
    const service = String(input.service ?? '')
    const action = String(input.action ?? '')
    const base = { appAccountId: account.id, conversationId: c.conversationId }
    const refuse = (type: string, reason: string, extra: Record<string, unknown> = {}): never => {
      this.audit(base, type, { service, action, actor: 'model', reason: reason.slice(0, 300), ...extra })
      throw new Refused(reason)
    }
    if (account.aiAllowWrite !== true) refuse('proposal_refused', READ_ONLY_MESSAGE, { cause: 'policy' })
    const found = lookupChange(service, action)
    if ('refused' in found) return refuse('proposal_refused', found.reason, { cause: found.refused })
    const notAllowed = policyProblem(account, service)
    if (notAllowed) refuse('proposal_refused', `${notAllowed}。请告诉用户，需要时在 Console 里操作。`, { cause: 'policy' })
    const params = input.params ?? {}
    if (!isPlainObject(params)) return refuse('proposal_refused', 'params 必须是对象', { cause: 'invalid' })
    if (canonical(params).length > 60_000) refuse('proposal_refused', 'params 太大', { cause: 'invalid' })
    // An adapter's forbidden param (a privilege-escalation or code-execution path it won't model) is not refused: the
    // change goes to the generic card as a strong approval, which shows every param as it will be sent.
    // On the banner as a neutral fact (the adapter's own wording is a refusal for the model, not a prediction).
    const forbidden = 'adapter' in found ? Object.keys(params).flatMap((k) => (found.adapter.forbiddenParams?.[k] ? [`参数 ${k}：专用适配器不处理这个参数`] : [])) : []
    let a: ChangeAdapter = 'adapter' in found && !forbidden.length ? found.adapter : genericAdapter(service, action, params, { ownRole: account.role, extra: forbidden })
    if (a.generic && service === 'ec2') a = { ...a, dryRun: (await this.d.inputMembers?.(service, action))?.includes('DryRun') === true }
    if (a.generic) {
      // Pretty-printed on the card in full: kept well inside the card's size limit.
      if (canonical(params).length > 20_000) refuse('proposal_refused', '通用请求的 params 太大（上限 20000 字符）', { cause: 'invalid' })
      const unsupported = (await this.d.supports?.(service, action)) ?? null
      if (unsupported) refuse('proposal_refused', unsupported, { cause: 'unsupported' })
    }
    if (!Value.Check(a.schema, params)) {
      const errors = [...Value.Errors(a.schema, params)].slice(0, 8).map((e: any) => `${e.instancePath || '/'}: ${e.message}`)
      refuse('proposal_refused', `参数无效（${service}:${action} 的参数：${a.doc}）：\n- ${errors.join('\n- ')}`, { cause: 'invalid' })
    }
    const reason = typeof input.reason === 'string' ? input.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) : ''
    const requested = typeof input.region === 'string' && input.region.trim() ? input.region.trim() : null
    if (requested && !REGION_IDS.has(requested)) refuse('proposal_refused', `不支持的 region：${requested}`, { cause: 'invalid' })

    this.sweep()
    const now = this.now()
    const mine = [...this.proposals.values()].filter((p) => p.conversationId === c.conversationId && p.state === 'pending')
    const inputKey = canonical({ service, action, params, region: requested })
    const same = mine.find((p) => p.inputKey === inputKey)
    if (same) return { view: same.view, reused: true }
    if (mine.length >= PROPOSAL_LIMITS.maxPending) {
      refuse('proposal_refused', `这个对话已有 ${mine.length} 个提案等待确认（上限 ${PROPOSAL_LIMITS.maxPending}）。请等用户确认或取消后再提。`, { cause: 'rate' })
    }
    const recent = (this.attempts.get(c.conversationId) ?? []).filter((t) => now - t < 60_000)
    if (recent.length >= PROPOSAL_LIMITS.perMinute) refuse('proposal_refused', `提案太频繁（每分钟最多 ${PROPOSAL_LIMITS.perMinute} 个），请稍后再试`, { cause: 'rate' })
    this.attempts.set(c.conversationId, [...recent, now])

    const id = `p-${randomBytes(6).toString('hex')}`
    let ctx = this.ctx(account.id, requested ?? c.region, id, true)
    let p: Record<string, unknown> = structuredClone(params)
    let prepared = false
    try {
      if (a.locate) ctx = this.ctx(account.id, await a.locate(p, ctx.call), id, true)
      if (!REGION_IDS.has(ctx.region)) throw new Refused(`不支持的 region：${ctx.region}`)
      p = a.normalize ? a.normalize(p, ctx) : p
      if (a.prepare) {
        prepared = true
        await a.prepare(p, ctx)
      }
      const snapshot = await a.snapshot(p, ctx)
      const plan = a.plan(p, snapshot)
      // Blockers quote AWS data (Name tags…): fenced like any tool result, so it reads as data, not instructions.
      if (plan.blockers?.length) throw new Refused(`现在不能提出这个变更，原因如下：\n${fence(`${service}:${action}`, ctx.region, JSON.stringify(plan.blockers))}`)
      const dryRun = a.dryRun ? await this.dryRun(a, p, snapshot, ctx) : a.prepare ? 'change set 已创建（只是计划，还没执行）' : await this.simulate(a, p, ctx, account.accountId)

      let risk = plan.risk
      const reasons = [...plan.reasons]
      if (plan.tags?.some(isProdTagged)) {
        risk = bump(risk)
        reasons.push('资源带生产环境标签（env=prod 等），风险升一级')
      }
      const production = account.production === true
      if (production) {
        risk = bump(risk)
        reasons.push('生产账号，风险升一级')
      }
      // The ceiling applies to the risk after escalation: on a production account it bites one level earlier.
      const ceiling = policyProblem(account, service, risk)
      if (ceiling) throw new Refused(`${ceiling}。这个变更（${plan.title}）不能由助手提出，请告诉用户需要时在 Console 里操作。`, 'policy')
      const expiresAt = now + PROPOSAL_LIMITS.ttlMs
      // Strong approval on a production account: the account id is typed too.
      const confirmText = a.generic?.tier === 'C' && production ? `${plan.confirmText}@${account.accountId}` : plan.confirmText
      const record: ProposalRecord = {
        adapter: a,
        id,
        conversationId: c.conversationId,
        appAccountId: account.id,
        awsAccountId: account.accountId,
        accountName: account.name,
        identity: loginIdentity(account),
        region: ctx.region,
        service,
        action,
        params: deepFreeze(p),
        inputKey,
        hash: '',
        reason,
        createdAt: now,
        expiresAt,
        plan,
        risk,
        reasons,
        production,
        baseline: canonical(a.drift ? a.drift(snapshot) : snapshot),
        ...((needsTyped(risk, production) || a.generic) && { confirmText }),
        nonce: randomBytes(16).toString('hex'),
        state: 'pending',
        view: undefined as unknown as ProposalView,
        cardInput: undefined as unknown as ProposalCardInput,
        ...(opts.analyze && a.generic && { analysis: { status: 'running' as const, calls: 0, startedAt: now, stop: new AbortController() } })
      }
      record.hash = hashOf(record)
      record.cardInput = {
        id,
        title: plan.title,
        risk,
        reasons,
        change: plan.change,
        where: `${account.name} · ${ctx.region}`,
        consequences: plan.consequences,
        facts: [
          { label: '账号', value: `${account.name}（${account.accountId}）${production ? ' · 生产' : ''}` },
          { label: 'Region', value: ctx.region },
          { label: '操作', value: `${service}:${action}` },
          { label: '预检', value: dryRun },
          ...(a.generic ? [{ label: '漂移检查', value: '不适用：通用请求没有变更前快照，确认时不会核对资源状态' }] : []),
          ...(reason ? [{ label: '助手给出的理由', value: reason }] : []),
          { label: '提案', value: `${id} · ${record.hash.slice(0, 19)}…` }
        ],
        createdAt: now,
        expiresAt
      }
      record.view = this.viewOf(record, this.cardOf(record))
      this.proposals.set(id, record)
      this.audit(record, 'proposal_created', {
        proposalId: id,
        hash: record.hash,
        service,
        action,
        region: ctx.region,
        risk,
        targets: plan.targets,
        params: this.auditParams(a, p),
        dryRun,
        typedRequired: record.confirmText !== undefined,
        ...(a.generic && { generic: true, tier: a.generic.tier, dangers: a.generic.dangers }),
        ...(record.analysis && { analysis: true }),
        actor: 'model'
      })
      return { view: record.view, reused: false }
    } catch (err) {
      if (prepared && a.discard) await a.discard(p, ctx).catch(() => {})
      const message = err instanceof Refused ? err.message : `预检失败，没有生成提案：${awsError(err)}`
      this.audit(base, 'proposal_refused', { service, action, actor: 'model', cause: err instanceof Refused ? err.why : 'aws', reason: message.slice(0, 300) })
      throw new Error(message)
    }
  }

  /** EC2 DryRun: DryRunOperation means "would succeed". Anything else stops the proposal. */
  private async dryRun(a: ChangeAdapter, p: Record<string, unknown>, snapshot: unknown, ctx: ChangeCtx): Promise<string> {
    // No idempotency token on the dry run: the real request must not find it already used.
    const { ClientToken: _token, ...request } = a.request ? a.request(p, snapshot) : p
    try {
      await ctx.call(a.service, a.action, { ...request, DryRun: true })
    } catch (err) {
      const name = (err as { name?: string }).name
      if (name === 'DryRunOperation') return 'DryRun 通过：权限和参数有效'
      if (name === 'UnauthorizedOperation') throw new Refused(`当前 role 没有 ${a.service}:${a.action} 权限（DryRun 被拒绝）`)
      throw new Refused(`DryRun 失败：${awsError(err)}`)
    }
    // A DryRun that "succeeded" was not a dry run: stop rather than guess what happened.
    throw new Refused('DryRun 没有返回预期结果，已停止')
  }

  /**
   * Stand-in for DryRun on services without one: iam:SimulatePrincipalPolicy for the caller's role. Read-only and one
   * call; any problem (no iam permission, a role with a path, root) is a notice on the card, never a refusal, and a
   * deny is a warning: the simulation has no resource policies or request context, so AWS may still decide otherwise.
   */
  private async simulate(a: ChangeAdapter, p: Record<string, unknown>, ctx: ChangeCtx, account: string): Promise<string> {
    const fallback = '这个服务没有 DryRun：已读取当前状态并按规则检查'
    const actions = a.iamActions ?? [`${a.service}:${a.action}`]
    try {
      const who = (await ctx.call('sts', 'GetCallerIdentity', {}, 'us-east-1')) as { Arn?: string }
      const principal = principalArn(who?.Arn)
      if (!principal) return `${fallback}；无法预检权限（当前凭证不是 IAM 用户或角色）`
      const resources = a.arns?.(p, { region: ctx.region, account }) ?? ['*']
      const r = (await ctx.call('iam', 'SimulatePrincipalPolicy', { PolicySourceArn: principal, ActionNames: actions, ResourceArns: resources }, 'us-east-1')) as {
        EvaluationResults?: { EvalActionName?: string; EvalDecision?: string }[]
      }
      const results = r?.EvaluationResults ?? []
      if (!results.length) return `${fallback}；无法预检权限（模拟没有返回结果）`
      const denied = results.filter((e) => e.EvalDecision !== 'allowed').map((e) => `${e.EvalActionName ?? '?'}（${e.EvalDecision ?? '?'}）`)
      return denied.length
        ? `⚠ 权限预检：当前 role 可能没有 ${denied.join('、')}，执行时可能被拒绝（模拟不含资源策略和请求条件，仅供参考）`
        : `权限预检通过（IAM 策略模拟：${actions.join('、')}）；这个服务没有 DryRun，参数在执行时才由 AWS 校验`
    } catch (err) {
      const name = (err as { name?: string }).name
      return `${fallback}；无法预检权限（${name === 'AccessDenied' || name === 'AccessDeniedException' ? '没有 iam:SimulatePrincipalPolicy 权限' : awsError(err).slice(0, 120)}）`
    }
  }

  private auditParams(a: ChangeAdapter, p: Record<string, unknown>): string {
    const s = JSON.stringify(scrub(a.redact ? a.redact(p) : p)) ?? ''
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s
  }

  private viewOf(p: ProposalRecord, card = p.view.card): ProposalView {
    return {
      id: p.id,
      state: p.state,
      title: p.plan.title,
      risk: p.risk,
      accountName: p.accountName,
      awsAccountId: p.awsAccountId,
      region: p.region,
      production: p.production,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      ...(p.confirmText !== undefined && { confirmText: p.confirmText }),
      card,
      ...(p.outcome && { outcome: p.outcome }),
      ...(p.adapter.generic && { generic: true, tier: p.adapter.generic.tier, dangers: p.adapter.generic.dangers }),
      ...(p.analysis && { analysis: { status: p.analysis.status, calls: p.analysis.calls } })
    }
  }

  private cardOf(p: ProposalRecord) {
    return proposalCard({ ...p.cardInput, risk: p.risk, reasons: p.reasons, analysis: analysisBlock(p.analysis) })
  }

  /** The analysis made `calls` AWS calls so far: the skeleton's count. */
  analysisProgress(id: string, calls: number): void {
    const p = this.proposals.get(id)
    if (p?.state !== 'pending' || p.analysis?.status !== 'running' || p.analysis.calls === calls) return
    p.analysis.calls = calls
    p.view = this.viewOf(p, this.cardOf(p))
    this.d.onState(p)
  }

  /**
   * The analysis ended. Done: its result goes on the card, and its suggested risk replaces the proposal's only when
   * higher (the rules' floor, production escalation included, stays; params and hash are never touched; the account's
   * risk ceiling then applies at confirm as for any risk). Failed: the reason goes on the card. Either way confirm no
   * longer waits. Audited with a hash of the result, not its content. A proposal no longer pending keeps its card.
   */
  finishAnalysis(id: string, outcome: AnalysisOutcome): void {
    const p = this.proposals.get(id)
    const a = p?.analysis
    if (!p || !a) return
    const base = { proposalId: id, hash: p.hash, calls: outcome.calls, ms: this.now() - a.startedAt }
    // The proposal ended first (finish stopped the analysis and said so on the card).
    if (p.state !== 'pending' || a.status !== 'running') return this.audit(p, 'proposal_analysis', { ...base, status: 'aborted' })
    a.calls = outcome.calls
    if (outcome.ok) {
      a.status = 'done'
      a.result = outcome.result
      const to = outcome.result.risk.level
      if (RISKS.indexOf(to) > RISKS.indexOf(p.risk)) {
        a.raised = { from: p.risk, to }
        p.reasons = [...p.reasons, `AI 影响分析建议把风险提高到「${RISK_LABEL[to]}」：${outcome.result.risk.reasons[0] ?? outcome.result.summary}`]
        p.risk = to
      }
    } else {
      a.status = 'failed'
      a.error = outcome.reason.slice(0, 300)
    }
    this.audit(p, 'proposal_analysis', {
      ...base,
      status: a.status,
      ...(outcome.ok
        ? { analysisHash: `sha256:${createHash('sha256').update(canonical(outcome.result)).digest('hex').slice(0, 16)}`, suggested: outcome.result.risk.level, confidence: outcome.result.confidence }
        : { cause: outcome.reason.slice(0, 120) }),
      ...(a.raised && { riskRaised: a.raised })
    })
    p.view = this.viewOf(p, this.cardOf(p))
    this.d.onState(p)
  }

  private finish(p: ProposalRecord, state: ProposalState, outcome: string): void {
    // The analysis ends with the proposal; its card says so instead of a skeleton that never resolves.
    p.analysis?.stop.abort()
    if (p.analysis?.status === 'running') {
      p.analysis.status = 'failed'
      p.analysis.error = '提案已结束，分析已停止'
      p.view = this.viewOf(p, this.cardOf(p))
    }
    p.state = state
    p.nonce = null
    p.outcome = outcome.slice(0, 500)
    p.finishedAt = this.now()
    p.view = this.viewOf(p)
    this.d.onState(p)
  }

  private discard(p: ProposalRecord): void {
    if (p.adapter.discard) void p.adapter.discard(p.params, this.ctx(p.appAccountId, p.region, p.id, true)).catch(() => {})
  }

  view(id: string): ProposalView | undefined {
    return this.proposals.get(id)?.view
  }

  get(id: string): ProposalRecord | undefined {
    return this.proposals.get(id)
  }

  private owned(accountId: string, conversationId: string, id: string): ProposalRecord {
    const p = this.proposals.get(id)
    if (!p || p.appAccountId !== accountId || p.conversationId !== conversationId) throw new Error('提案不存在（可能已过期，或应用重启过）')
    return p
  }

  /**
   * The user's confirmation. Throws a message (and leaves the proposal as it is, or marks why it is gone) when the
   * proposal can't run; otherwise runs it and resolves with what happened.
   */
  async confirm(accountId: string, conversationId: string, id: string, typed?: string): Promise<Outcome> {
    this.sweep()
    const p = this.owned(accountId, conversationId, id)
    if (p.state !== 'pending') throw new Error(STATE_ERRORS[p.state])
    const reject = (cause: string, message: string): never => {
      this.audit(p, 'confirm_rejected', { proposalId: id, cause, actor: 'user' })
      throw new Error(message)
    }
    if (hashOf(p) !== p.hash) {
      this.finish(p, 'cancelled', '提案内容校验失败，已作废')
      this.audit(p, 'proposal_tampered', { proposalId: id, hash: p.hash })
      this.discard(p)
      throw new Error('提案内容校验失败，已作废。请让助手重新生成')
    }
    if (p.analysis?.status === 'running') reject('analysis', '影响分析还没完成，请稍等（最多 90 秒）')
    if (p.confirmText !== undefined && (typed ?? '').trim() !== p.confirmText) reject('typed', `输入的内容和「${p.confirmText}」不一致`)
    const account = this.d.account(accountId)
    const problem = policyProblem(account, p.service, p.risk)
    if (problem) reject('policy', `${problem}，提案不能执行`)
    if (loginIdentity(account as AwsAccount) !== p.identity || (account as AwsAccount).accountId !== p.awsAccountId) {
      this.finish(p, 'superseded', '账号的登录配置变了，提案作废')
      this.discard(p)
      reject('identity', '账号的登录配置在提案之后改过了，提案已作废')
    }
    // Marked production since: the risk and the typing it asked for were worked out for another account.
    if (((account as AwsAccount).production === true) !== p.production) {
      this.finish(p, 'superseded', '账号的「生产账号」设置变了，提案作废')
      this.discard(p)
      reject('production', '账号的「生产账号」设置在提案之后改过了，风险需要重新评估。提案已作废，请让助手重新生成')
    }
    if (p.nonce === null) throw new Error(STATE_ERRORS.executing)
    // The one-time step, before any await: a second click (or a racing call) finds the nonce gone and the state moved.
    p.nonce = null
    p.state = 'executing'
    p.view = this.viewOf(p)
    this.d.onState(p)
    this.audit(p, 'proposal_confirmed', { proposalId: id, hash: p.hash, risk: p.risk, typed: p.confirmText !== undefined, actor: 'user' })

    const a = p.adapter
    const guarded = this.ctx(accountId, p.region, id, true)
    const drifted = (changes: string[], cause: string): Outcome => {
      this.finish(p, 'superseded', `没有执行：${changes[0] ?? '状态已变化'}`)
      this.audit(p, 'proposal_drift', { proposalId: id, cause, changes: changes.slice(0, 10) })
      this.discard(p)
      return { status: 'drifted', changes }
    }
    try {
      const who = (await this.d.aws(accountId, 'sts', 'GetCallerIdentity', {}, 'us-east-1')) as { Account?: string }
      if (who?.Account !== p.awsAccountId) return drifted([`当前凭证属于账号 ${who?.Account ?? '?'}，不是提案的 ${p.awsAccountId}`], 'identity')
      const fresh = await a.snapshot(p.params, guarded)
      const now = canonical(a.drift ? a.drift(fresh) : fresh)
      if (now !== p.baseline) {
        const lines = fieldDiff(JSON.parse(p.baseline) as Record<string, unknown>, JSON.parse(now) as Record<string, unknown>)
        return drifted(lines.slice(0, 20).map((l) => `${l.path}：${l.before ?? '∅'} → ${l.after ?? '∅'}`), 'drift')
      }
      const again = this.d.account(accountId)
      if (policyProblem(again, p.service, p.risk) || loginIdentity(again as AwsAccount) !== p.identity || (again?.production === true) !== p.production) {
        return drifted(['账号策略或登录配置在确认期间变了'], 'policy')
      }
      const started = this.now()
      const exec = this.ctx(accountId, p.region, id, false)
      const response = a.execute ? await a.execute(p.params, fresh, exec) : await exec.call(a.service, a.action, a.request ? a.request(p.params, fresh) : { ...p.params })
      const requestId = requestIdOf(response)
      let summary = ''
      try {
        summary = a.verify ? await a.verify(p.params, guarded, response) : ''
      } catch {
        summary = '已提交（读取执行后的状态失败）'
      }
      summary = summary || '已提交'
      this.finish(p, 'succeeded', summary)
      this.audit(p, 'proposal_executed', { proposalId: id, hash: p.hash, service: p.service, action: p.action, status: 'succeeded', requestId, ms: this.now() - started, summary: summary.slice(0, 300), actor: 'user' })
      return { status: 'succeeded', summary, ...(requestId && { requestId }) }
    } catch (err) {
      const error = awsError(err)
      this.finish(p, 'failed', error)
      this.audit(p, 'proposal_failed', { proposalId: id, hash: p.hash, service: p.service, action: p.action, status: 'failed', error: error.slice(0, 300), actor: 'user' })
      this.discard(p)
      return { status: 'failed', error }
    }
  }

  cancel(accountId: string, conversationId: string, id: string): ProposalRecord {
    this.sweep()
    const p = this.owned(accountId, conversationId, id)
    if (p.state !== 'pending') throw new Error(STATE_ERRORS[p.state])
    this.finish(p, 'cancelled', '用户取消了')
    this.audit(p, 'proposal_cancelled', { proposalId: id, hash: p.hash, actor: 'user' })
    this.discard(p)
    return p
  }

  /** Expires pending proposals past their TTL; forgets finished ones after a day. */
  sweep(): void {
    const now = this.now()
    for (const p of this.proposals.values()) {
      if (p.state === 'pending' && now > p.expiresAt) {
        this.finish(p, 'expired', '超过 10 分钟没有确认，已过期')
        this.audit(p, 'proposal_expired', { proposalId: p.id, hash: p.hash })
        this.discard(p)
      } else if (p.finishedAt !== undefined && now - p.finishedAt > PROPOSAL_LIMITS.keepFinishedMs) this.proposals.delete(p.id)
    }
    for (const [c, times] of this.attempts) {
      const recent = times.filter((t) => now - t < 60_000)
      if (recent.length) this.attempts.set(c, recent)
      else this.attempts.delete(c)
    }
  }

  pendingCount(conversationId: string): number {
    return [...this.proposals.values()].filter((p) => p.conversationId === conversationId && p.state === 'pending').length
  }

  /** The conversation is gone: its pending proposals with it (an executing one finishes; its result has nowhere to go). */
  forgetConversation(conversationId: string): void {
    for (const p of this.proposals.values()) {
      if (p.conversationId !== conversationId) continue
      p.analysis?.stop.abort()
      if (p.state === 'pending') {
        p.state = 'cancelled'
        p.nonce = null
        this.audit(p, 'proposal_cancelled', { proposalId: p.id, cause: 'conversation-deleted' })
        this.discard(p)
      }
      if (p.state !== 'executing') this.proposals.delete(p.id)
    }
    this.attempts.delete(conversationId)
  }

  /** Every conversation is gone ("删除全部 AI 数据"). */
  forgetAll(): void {
    for (const id of new Set([...this.proposals.values()].map((p) => p.conversationId))) this.forgetConversation(id)
    this.attempts.clear()
  }
}
