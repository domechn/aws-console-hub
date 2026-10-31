import { randomUUID } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Model, MutableModels } from '@earendil-works/pi-ai'
import { BEDROCK_PROVIDER_ID, CUSTOM_PROVIDER_ID, DELETE_AUDIT_PHRASE, scriptCalls, scriptCode, toolLabel, type AiBudget, type AuditFilter, type AuditView, type MonthUsage } from '../../shared/ai'
import { CARD_ACTION_PREFIX, PROPOSAL_RESULT_PREFIX, type Card, type FormValues } from '../../shared/cards'
import type {
  AiConfigView,
  AiEvent,
  AiEventEnvelope,
  AiModelInfo,
  AiSendResult,
  AiTestResult,
  ConversationSummary,
  PageContext,
  ConversationView,
  ProposalView,
  ApprovalDecision,
  ApprovalView,
  SessionAllowView,
  SetKeyResult,
  UsageTotals,
  ResourceContext,
  ResourceCandidate,
  QueuedMessage,
  ConversationSearchResult
} from '../../shared/ai'
import type { AwsAccount, RecentResource } from '../../shared/types'
import type { AwsCredentials } from '../credentialCommand'
import { runImpactAnalysis } from './analysis'
import { createdIndex, filterAudit, summarize } from './auditDigest'
import { ApprovalStore, type ApprovalRequest, type Verdict } from './approvals'
import type { AwsCall, AwsInputMembers, AwsSupports } from './aws'
import { explainBedrockError } from './bedrock'
import { buildModelCard, cardActionLabel, cardActionText, checkCardAction, parseCardAction } from './cards'
import { parseProposalResult, proposalResultText, resultCard, type ProposalResult } from './changes/card'
import { ProposalEngine, type AnalysisOutcome } from './changes/engine'
import { changeCatalog } from './changes/registry'
import type { AiConfigStore } from './config'
import { compactContext, mergeUserTurns } from './context'
import type { AiStore } from './db'
import { ANSWER_REQUEST, hasAnswer, LIMIT_NOTE, LIMIT_REQUEST, sumUsage, textOf, toChatItems, transcriptCards, type StoredAgentMessage } from './history'
import type { KeyStore } from './keystore'
import { pageContext, type PageRead } from './page'
import { buildSystemPrompt } from './prompt'
import { createAppAgent, listModels, resolveModel, testModel } from './providers'
import { redactSecrets } from './redact'
import { resourceCandidates, resolveResources, resourcePromptSection } from './resources'
import { checkReplies } from './replies'
import { displayParams } from './shape'
import { buildCardTool, buildPageTool, buildProposeTool, buildReadTools, buildRepliesTool, MAX_COST_CALLS } from './tools'
import { checkPrompt, checkUserIndex, checkResourceContext, checkSearchQuery } from './validate'

/** Per user message (plan §9.8). */
export const LIMITS = {
  /** Tool calls; past this they are blocked and the run lands (one last round without tools). */
  maxToolCalls: 40,
  /** LLM round trips that end in tool calls; then the run lands. Room for a list plus a describe per item. */
  maxTurns: 20,
  /** Whole run, LLM and tools; then it is aborted. Time on an approval card does not count. */
  runTimeoutMs: 5 * 60_000,
  /** Less than this left on the clock after a round: the run lands instead of starting another. */
  landingMs: 30_000,
  /** Share of the model's context window the transcript may fill (§6). */
  contextShare: 0.6,
  /** propose_change calls per user message (the engine has its own per-conversation limits). */
  maxProposals: 3,
  /** Approval cards per user message (approvals.ts has its own per-account and per-minute limits). */
  maxApprovals: 3
}

const RISK_LABEL = { low: '低', medium: '中', high: '高', destructive: '破坏性' } as const

export interface AiServiceDeps {
  store: AiStore
  config: AiConfigStore
  keys: Pick<KeyStore, 'get' | 'has' | 'set' | 'delete' | 'canPersist'>
  models: MutableModels
  account: (id: string) => AwsAccount | undefined
  /** One AWS call with the account's credentials (main's credential pipeline; never seen by the model or renderer). */
  aws: (accountId: string, ...call: Parameters<AwsCall>) => ReturnType<AwsCall>
  /** Whether a call can be made at all (aws.ts); asked before an approval or generic change card. Absent: always. */
  awsSupports?: AwsSupports
  /** An operation's input members (aws.ts): generic EC2 changes DryRun only when there is a DryRun member. */
  awsInputMembers?: AwsInputMembers
  /** The same pipeline's credentials, for Bedrock in account mode: handed to pi per request, never stored or sent out. */
  credentials: (accountId: string) => Promise<AwsCredentials>
  /** Region the account's console tab is in, or its default. */
  regionFor: (accountId: string) => string
  /** The account's active tab: URL and title only (page.ts decides what of it the model gets). */
  activePage: (accountId: string) => { url: string; title: string } | null
  recents?: () => RecentResource[]
  /** read_current_page: the on-screen tab's text, refused unless it is a console page of this account. */
  readPage: (accountId: string) => Promise<PageRead>
  emit: (e: AiEventEnvelope) => void
  /** A card's open-console button: the console:navigate path (console URLs only, federation when needed). */
  openConsole: (accountId: string, url: string) => void | Promise<void>
  toast: (message: string) => void
  runKeyCommand: (command: string) => Promise<string>
  now?: () => Date
}

interface Run {
  runId: number
  accountId: string
  agent?: { abort(): void }
  aborted: boolean
  finished: Promise<void>
  finish: () => void
}

interface Resolved {
  model: Model<any>
  apiKey: string | undefined
  /** Provider error → what to do about it (Bedrock's IAM / model access / profile errors); others pass through. */
  explain: (message: string) => string
}

/**
 * A turn main starts itself, waiting for the run in progress. card: a card button's reply (`label` is how the panel
 * shows it). result: a proposal's [proposal_result]; `silent` ones are only stored (the model reads them next time).
 */
type QueuedTurn = { kind: 'card'; cardId: string; text: string; label: string } | { kind: 'result'; text: string; silent: boolean } | { kind: 'user'; id: string; text: string; context?: ResourceContext; resources?: ResourceCandidate[] }
type CardTurn = Extract<QueuedTurn, { kind: 'card' }>

const titleFrom = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 40)

const compact = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

/**
 * The monthly budget's verdict: a warning from 80% of a limit, blocked past one when the budget blocks. Tokens are
 * input + output. Replies without a catalog price are not in the cost, which the warning says.
 */
export function budgetVerdict(b: AiBudget, t: UsageTotals): Pick<MonthUsage, 'budget' | 'blocked'> {
  const parts: string[] = []
  let over = false
  const check = (used: number, limit: number | null, show: (n: number) => string, note = ''): void => {
    if (!limit || used < limit * 0.8) return
    over ||= used >= limit
    parts.push(`${show(used)} / ${show(limit)}${note}`)
  }
  check(t.input + t.output, b.monthlyTokens, (n) => `${compact(n)} token`)
  check(t.cost, b.monthlyUsd, (n) => `$${n.toFixed(2)}`, t.costUnknown ? '（不含价格未知的模型）' : '')
  if (!parts.length) return { budget: null, blocked: false }
  const blocked = over && b.block
  return { budget: `${over ? '已超出' : '接近'}本月 AI 预算：${parts.join('，')}${blocked ? '。新的提问已暂停，可在 AI 设置里调整预算' : ''}`, blocked }
}

/**
 * Chat runs, main process only: pi Agent per user message over the stored transcript, tools bound to the
 * conversation's account, events out to the renderer as display data. One run per conversation at a time.
 * Changes go through `engine`: the model can only propose, the panel's confirm button is the only way to execute.
 */
export class AiService {
  readonly engine: ProposalEngine
  readonly approvals: ApprovalStore
  private runs = new Map<string, Run>()
  private nextRunId = 1
  /** Keys printed by the key command, per provider: run once per app run. */
  private commandKeys = new Map<string, string>()
  private costBudgets = new Map<string, { left: number }>()
  /** Per conversation: cards whose reply click was accepted but whose [card_action] turn is not stored yet. */
  private pendingCards = new Map<string, Set<string>>()
  /** Per conversation: card replies clicked while a run was going; each becomes the next turn. */
  private queued = new Map<string, QueuedTurn[]>()
  private queueEpoch = new Map<string, number>()
  private pendingSetup = new Map<string, { cancel: (reason: string) => void; finished: Promise<void> }>()
  private regenerating = new Set<string>()

  constructor(private d: AiServiceDeps) {
    this.engine = new ProposalEngine({
      aws: (accountId, service, action, params, region) => d.aws(accountId, service, action, params, region),
      account: (id) => d.account(id),
      audit: (type, accountId, data) => d.store.audit(type, accountId, data),
      onState: (p) => d.emit({ accountId: p.appAccountId, conversationId: p.conversationId, runId: 0, event: { type: 'proposal-state', proposal: p.view } }),
      supports: d.awsSupports,
      inputMembers: d.awsInputMembers,
      now: () => this.now()
    })
    this.approvals = new ApprovalStore({
      account: (id) => d.account(id),
      audit: (type, accountId, data) => d.store.audit(type, accountId, data),
      onState: (accountId, conversationId, approval) => d.emit({ accountId, conversationId, runId: 0, event: { type: 'approval', approval } }),
      now: () => this.now()
    })
    // Expiry is also checked on every confirm; this makes an untouched card turn grey (and its audit row appear) on time.
    setInterval(() => (this.engine.sweep(), this.approvals.sweep()), 15_000).unref?.()
  }

  private now(): number {
    return (this.d.now ?? (() => new Date()))().getTime()
  }

  configView(): AiConfigView {
    const c = this.d.config.get()
    const hasKey = c.provider !== '' && (c.keyMode === 'command' ? Boolean(c.keyCommand) : this.d.keys.has(c.provider))
    // An account deleted since it was picked reads as "none picked": settings and the panel then ask for one.
    const bedrockAccountId = c.bedrockAccountId && this.d.account(c.bedrockAccountId) ? c.bedrockAccountId : null
    return { ...c, bedrockAccountId, hasKey, canPersistKey: this.d.keys.canPersist() }
  }

  saveConfig(input: unknown): AiConfigView {
    const before = this.d.config.get()
    const after = this.d.config.save(input, (id) => this.d.account(id) !== undefined)
    this.commandKeys.clear()
    // A key-mode switch moves the current key: memory-only takes it off the disk now, keychain saves it.
    if (after.provider && after.keyMode !== before.keyMode && after.keyMode !== 'command') {
      const key = this.d.keys.get(after.provider)
      if (key) this.d.keys.set(after.provider, key, after.keyMode === 'keychain')
    }
    return this.configView()
  }

  setKey(key: string): SetKeyResult {
    const c = this.d.config.get()
    if (!c.provider) return { ok: false, error: '请先选择服务商' }
    return this.d.keys.set(c.provider, key, c.keyMode === 'keychain')
  }

  clearKey(): void {
    const c = this.d.config.get()
    if (c.provider) this.d.keys.delete(c.provider)
    this.commandKeys.clear()
  }

  models(provider: string): AiModelInfo[] {
    return provider === CUSTOM_PROVIDER_ID ? [] : listModels(this.d.models, provider)
  }

  /** The configured model and its key; throws a user-facing message when either is missing. */
  private async resolve(): Promise<Resolved> {
    const c = this.d.config.get()
    if (!c.provider || !c.model) throw new Error('请先在 AI 设置里选择服务商和模型')
    const bedrock = c.provider === BEDROCK_PROVIDER_ID
    const bedrockAccount = bedrock && c.bedrockAuth === 'account' ? c.bedrockAccountId : null
    if (bedrock && c.bedrockAuth === 'account' && !(bedrockAccount && this.d.account(bedrockAccount))) {
      throw new Error('请在 AI 设置里选择 Bedrock 使用的账号')
    }
    const model = resolveModel(this.d.models, c, bedrockAccount ? () => this.d.credentials(bedrockAccount) : undefined)
    if (!model) throw new Error(c.provider === CUSTOM_PROVIDER_ID ? '请填写 baseURL 和模型 id' : `模型 ${c.model} 不在 ${c.provider} 的目录里`)
    const explain = bedrock ? (m: string) => explainBedrockError(m, model.id, c.bedrockRegion) : (m: string) => m
    // SigV4 with the account's credentials, which bedrockProvider fetches per request: no key.
    if (bedrockAccount) return { model, apiKey: undefined, explain }
    let apiKey: string | undefined
    if (c.keyMode === 'command') {
      apiKey = this.commandKeys.get(c.provider)
      if (!apiKey) {
        apiKey = await this.d.runKeyCommand(c.keyCommand ?? '')
        this.commandKeys.set(c.provider, apiKey)
      }
    } else apiKey = this.d.keys.get(c.provider)
    // Keyless is fine for a local OpenAI-compatible endpoint (Ollama), not for a hosted provider.
    if (!apiKey && c.provider !== CUSTOM_PROVIDER_ID) {
      throw new Error(bedrock ? '还没有设置 Bedrock API key，请在 AI 设置里填写，或改用账号凭证' : '还没有设置 API key，请在 AI 设置里填写')
    }
    return { model, apiKey, explain }
  }

  /** Errors may echo request details: scrub credentials and, belt and braces, the key itself. */
  private clean(message: string, apiKey?: string): string {
    const scrubbed = redactSecrets(message)
    // Not for trivially short keys (a dummy "ollama"): replacing those would mangle ordinary words.
    return (apiKey && apiKey.length >= 8 ? scrubbed.split(apiKey).join('[redacted]') : scrubbed).slice(0, 1000)
  }

  async test(): Promise<AiTestResult> {
    const started = Date.now()
    let apiKey: string | undefined
    try {
      const resolved = await this.resolve()
      apiKey = resolved.apiKey
      const r = await testModel(this.d.models, resolved.model, apiKey)
      return r.error ? { ...r, error: this.clean(resolved.explain(r.error), apiKey) } : r
    } catch (err) {
      return { ok: false, toolCalling: false, latencyMs: Date.now() - started, error: this.clean(err instanceof Error ? err.message : String(err), apiKey) }
    }
  }

  conversations(accountId: string): ConversationSummary[] {
    return this.d.store.conversations(accountId).map((c) => {
      const status = { running: this.isRunning(c.id), awaitingApproval: this.approvals.pendingIds(c.id).length > 0, pendingProposals: this.engine.pendingCount(c.id) }
      return { ...c, status }
    })
  }

  search(accountId: string, query: string): ConversationSearchResult[] {
    if (!this.d.account(accountId)) throw new Error('账号不存在')
    return this.d.store.search(accountId, checkSearchQuery(query))
  }

  pin(accountId: string, conversationId: string, pinned: boolean): void {
    this.owned(accountId, conversationId)
    this.d.store.setPinned(conversationId, pinned)
  }

  feedback(accountId: string, conversationId: string, ordinal: number, value: 'up' | 'down' | null): void {
    this.owned(accountId, conversationId)
    const row = this.d.store.messages(conversationId).filter((m) => m.role === 'assistant' && (textOf((m.content as StoredAgentMessage).content) || ['error', 'aborted'].includes((m.content as StoredAgentMessage).stopReason ?? '')))[ordinal]
    if (!row) throw new Error('回答不存在')
    this.d.store.setFeedback(conversationId, row.id, value)
  }

  resourceCandidates(accountId: string, query: string): ResourceCandidate[] {
    if (!this.d.account(accountId)) throw new Error('账号不存在')
    return resourceCandidates(accountId, checkSearchQuery(query, true), this.d.recents?.() ?? [], this.pageContext(accountId))
  }

  private resolveResources(accountId: string, context?: ResourceContext): ResourceCandidate[] {
    return resolveResources(accountId, this.d.recents?.() ?? [], context?.resources ?? [], this.pageContext(accountId))
  }

  private transcript(conversationId: string): StoredAgentMessage[] {
    return this.d.store.messages(conversationId).map((m) => m.content as StoredAgentMessage)
  }

  private rates = (provider: string, model: string) => this.d.models.getModel(provider, model)?.cost

  /** Billed usage survives regeneration because the usage table is append-only. */
  private usage(conversationId: string): UsageTotals {
    return sumUsage(this.d.store.conversationUsage(conversationId).map((r) => ({ role: 'assistant', provider: r.provider, model: r.model, usage: r })) as StoredAgentMessage[], this.rates)
  }

  /** This calendar month (local time) from the usage table, which keeps deleted conversations' replies. */
  monthUsage(): MonthUsage {
    const now = new Date(this.now())
    const rows = this.d.store.usageSince(new Date(now.getFullYear(), now.getMonth(), 1).getTime())
    const totals = sumUsage(
      rows.map((r) => ({ role: 'assistant', provider: r.provider, model: r.model, usage: r })),
      this.rates
    )
    return { totals, ...budgetVerdict(this.d.config.get().budget, totals) }
  }

  view(accountId: string, conversationId: string): ConversationView {
    this.owned(accountId, conversationId)
    const quickReplies = this.d.config.get().quickReplies
    return {
      items: toChatItems(
        this.d.store.messages(conversationId).map((m) => ({ ...(m.content as StoredAgentMessage), rowId: m.id, feedback: m.feedback })),
        this.now(),
        this.pendingCards.get(conversationId),
        (id) => this.engine.view(id),
        (toolCallId) => this.approvals.forToolCall(conversationId, toolCallId),
        this.rates
      ).filter((i) => quickReplies || i.kind !== 'replies'),
      usage: this.usage(conversationId),
      month: this.monthUsage(),
      pageContext: this.d.store.pageContext(conversationId),
      queue: this.queueView(conversationId)
    }
  }

  /** What the model would get as the current page now (the panel's chip shows it). */
  pageContext(accountId: string): PageContext | null {
    return pageContext(this.d.activePage(accountId))
  }

  /** The chip's ×: whether this conversation sends the current page from its next turn on. */
  setPageContext(accountId: string, conversationId: string, on: boolean): void {
    this.owned(accountId, conversationId)
    this.d.store.setPageContext(conversationId, on)
  }

  /**
   * Retention (config): audit rows past their days, and conversations past theirs. `boundary`: app start or quit,
   * the only times "不保留" (0) deletes every conversation; the daily run and a settings change leave it alone.
   */
  maintain(boundary: boolean): { audit: number; conversations: number } {
    this.engine.sweep()
    const c = this.d.config.get()
    const days = c.conversationRetention === 0 && !boundary ? null : c.conversationRetention
    return this.d.store.prune({ now: this.now(), auditDays: c.auditRetentionDays, conversationDays: days })
  }

  /** The audit log as the in-app viewer shows it: summaries, newest first, at most 500. */
  auditList(f: AuditFilter): AuditView[] {
    const since = this.now() - (f.days ?? 30) * 86400_000
    // A day of slack, so executions find their proposal_created row (risk, targets) just before the window.
    const rows = this.d.store.auditRows({ since: since - 86400_000, accountId: f.accountId, limit: 5000 })
    const created = createdIndex(rows)
    return filterAudit(rows, { since, risks: f.risk && new Set([f.risk]), changesOnly: f.scope !== 'all' })
      .slice(0, 500)
      .map((r) => summarize(r, created))
  }

  /**
   * "删除全部 AI 数据": every conversation, queued turn and pending proposal, and the usage history. The audit log
   * only with `audit` and the phrase typed (compared here); a row recording the deletion is written afterwards.
   */
  deleteAllData(audit: boolean, typed?: string): void {
    if (audit && typed !== DELETE_AUDIT_PHRASE) throw new Error(`删除审计记录需要输入「${DELETE_AUDIT_PHRASE}」`)
    for (const id of new Set([...this.runs.keys(), ...this.pendingSetup.keys()])) this.abort(id, '对话已删除')
    this.engine.forgetAll()
    this.approvals.forgetAll()
    this.costBudgets.clear()
    this.pendingCards.clear()
    this.queued.clear()
    this.d.store.deleteAll({ audit, now: this.now() })
    this.d.store.audit('ai_data_deleted', null, { audit, actor: 'user' })
  }

  /** Over budget (and blocking): why a new turn is refused; null otherwise. */
  private blocked(): string | null {
    const m = this.monthUsage()
    return m.blocked ? (m.budget ?? '本月 AI 预算已用完') : null
  }

  /** The conversation's cards with their current state; the transcript plus accepted, still queued clicks. */
  private cards(conversationId: string): Map<string, Card> {
    return transcriptCards(this.transcript(conversationId), this.now(), this.pendingCards.get(conversationId))
  }

  private owned(accountId: string, conversationId: string): void {
    if (this.d.store.conversationAccount(conversationId) !== accountId) throw new Error('对话不存在')
  }

  rename(accountId: string, conversationId: string, title: string): void {
    this.owned(accountId, conversationId)
    this.d.store.renameConversation(conversationId, title)
  }

  delete(accountId: string, conversationId: string): void {
    this.owned(accountId, conversationId)
    this.abort(conversationId, '对话已删除')
    this.forget(conversationId)
    this.d.store.deleteConversation(conversationId)
  }

  /** Every conversation of the account (the account was deleted, or the user cleared them). */
  clearAccount(accountId: string): void {
    for (const [id, run] of this.runs) if (run.accountId === accountId) this.abort(id, '对话已删除')
    for (const id of this.pendingSetup.keys()) if (this.d.store.conversationAccount(id) === accountId) this.abort(id, '对话已删除')
    for (const c of this.d.store.conversations(accountId)) this.forget(c.id)
    this.d.store.clearAccount(accountId)
  }

  /** The conversation is going away: its cards, queued clicks and pending proposals go with it. */
  private forget(conversationId: string): void {
    // queueEpoch entries stay so late async work cannot reuse an old epoch after deletion.
    this.costBudgets.delete(conversationId)
    this.pendingCards.delete(conversationId)
    this.queued.delete(conversationId)
    this.engine.forgetConversation(conversationId)
    this.approvals.forgetConversation(conversationId)
  }

  /**
   * Stops the run and drops queued card replies; their cards can be clicked again. Queued proposal results stay, to be
   * stored without a run once this one has wound down: they are the record of what was executed.
   */
  abort(conversationId: string, reason = '已停止'): void {
    this.queueEpoch.set(conversationId, (this.queueEpoch.get(conversationId) ?? 0) + 1)
    this.pendingSetup.get(conversationId)?.cancel(reason)
    const accountId = this.d.store.conversationAccount(conversationId)
    const queued = this.queued.get(conversationId) ?? []
    for (const turn of queued) if (turn.kind === 'card' && accountId) this.release(accountId, conversationId, turn.cardId)
    for (const turn of queued) if (turn.kind === 'user' && accountId) this.failQueued(accountId, conversationId, turn, reason)
    const results = queued.flatMap((t) => (t.kind === 'result' ? [{ ...t, silent: true }] : []))
    if (results.length) this.queued.set(conversationId, results)
    else this.queued.delete(conversationId)
    if (accountId) this.emitQueue(accountId, conversationId)
    // The run's signal ends its pending approval too; this does it even before pi has passed the abort on.
    this.approvals.abortConversation(conversationId)
    const run = this.runs.get(conversationId)
    if (!run) return
    run.aborted = true
    run.agent?.abort()
  }

  private queueView(conversationId: string): QueuedMessage[] {
    return (this.queued.get(conversationId) ?? []).filter((t): t is Extract<QueuedTurn, { kind: 'user' }> => t.kind === 'user')
      .map(({ id, text, context }) => ({ id, text, ...(context && { context }) }))
  }

  private emitQueue(accountId: string, conversationId: string): void {
    this.d.emit({ accountId, conversationId, runId: 0, event: { type: 'queue', items: this.queueView(conversationId) } })
  }

  private failQueued(accountId: string, conversationId: string, turn: Extract<QueuedTurn, { kind: 'user' }>, err: unknown): void {
    this.d.emit({ accountId, conversationId, runId: 0, event: { type: 'queue-failed', id: turn.id, text: turn.text, ...(turn.context && { context: turn.context }), ...(turn.resources && { resources: turn.resources }), message: this.clean(err instanceof Error ? err.message : String(err)) } })
  }

  private dropTurn(accountId: string, conversationId: string, turn: QueuedTurn, err: unknown, emit: (event: AiEvent) => void, note = true): void {
    if (turn.kind === 'card') this.release(accountId, conversationId, turn.cardId)
    else if (turn.kind === 'result') this.storeTurn(conversationId, turn.text)
    else this.failQueued(accountId, conversationId, turn, err)
    if (!note || err === '已停止' || err === '对话已删除' || turn.kind === 'user' || this.d.store.conversationAccount(conversationId) === undefined) return
    const message = this.clean(err instanceof Error ? err.message : String(err))
    this.d.store.addMessage(conversationId, { role: 'note', content: { role: 'note', content: '', error: message, retryable: false, timestamp: this.now() } })
    emit({ type: 'error', message, retryable: false })
  }

  private enqueueUser(accountId: string, conversationId: string, text: string, context?: ResourceContext, resources?: ResourceCandidate[]): AiSendResult {
    const queue = this.queued.get(conversationId) ?? []
    if (queue.filter((t) => t.kind === 'user').length >= 3) throw new Error('最多排队 3 条消息')
    const id = randomUUID()
    this.queued.set(conversationId, [...queue, { kind: 'user', id, text, ...(context && { context }), ...(resources && { resources }) }])
    this.emitQueue(accountId, conversationId)
    return { conversationId, runId: this.runs.get(conversationId)?.runId ?? 0, queued: { id } }
  }

  queueCancel(accountId: string, conversationId: string, queueId: string): void {
    this.owned(accountId, conversationId)
    const queue = this.queued.get(conversationId) ?? []
    const at = queue.findIndex((t) => t.kind === 'user' && t.id === queueId)
    if (at < 0) throw new Error('排队消息不存在')
    queue.splice(at, 1)
    if (!queue.length) this.queued.delete(conversationId)
    this.emitQueue(accountId, conversationId)
  }

  denyAll(accountId: string, conversationId: string): { approvals: number; proposals: number } {
    this.owned(accountId, conversationId)
    if (this.regenerating.has(conversationId)) throw new Error('对话正在重新生成')
    const account = this.d.account(accountId)
    if (!account) throw new Error('账号不存在')
    const approvals = this.approvals.pendingIds(conversationId)
    const proposals = this.engine.pendingIds(conversationId)
    let denied = 0
    let cancelled = 0
    for (const id of approvals) {
      try { this.approvals.decide(accountId, conversationId, id, 'deny'); denied++ }
      catch { /* decide already denies a tampered or expired request */ }
    }
    for (const id of proposals) {
      try {
        const p = this.engine.cancel(accountId, conversationId, id)
        void this.deliverResult(account, conversationId, { proposalId: id, status: 'cancelled', title: p.plan.title }, false)
        cancelled++
      }
      catch { /* a proposal may expire while the batch is being processed */ }
    }
    return { approvals: denied, proposals: cancelled }
  }

  /** A reply click that will not be sent after all: the card is active again (unless it expired meanwhile). */
  private release(accountId: string, conversationId: string, cardId: string): void {
    this.pendingCards.get(conversationId)?.delete(cardId)
    const state = this.cards(conversationId).get(cardId)?.state
    if (state) this.d.emit({ accountId, conversationId, runId: 0, event: { type: 'card-state', cardId, state } })
  }

  /**
   * A click on a card button (plan §10.3), checked against the card main stored: it belongs to this conversation,
   * is active, has the button (on that row), and the form values fit the fields. open-console opens the page and
   * leaves the card as it is; reply resolves the card and becomes the next user turn, queued behind a running one.
   */
  async cardAction(accountId: string, conversationId: string, cardId: string, actionId: string, rowId?: string, values?: FormValues): Promise<void> {
    const account = this.d.account(accountId)
    if (!account) throw new Error('账号不存在')
    this.owned(accountId, conversationId)
    if (this.regenerating.has(conversationId)) throw new Error('上一条消息还在处理中')
    const card = this.cards(conversationId).get(cardId)
    if (!card) throw new Error('卡片不存在')
    const checked = checkCardAction(card, actionId, rowId, values)
    if (checked.url !== undefined) return void (await this.d.openConsole(accountId, checked.url))
    // Taken before any await, so a second (or racing) click finds the card resolved.
    const pending = this.pendingCards.get(conversationId) ?? new Set<string>()
    this.pendingCards.set(conversationId, pending.add(cardId))
    this.d.emit({ accountId, conversationId, runId: 0, event: { type: 'card-state', cardId, state: 'resolved' } })
    const message = { cardId, action: actionId, label: checked.action.label, ...(rowId !== undefined && { row: rowId }), ...(checked.values && { values: checked.values }) }
    const turn: CardTurn = { kind: 'card', cardId, text: cardActionText(message), label: cardActionLabel(message) }
    if (this.runs.has(conversationId) || this.pendingSetup.has(conversationId)) {
      this.queued.set(conversationId, [...(this.queued.get(conversationId) ?? []), turn])
      return
    }
    try {
      await this.startCardTurn(account, conversationId, turn)
    } catch (err) {
      this.release(accountId, conversationId, cardId)
      throw err
    }
  }

  private async startCardTurn(account: AwsAccount, conversationId: string, turn: CardTurn): Promise<void> {
    const epoch = this.queueEpoch.get(conversationId) ?? 0
    if (this.regenerating.has(conversationId)) throw new Error('上一条消息还在处理中')
    const blocked = this.blocked()
    if (blocked) throw new Error(blocked)
    let resolved
    try {
      resolved = await this.resolve()
    } catch (err) {
      if (epoch !== (this.queueEpoch.get(conversationId) ?? 0)) throw new Error('已停止')
      throw new Error(this.clean(err instanceof Error ? err.message : String(err)))
    }
    if (epoch !== (this.queueEpoch.get(conversationId) ?? 0)) throw new Error('已停止')
    if (this.d.store.conversationAccount(conversationId) !== account.id) throw new Error('对话已删除')
    if (this.regenerating.has(conversationId)) throw new Error('上一条消息还在处理中')
    // A typed message got in during the await: go after it.
    if (this.runs.has(conversationId) || this.pendingSetup.has(conversationId)) this.queued.set(conversationId, [...(this.queued.get(conversationId) ?? []), turn])
    else {
      const blockedNow = this.blocked()
      if (blockedNow) throw new Error(blockedNow)
      this.start(account, conversationId, turn.text, resolved, turn.label)
    }
  }

  isRunning(conversationId: string): boolean {
    return this.runs.has(conversationId) || this.pendingSetup.has(conversationId)
  }

  /**
   * The user's confirmation from the proposal card (ai:proposal-confirm). Only ids and the typed text come in; the
   * engine runs the stored params. A refusal throws (the card shows it); an execution, a failure or a drift becomes a
   * result card and a [proposal_result] turn the model answers once.
   */
  async confirmProposal(accountId: string, conversationId: string, proposalId: string, typed?: string): Promise<void> {
    const account = this.d.account(accountId)
    if (!account) throw new Error('账号不存在')
    this.owned(accountId, conversationId)
    if (this.regenerating.has(conversationId)) throw new Error('对话正在重新生成')
    const outcome = await this.engine.confirm(accountId, conversationId, proposalId, typed)
    const title = this.engine.get(proposalId)?.plan.title ?? proposalId
    const result: ProposalResult =
      outcome.status === 'succeeded'
        ? { proposalId, status: 'succeeded', title, summary: outcome.summary, ...(outcome.requestId && { requestId: outcome.requestId }) }
        : outcome.status === 'failed'
          ? { proposalId, status: 'failed', title, error: outcome.error }
          : { proposalId, status: 'drifted', title, changes: outcome.changes }
    await this.deliverResult(account, conversationId, result, true)
  }

  /** Cancel from the card: no AWS call; the model learns it from the stored [proposal_result] on its next turn. */
  cancelProposal(accountId: string, conversationId: string, proposalId: string): void {
    const account = this.d.account(accountId)
    if (!account) throw new Error('账号不存在')
    this.owned(accountId, conversationId)
    if (this.regenerating.has(conversationId)) throw new Error('对话正在重新生成')
    const p = this.engine.cancel(accountId, conversationId, proposalId)
    void this.deliverResult(account, conversationId, { proposalId, status: 'cancelled', title: p.plan.title }, false)
  }

  /**
   * The user's decision on an approval card (ai:approval-decide): ids and the decision only. The paused call then
   * runs the params main froze (or gets the denial as its result).
   */
  decideApproval(accountId: string, conversationId: string, approvalId: string, decision: ApprovalDecision): ApprovalView {
    if (!this.d.account(accountId)) throw new Error('账号不存在')
    this.owned(accountId, conversationId)
    return this.approvals.decide(accountId, conversationId, approvalId, decision)
  }

  /** "本对话已允许的动作", every conversation, with titles for the settings list. */
  sessionAllows(): SessionAllowView[] {
    const titles = new Map<string, string>()
    return this.approvals.sessionAllows().map((a) => {
      if (!titles.has(a.accountId)) for (const c of this.d.store.conversations(a.accountId)) titles.set(c.id, c.title)
      return { ...a, conversationTitle: titles.get(a.conversationId) ?? '' }
    })
  }

  revokeAllow(accountId: string, conversationId: string, key: string): void {
    this.owned(accountId, conversationId)
    this.approvals.revoke(accountId, conversationId, key)
  }

  /** The result card now; the [proposal_result] turn after any run in progress, with one follow-up run when `followUp`. */
  private async deliverResult(account: AwsAccount, conversationId: string, r: ProposalResult, followUp: boolean): Promise<void> {
    const epoch = this.queueEpoch.get(conversationId) ?? 0
    // Deleted while it executed: the audit log has it, the conversation is gone.
    if (this.d.store.conversationAccount(conversationId) !== account.id) return
    const text = proposalResultText(r)
    this.d.emit({ accountId: account.id, conversationId, runId: 0, event: { type: 'proposal-result', id: `r-${r.proposalId}`, card: resultCard(r, this.now()) } })
    const turn: QueuedTurn = { kind: 'result', text, silent: !followUp }
    if (this.runs.has(conversationId) || this.pendingSetup.has(conversationId) || this.regenerating.has(conversationId)) return void this.queued.set(conversationId, [...(this.queued.get(conversationId) ?? []), turn])
    // Over a blocking budget the outcome is still recorded; the model reads it on the next turn the user can start.
    if (!followUp || this.blocked()) return this.storeTurn(conversationId, text)
    let resolved
    try {
      resolved = await this.resolve()
    } catch {
      // No model to answer (settings changed): the record is kept, the model reads it next time.
      turn.silent = true
    }
    if (epoch !== (this.queueEpoch.get(conversationId) ?? 0)) turn.silent = true
    if (this.runs.has(conversationId) || this.pendingSetup.has(conversationId) || this.regenerating.has(conversationId)) this.queued.set(conversationId, [...(this.queued.get(conversationId) ?? []), turn])
    else if (this.d.store.conversationAccount(conversationId) === account.id) {
      if (turn.silent || !resolved || this.blocked()) this.storeTurn(conversationId, text)
      else this.start(account, conversationId, text, resolved)
    }
  }

  /**
   * A generic proposal's impact analysis (analysis.ts) with the chat's model, outside the run: it goes on even if the
   * run ends, and ends with the proposal (engine `finish` aborts it). Usage is recorded as each reply comes; the
   * outcome goes to the engine, which updates the card. Never throws.
   */
  private async analyze(account: AwsAccount, conversationId: string, proposalId: string, resolved: Resolved): Promise<void> {
    const p = this.engine.get(proposalId)
    if (!p?.analysis) return
    let calls = 0
    let outcome: AnalysisOutcome
    try {
      const blocked = this.blocked()
      if (blocked) throw new Error('本月 AI 预算已用完')
      const g = p.adapter.generic
      outcome = await runImpactAnalysis(
        {
          proposalId,
          service: p.service,
          action: p.action,
          region: p.region,
          params: p.params,
          shown: displayParams(p.params, true),
          account: { name: p.accountName, accountId: p.awsAccountId, production: p.production },
          risk: p.risk,
          categories: g?.tier === 'C' ? g.dangers : []
        },
        {
          models: this.d.models,
          model: resolved.model,
          apiKey: resolved.apiKey,
          call: (...c) => this.d.aws(account.id, ...c),
          tools: {
            account,
            audit: (type, data) => this.d.store.audit(type, account.id, { conversationId, analysis: proposalId, ...data }),
            supports: this.d.awsSupports
          },
          signal: p.analysis.stop.signal,
          onCalls: (n) => this.engine.analysisProgress(proposalId, (calls = n)),
          onUsage: ({ provider, model, usage }) => {
            this.d.store.addAnalysisUsage(account.id, conversationId, { provider, model, ...usage })
            if (this.d.store.conversationAccount(conversationId) === account.id) {
              this.d.emit({ accountId: account.id, conversationId, runId: 0, event: { type: 'usage', usage: this.usage(conversationId), month: this.monthUsage() } })
            }
          }
        }
      )
    } catch (err) {
      outcome = { ok: false, reason: err instanceof Error ? err.message : String(err), calls }
    }
    // Provider errors may echo request details.
    this.engine.finishAnalysis(proposalId, outcome.ok ? outcome : { ...outcome, reason: this.clean(resolved.explain(outcome.reason), resolved.apiKey).slice(0, 200) })
  }

  /** A user turn main wrote, stored without a run. */
  private storeTurn(conversationId: string, text: string): void {
    if (this.d.store.conversationAccount(conversationId) === undefined) return
    this.d.store.addMessage(conversationId, { role: 'user', content: { role: 'user', content: [{ type: 'text', text }], timestamp: this.now() } })
  }

  /** Resolves once the run has started; its progress comes as ai:event. Config problems reject here. */
  /** `page`: a new conversation's page toggle (an existing one keeps its own). */
  async send(accountId: string, conversationId: string | null, text: string, page = true, context?: ResourceContext): Promise<AiSendResult> {
    text = checkPrompt(text)
    context = checkResourceContext(context)
    const account = this.d.account(accountId)
    if (!account) throw new Error('账号不存在')
    if (conversationId) {
      this.owned(accountId, conversationId)
      if (this.regenerating.has(conversationId)) throw new Error('上一条消息还在处理中')
    }
    // Those prefixes mark turns main composed (a card click, a proposal's outcome); a typed one would pass for one.
    this.checkUserPrompt(text)
    const resources = this.resolveResources(accountId, context)
    if (conversationId && (this.runs.has(conversationId) || this.pendingSetup.has(conversationId))) return this.enqueueUser(accountId, conversationId, text, context, resources)
    const month = this.monthUsage()
    if (month.blocked) throw new Error(month.budget ?? '本月 AI 预算已用完')
    let resolved
    try {
      resolved = await this.resolve()
    } catch (err) {
      const message = this.clean(err instanceof Error ? err.message : String(err))
      this.d.toast(message)
      throw new Error(message)
    }
    const freshResources = context ? this.resolveResources(accountId, context) : resources
    const laterBudget = this.monthUsage()
    if (laterBudget.blocked) throw new Error(laterBudget.budget ?? '本月 AI 预算已用完')
    const id = conversationId ?? this.d.store.createConversation(accountId, this.clean(titleFrom(text), resolved.apiKey), page)
    // Re-checked after the await: a second send may have started meanwhile.
    if (conversationId) this.owned(accountId, id)
    if (this.regenerating.has(id)) throw new Error('上一条消息还在处理中')
    if (conversationId && (this.runs.has(id) || this.pendingSetup.has(id))) return this.enqueueUser(accountId, id, text, context, freshResources)
    return { ...this.start(account, id, text, resolved, undefined, undefined, freshResources), ...(month.budget && { warning: month.budget }) }
  }

  /** A user turn ordinal and its displayed original text. Keeps audit and billed usage. */
  async regenerate(accountId: string, conversationId: string, fromUserIndex: number, expectedText: string, text?: string, context?: ResourceContext): Promise<AiSendResult> {
    let epoch = this.queueEpoch.get(conversationId) ?? 0
    const account = this.d.account(accountId)
    if (!account) throw new Error('账号不存在')
    this.owned(accountId, conversationId)
    checkUserIndex(fromUserIndex)
    if (this.regenerating.has(conversationId)) throw new Error('上一条消息还在处理中')
    const running = this.runs.get(conversationId)
    const settingUp = this.pendingSetup.get(conversationId)
    const waiting = running && this.view(accountId, conversationId).items.some((i) => i.kind === 'approval' && i.approval.state === 'pending')
    if (running && !waiting) throw new Error('上一条消息还在处理中')
    const candidates = (rows: ReturnType<AiStore['messages']>) => rows.filter((m) => {
      if (m.role !== 'user') return false
      const value = textOf((m.content as StoredAgentMessage).content)
      return value !== ANSWER_REQUEST && value !== LIMIT_REQUEST && !parseProposalResult(value)
    })
    const select = (rows: ReturnType<AiStore['messages']>) => {
      const selected = candidates(rows)[fromUserIndex]
      if (!selected) throw new Error('消息位置不是用户提问')
      const originalText = textOf((selected.content as StoredAgentMessage).content)
      if (originalText !== expectedText) throw new Error('消息已变化，请刷新对话后重试')
      return selected
    }
    const initialRows = this.d.store.messages(conversationId)
    const selected = select(initialRows)
    const originalText = textOf((selected.content as StoredAgentMessage).content)
    const originalResources = (selected.content as StoredAgentMessage).resources
    const storedResources: unknown[] = Array.isArray(originalResources) ? originalResources : originalResources === undefined ? [] : [originalResources]
    const seenResources = new Set<string>()
    const validOriginalResources = storedResources.flatMap((value) => {
      try {
        const { type, id, region } = value as { type: string; id: string; region: string }
        const ref = checkResourceContext({ resources: [{ type, id, region }] })!.resources[0]
        const key = `${ref.type}|${ref.id}|${ref.region}`
        if (seenResources.has(key)) return []
        seenResources.add(key)
        return [ref]
      }
      catch { return [] }
    })
    const resourceContext = context === undefined ? { resources: validOriginalResources } : checkResourceContext(context)!
    if (resourceContext.resources.some((ref) => !validOriginalResources.some((r) => r.type === ref.type && r.id === ref.id && r.region === ref.region))) throw new Error('只能保留原消息的资源引用')
    if (originalText.startsWith(CARD_ACTION_PREFIX.trim())) throw new Error('不能重新发送卡片操作')
    const prompt = checkPrompt(text ?? originalText)
    this.checkUserPrompt(prompt)
    const month = this.monthUsage()
    if (month.blocked) throw new Error(month.budget ?? '本月 AI 预算已用完')
    const affected = (rows: ReturnType<AiStore['messages']>, id: number) => rows.filter((r) => r.id >= id)
      .map((r) => ((r.content as StoredAgentMessage).details as { proposal?: ProposalView } | undefined)?.proposal?.id)
      .filter((id): id is string => Boolean(id))
    const checkExecuting = (ids: string[]) => {
      if (ids.some((id) => this.engine.view(id)?.state === 'executing')) throw new Error('提案正在执行，暂时不能重新生成')
    }
    checkExecuting(affected(initialRows, selected.id))
    this.regenerating.add(conversationId)
    try {
      if (running || settingUp) {
        this.abort(conversationId)
        epoch = this.queueEpoch.get(conversationId) ?? 0
        let stopTimer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          running?.finished ?? settingUp!.finished,
          new Promise<never>((_, reject) => { stopTimer = setTimeout(() => reject(new Error('停止上一条回答超时，请重试')), 25_000) })
        ]).finally(() => clearTimeout(stopTimer))
        if (epoch !== (this.queueEpoch.get(conversationId) ?? 0)) throw new Error('已停止')
      }
      let setupTimer: ReturnType<typeof setTimeout> | undefined
      const resolved = await Promise.race([
        this.resolve(),
        new Promise<never>((_, reject) => { setupTimer = setTimeout(() => reject(new Error('模型配置超时，请重试')), 25_000) })
      ]).finally(() => clearTimeout(setupTimer))
      if (epoch !== (this.queueEpoch.get(conversationId) ?? 0)) throw new Error('已停止')
      if (this.runs.has(conversationId) || this.pendingSetup.has(conversationId) || this.d.store.conversationAccount(conversationId) !== accountId) throw new Error('上一条消息还在处理中')
      const queued = this.queued.get(conversationId) ?? []
      for (const turn of queued) if (turn.kind === 'result') this.storeTurn(conversationId, turn.text)
      this.queued.set(conversationId, queued.filter((turn) => turn.kind !== 'result'))
      const rows = this.d.store.messages(conversationId)
      const fresh = select(rows)
      const resources = resourceContext.resources.flatMap((ref) => {
        try { return this.resolveResources(accountId, { resources: [ref] }) }
        catch { return [] }
      })
      const droppedResources = storedResources.length - resources.length
      const proposalIds = affected(rows, fresh.id)
      checkExecuting(proposalIds)
      const blockedNow = this.blocked()
      if (blockedNow) throw new Error(blockedNow)
      // Cancel pending cards in the removed suffix. Finished changes remain in audit and usage stays billed.
      let cancelled = 0
      for (const proposalId of proposalIds) if (this.engine.view(proposalId)?.state === 'pending') {
        this.engine.cancel(accountId, conversationId, proposalId)
        cancelled++
      }
      this.approvals.abortConversation(conversationId)
      this.pendingCards.delete(conversationId)
      for (const turn of this.queued.get(conversationId) ?? []) {
        if (turn.kind === 'user') this.failQueued(accountId, conversationId, turn, '已停止')
        else if (turn.kind === 'card') this.release(accountId, conversationId, turn.cardId)
        else this.storeTurn(conversationId, turn.text)
      }
      this.queued.delete(conversationId)
      this.emitQueue(accountId, conversationId)
      const retry = text === undefined
      const fromId = fresh.id
      const earlier = rows.filter((r) => r.id < fromId)
      const earlierProposals = new Set(earlier.map((r) => ((r.content as StoredAgentMessage).details as { proposal?: ProposalView } | undefined)?.proposal?.id).filter(Boolean))
      const keepIds = rows.filter((r) => {
        if (r.id < fromId || r.role !== 'user') return false
        const value = textOf((r.content as StoredAgentMessage).content)
        const result = parseProposalResult(value)
        if (result) return earlierProposals.has(result.proposalId)
        return false
      }).map((r) => r.id)
      this.d.store.truncateMessages(conversationId, fromId, keepIds)
      this.d.store.audit('conversation_regenerated', accountId, { conversationId, fromUserIndex, edited: !retry, actor: 'user' })
      const notice = `${waiting ? '已取消待处理审批。' : ''}${cancelled ? `已取消 ${cancelled} 个待确认提案。` : ''}${droppedResources ? `${droppedResources} 个资源引用无效、已手动移除或不在本账号最近访问记录中，重新生成时已移除。` : ''}之前的操作可能已经执行；重新生成不会撤销已完成的查询或变更，请查看审计记录。`
      this.d.store.addMessage(conversationId, { role: 'note', content: { role: 'note', content: notice, timestamp: this.now() } })
      this.d.emit({ accountId, conversationId, runId: 0, event: { type: 'note', text: notice } })
      return { ...this.start(account, conversationId, prompt, resolved, undefined, notice, resources), ...(month.budget && { warning: month.budget }) }
    } finally {
      this.regenerating.delete(conversationId)
      const retained = this.queued.get(conversationId) ?? []
      if (!this.isRunning(conversationId) && retained.length) {
        this.next(account, conversationId, (event) => this.d.emit({ accountId, conversationId, runId: 0, event }))
      }
    }
  }

  private checkUserPrompt(text: string): void {
    if (text.startsWith(CARD_ACTION_PREFIX.trim())) throw new Error('消息不能以 [card_action] 开头')
    if (text.startsWith(PROPOSAL_RESULT_PREFIX.trim())) throw new Error('消息不能以 [proposal_result] 开头')
    if (text.startsWith('[answer_request]')) throw new Error('消息不能以 [answer_request] 开头')
  }

  /** `shown`: main started this turn (a card reply), so the panel gets the user item from here. */
  private start(account: AwsAccount, id: string, text: string, resolved: Resolved, shown?: string, runNotice?: string, resources: ResourceCandidate[] = []): AiSendResult {
    let finish = (): void => {}
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const run: Run = { runId: this.nextRunId++, accountId: account.id, aborted: false, finished, finish }
    this.runs.set(id, run)
    const emit = (event: AiEvent): void => this.d.emit({ accountId: account.id, conversationId: id, runId: run.runId, event })
    try {
      if (shown) emit({ type: 'user', text: shown, ...(resources.length && { resources }) })
    } catch (err) {
      this.runs.delete(id)
      run.finish()
      throw err
    }
    void this.execute(account, id, run, text, resolved, emit, runNotice, resources).finally(() => {
      this.runs.delete(id)
      try { this.next(account, id, emit) }
      finally { run.finish() }
    })
    return { conversationId: id, runId: run.runId }
  }

  /**
   * After a run: stored-only results are stored, then the next queued turn goes on (one busy stretch, one done, for
   * the panel). The model and key are resolved again, and the budget checked: settings may have changed meanwhile.
   */
  private next(account: AwsAccount, id: string, emit: (event: AiEvent) => void): void {
    if (this.regenerating.has(id)) return emit({ type: 'done' })
    const queue = this.queued.get(id) ?? []
    let turn = queue.shift()
    while (turn?.kind === 'result' && turn.silent) {
      this.storeTurn(id, turn.text)
      turn = queue.shift()
    }
    if (!queue.length) this.queued.delete(id)
    this.emitQueue(account.id, id)
    if (!turn) return emit({ type: 'done' })
    const t = turn
    if (this.d.store.conversationAccount(id) === undefined) {
      this.dropTurn(account.id, id, t, '对话已删除', emit)
      return emit({ type: 'done' })
    }
    const epoch = this.queueEpoch.get(id) ?? 0
    if (t.kind === 'user') {
      try { t.text = checkPrompt(t.text); this.checkUserPrompt(t.text); this.resolveResources(account.id, t.context) }
      catch (err) { this.dropTurn(account.id, id, t, err, emit); return this.next(account, id, emit) }
    }
    const blocked = this.blocked()
    let setupTimer: ReturnType<typeof setTimeout> | undefined
    let cancelSetup!: (reason: string) => void
    const cancelled = new Promise<never>((_, reject) => { cancelSetup = (reason) => reject(new Error(reason)) })
    let finishSetup!: () => void
    const finished = new Promise<void>((resolve) => { finishSetup = resolve })
    let settled = false
    const setupWait = { cancel: (reason: string) => {
      if (settled) return
      settled = true
      this.dropTurn(account.id, id, t, reason, emit)
      cancelSetup(reason)
    }, finished }
    if (!blocked) this.pendingSetup.set(id, setupWait)
    const setup = blocked ? Promise.reject<Resolved>(new Error(blocked)) : Promise.race([
      this.resolve(),
      new Promise<never>((_, reject) => { setupTimer = setTimeout(() => reject(new Error('模型配置超时，请重试')), 25_000) }),
      cancelled
    ])
    void setup.finally(() => {
      clearTimeout(setupTimer)
      if (this.pendingSetup.get(id) === setupWait) this.pendingSetup.delete(id)
    }).then(
      (fresh) => {
        if (settled) return this.next(account, id, emit)
        if (this.d.store.conversationAccount(id) === undefined) {
          settled = true
          this.dropTurn(account.id, id, t, '对话已删除', emit)
          return emit({ type: 'done' })
        }
        if (epoch !== (this.queueEpoch.get(id) ?? 0)) {
          settled = true
          this.dropTurn(account.id, id, t, '已停止', emit)
          return this.next(account, id, emit)
        }
        // A typed message started in the gap: this turn waits for it.
        if (this.runs.has(id) || this.regenerating.has(id)) {
          this.queued.set(id, [t, ...(this.queued.get(id) ?? [])])
          this.emitQueue(account.id, id)
          return
        }
        try {
          if (t.kind === 'user') { t.text = checkPrompt(t.text); this.checkUserPrompt(t.text) }
          const resources = t.kind === 'user' ? this.resolveResources(account.id, t.context) : []
          const blockedNow = this.blocked()
          if (blockedNow) {
            settled = true
            return this.dropBatch(account, id, t, blockedNow, emit)
          }
          settled = true
          try {
            this.start(account, id, t.text, fresh, t.kind === 'card' ? t.label : t.kind === 'user' ? t.text : undefined, undefined, resources)
          } catch (err) {
            if (!this.runs.has(id)) settled = false
            throw err
          }
        } catch (err) {
          if (!settled) {
            settled = true
            this.dropTurn(account.id, id, t, err, emit)
            this.next(account, id, emit)
          }
        }
      },
      (err: unknown) => {
        if (!settled) {
          settled = true
          const reason = this.d.store.conversationAccount(id) === undefined ? '对话已删除'
            : epoch !== (this.queueEpoch.get(id) ?? 0) ? '已停止' : err
          this.dropBatch(account, id, t, reason, emit)
        } else {
          this.next(account, id, emit)
        }
      }
    ).finally(finishSetup)
  }

  private dropBatch(account: AwsAccount, id: string, first: QueuedTurn, reason: unknown, emit: (event: AiEvent) => void): void {
    const queue = [first, ...(this.queued.get(id) ?? [])]
    this.queued.delete(id)
    this.emitQueue(account.id, id)
    let noted = false
    for (const turn of queue) {
      const mayNote: boolean = !noted && turn.kind !== 'user' && reason !== '已停止' && reason !== '对话已删除'
      this.dropTurn(account.id, id, turn, reason, emit, mayNote)
      noted ||= mayNote
    }
    emit({ type: 'done' })
  }

  private async execute(
    account: AwsAccount,
    conversationId: string,
    run: Run,
    text: string,
    { model, apiKey, explain }: Resolved,
    emit: (event: AiEvent) => void,
    runNotice?: string,
    resources: ResourceCandidate[] = []
  ): Promise<void> {
    const reportError = (message: string): void => {
      const clean = this.clean(message, apiKey)
      if (this.d.store.conversationAccount(conversationId) !== undefined)
        this.d.store.addMessage(conversationId, { role: 'note', content: { role: 'note', content: '', error: clean, timestamp: this.now() } })
      emit({ type: 'error', message: clean })
    }
    const fail = (message: string): void => {
      const clean = this.clean(message, apiKey)
      reportError(clean)
      this.d.toast(`AI 助手：${clean}`)
    }
    // Shown after the reply: why the run stopped early, if it did.
    let notice: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let left = LIMITS.runTimeoutMs
    let since = Date.now()
    const arm = (): void => {
      since = Date.now()
      timer = setTimeout(() => {
        notice = `超过 ${LIMITS.runTimeoutMs / 60_000} 分钟，已停止`
        this.abort(conversationId)
      }, left)
    }
    // Time the user spends on an approval card does not count against the run.
    const pause = (): void => {
      clearTimeout(timer)
      left = Math.max(0, left - (Date.now() - since))
    }
    arm()
    try {
      const region = this.d.regionFor(account.id)
      let budget = this.costBudgets.get(conversationId)
      if (!budget) this.costBudgets.set(conversationId, (budget = { left: MAX_COST_CALLS }))
      const audit = (type: string, data: Record<string, unknown>): void => this.d.store.audit(type, account.id, { conversationId, ...data })
      const buildCard = (input: unknown): Card =>
        buildModelCard(input, {
          // Main's id; whatever id the model wrote is not part of the input.
          id: `c-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          now: this.now(),
          known: (cardId) => this.cards(conversationId).has(cardId)
        })
      let proposals = 0
      // Registered in read-only mode too, so the model gets the refusal (and how to turn writes on) instead of guessing.
      const propose = async (input: Record<string, unknown>): Promise<{ text: string; summary: string; proposal?: ProposalView }> => {
        if (++proposals > LIMITS.maxProposals) throw new Error(`本轮最多提出 ${LIMITS.maxProposals} 个提案`)
        const { view, reused } = await this.engine.propose({ accountId: account.id, conversationId, region }, input, { analyze: this.d.config.get().impactAnalysis })
        if (reused) return { text: `相同的提案 ${view.id} 已经在等待用户确认，没有重复创建。你不能执行或批准它。`, summary: `${view.id} · 已在等待确认` }
        // The analysis is the user's: this model only learns that one runs, never its prompt or result.
        if (view.analysis) void this.analyze(account, conversationId, view.id, { model, apiKey, explain })
        const text =
          `提案 ${view.id} 已展示给用户，等待确认；你不能执行或批准它。风险：${RISK_LABEL[view.risk]}。` +
          (view.analysis ? '应用会单独对它做影响分析，结果只显示给用户。' : '') +
          '用户确认或取消后，你会收到一条以 [proposal_result] 开头的消息；在那之前不要说已经完成。'
        return { text, summary: `${view.id} · 待确认`, proposal: view }
      }
      const perRun = { left: LIMITS.maxApprovals }
      let approvalWaitMs = 0
      let approvalDepth = 0
      let approvalStarted = 0
      const elapsedApprovalWait = (): number => approvalWaitMs + (approvalDepth ? Date.now() - approvalStarted : 0)
      const approve = async (req: Omit<ApprovalRequest, 'accountId' | 'conversationId'>, signal?: AbortSignal): Promise<Verdict> => {
        if (approvalDepth++ === 0) {
          pause()
          approvalStarted = Date.now()
        }
        try {
          return await this.approvals.request({ ...req, accountId: account.id, conversationId }, signal, perRun)
        } finally {
          if (--approvalDepth === 0) {
            approvalWaitMs += Date.now() - approvalStarted
            arm()
          }
        }
      }
      // Resolved per run: the user may have moved to another page since the last turn.
      const pageOn = this.d.store.pageContext(conversationId)
      const page = pageOn ? pageContext(this.d.activePage(account.id)) : null
      const readable = pageOn && this.d.config.get().readPage
      const quickReplies = this.d.config.get().quickReplies
      const modelText = text + resourcePromptSection(resources)
      // The latest assistant message has answer text.
      let answered = false
      const tools = [
        ...buildReadTools({ account, region, call: (...call) => this.d.aws(account.id, ...call), audit, costBudget: budget, approve, supports: this.d.awsSupports }),
        ...(readable ? [buildPageTool(() => this.d.readPage(account.id), audit)] : []),
        buildCardTool(buildCard, audit),
        buildProposeTool(propose, changeCatalog()),
        ...(quickReplies ? [buildRepliesTool(audit, () => answered)] : [])
      ]
      let toolCalls = 0
      const toolStarted = new Map<string, { at: number; wait: number }>()
      let turns = 0
      // Which cap the run hit; it then lands: one last round where every tool call is blocked.
      let limit: string | null = null
      let landing = false
      const agent = createAppAgent(this.d.models, {
        initialState: {
          // The account as it is now: the write switch may have changed since the run's account was looked up.
          systemPrompt: buildSystemPrompt({
            account: this.d.account(account.id) ?? account,
            region,
            now: (this.d.now ?? (() => new Date()))(),
            page: { on: pageOn, context: page, readable },
            quickReplies
          }) + (runNotice ? `\n\n重新生成通知：${runNotice}` : ''),
          model,
          tools,
          // The page a turn was asked on is the app's record, not something to send again.
          messages: this.transcript(conversationId).filter((m) => m.role !== 'note')
            .map(({ page: _page, resources: priorResources, feedback: _feedback, ...m }) => m.role === 'user' && priorResources?.length
              ? { ...m, content: [{ type: 'text', text: textOf(m.content) + resourcePromptSection(priorResources) }] }
              : m) as AgentMessage[]
        },
        getApiKey: () => apiKey,
        toolExecution: 'sequential',
        transformContext: async (messages) => mergeUserTurns(compactContext(messages, Math.floor(model.contextWindow * LIMITS.contextShare))),
        beforeToolCall: async () => {
          if (!landing && ++toolCalls <= LIMITS.maxToolCalls) return undefined
          limit ??= `本轮工具调用超过 ${LIMITS.maxToolCalls} 次`
          return { block: true, reason: '本轮工具调用次数已达上限，不能再调用工具。请根据已有结果回答用户。', terminate: true }
        },
        finishTurn: (turn) => {
          if (landing) return { action: 'end' }
          if (turn.toolResults.length > 0 && ++turns >= LIMITS.maxTurns) limit ??= `步骤过多（超过 ${LIMITS.maxTurns} 轮）`
          else if (turn.toolResults.length > 0 && left - (Date.now() - since) < LIMITS.landingMs) limit ??= `快到 ${LIMITS.runTimeoutMs / 60_000} 分钟上限`
          return limit ? { action: 'end' } : undefined
        }
      })
      run.agent = agent
      if (run.aborted) return
      agent.subscribe((e) => {
        if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
          emit({ type: 'text-delta', text: e.assistantMessageEvent.delta })
        } else if (e.type === 'message_update' && e.assistantMessageEvent.type === 'toolcall_start') {
          // A skeleton while the card's arguments stream in.
          const part = e.assistantMessageEvent.partial.content[e.assistantMessageEvent.contentIndex]
          if (part?.type === 'toolCall' && part.name === 'render_card') emit({ type: 'card-pending', id: part.id })
        } else if (e.type === 'tool_execution_start') {
          toolStarted.set(e.toolCallId, { at: Date.now(), wait: elapsedApprovalWait() })
          if (e.toolName === 'render_card') emit({ type: 'card-pending', id: e.toolCallId })
          // Quiet: the chips are the result, a tool row would only clutter the reply.
          else if (e.toolName !== 'suggest_replies') {
            const code = scriptCode(e.toolName, e.args)
            emit({ type: 'tool-start', id: e.toolCallId, label: toolLabel(e.toolName, e.args), ...(code !== undefined && { code }), t: Date.now() })
          }
        } else if (e.type === 'tool_execution_end' && e.toolName === 'suggest_replies') {
          // Main's checked list from the result, never the model's arguments.
          const options = e.isError ? [] : checkReplies({ options: e.result?.details?.replies })
          if (options.length) emit({ type: 'replies', id: e.toolCallId, options })
        } else if (e.type === 'tool_execution_end') {
          const card = e.isError ? undefined : (e.result?.details?.card as Card | undefined)
          if (card) {
            emit({ type: 'card', id: e.toolCallId, card })
            // Resolved stays resolved; only a live card is shown as replaced.
            if (card.supersedes && this.cards(conversationId).get(card.supersedes)?.state === 'active') {
              emit({ type: 'card-state', cardId: card.supersedes, state: 'superseded' })
            }
            return
          }
          const proposal = e.isError ? undefined : (e.result?.details?.proposal as ProposalView | undefined)
          if (proposal) return emit({ type: 'proposal', id: e.toolCallId, proposal })
          const summary = e.isError ? this.clean(String(e.result?.content?.[0]?.text ?? '失败')).slice(0, 200) : e.result?.details?.summary
          const calls = e.toolName === 'run_script' ? scriptCalls(e.result?.details) : undefined
          const started = toolStarted.get(e.toolCallId)
          emit({ type: 'tool-end', id: e.toolCallId, ok: !e.isError && e.result?.details?.denied !== true, summary, ...(calls && { calls }), t: Date.now() - (started ? elapsedApprovalWait() - started.wait : 0) })
        } else if (e.type === 'message_end' && e.message.role !== 'system') {
          // Ends before its tool calls run: suggest_replies asks this.
          if (e.message.role === 'assistant') answered = hasAnswer(e.message as StoredAgentMessage)
          // Deleted while the aborted run winds down: nothing left to store into.
          if (this.d.store.conversationAccount(conversationId) === undefined) return
          // Stored as it happens, so a stop or a crash keeps what was said so far.
          const live = e.message as StoredAgentMessage
          // The panel shows a failed reply's stored error, so that copy gets the explanation (pi's message stays as is).
          let m =
            live.stopReason === 'error' && live.errorMessage
              ? { ...live, errorMessage: explain(live.errorMessage) }
              : live.role === 'user' && textOf(live.content) === modelText
                ? { ...live, content: [{ type: 'text' as const, text }], ...(page && { page: { label: page.label, url: page.url } }), ...(resources.length && { resources }) }
                : live
          if (m.role === 'toolResult' && m.toolCallId && toolStarted.has(m.toolCallId)) {
            const started = toolStarted.get(m.toolCallId)!
            m = { ...m, durationMs: Math.max(0, Date.now() - started.at - (elapsedApprovalWait() - started.wait)) }
          }
          // The store's pattern scrub misses keys without a known shape (Gemini's AIza…); drop the active key by value.
          const content = apiKey && apiKey.length >= 16 ? JSON.parse(JSON.stringify(m).split(apiKey).join('[redacted]')) : m
          this.d.store.addMessage(conversationId, { role: m.role, content, tokensIn: m.usage?.input, tokensOut: m.usage?.output })
          // The stored [card_action] turn is the record now; the in-memory "accepted" mark can go.
          const clicked = m.role === 'user' ? parseCardAction(typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('')) : null
          if (clicked) this.pendingCards.get(conversationId)?.delete(clicked.cardId)
          if (m.role === 'assistant') emit({ type: 'usage', usage: this.usage(conversationId), month: this.monthUsage() })
        }
      })
      await agent.prompt(modelText)
      const reply = (): StoredAgentMessage | undefined => agent.state.messages.findLast((m) => m.role === 'assistant') as StoredAgentMessage | undefined
      const stopped = (): boolean => run.aborted || notice !== null || reply()?.stopReason === 'error' || reply()?.stopReason === 'aborted'
      // Hit a cap, or ended on tool calls alone or an empty reply: one hidden nudge per turn to answer from what it
      // found (after a cap, with tool calls blocked and a quiet note), then a notice, never silence.
      if (!stopped() && (limit || !hasAnswer(reply()))) {
        if (limit) {
          landing = true
          emit({ type: 'note', text: LIMIT_NOTE })
        }
        await agent.prompt(limit ? LIMIT_REQUEST : ANSWER_REQUEST)
        if (!stopped() && !hasAnswer(reply())) notice = limit ? `${limit}，已停止` : '助手没有给出文字回复'
      }
      const last = agent.state.messages.at(-1) as StoredAgentMessage | undefined
      // The failed reply is in the transcript, which the panel shows with its error; the toast is for elsewhere.
      if (last?.role === 'assistant' && last.stopReason === 'error') this.d.toast(`AI 助手：${this.clean(explain(last.errorMessage ?? '请求失败'), apiKey)}`)
      if (notice) reportError(notice)
    } catch (err) {
      fail(explain(err instanceof Error ? err.message : String(err)))
    } finally {
      clearTimeout(timer)
    }
  }
}
