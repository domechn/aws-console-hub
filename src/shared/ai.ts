/** AI assistant types shared by main and renderer. No pi imports here: the renderer bundles this file. */
import type { Card, CardState } from './cards'

/** The key is write-only over IPC (see AiApi in api.ts): there is deliberately no read. */
export type SetKeyResult = { ok: true; persisted: boolean } | { ok: false; error: string }

/** Same id as main/ai/providers.ts registers (that file can't import this one; see its header). */
export const CUSTOM_PROVIDER_ID = 'custom-openai'
/** pi-ai's Bedrock id; providers.ts registers it with the app's own auth instead of pi's ambient AWS lookup. */
export const BEDROCK_PROVIDER_ID = 'amazon-bedrock'

/** Offered in settings, in this order. Ids are pi-ai provider ids (plus the custom endpoint). */
export const AI_PROVIDERS: { id: string; label: string }[] = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'google', label: 'Google Gemini' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: BEDROCK_PROVIDER_ID, label: 'AWS Bedrock' },
  { id: CUSTOM_PROVIDER_ID, label: 'OpenAI 兼容（自定义 baseURL）' }
]

/**
 * keychain: encrypted with safeStorage into userData/ai-keys.json (falls back to memory where that isn't safe).
 * memory: this run only. command: a shell command whose stdout is the key, run once per app run.
 */
export type AiKeyMode = 'keychain' | 'memory' | 'command'

/**
 * Bedrock only. account: SigV4 with one of the app's accounts, through main's credential pipeline (never stored,
 * never sent to the renderer or the model). apiKey: a Bedrock API key (bearer token), kept like any provider key.
 */
export type BedrockAuth = 'account' | 'apiKey'

/** Conversations older than this many days (by last message) are deleted; 0 = at the next start / quit, null = kept. */
export type ConversationRetention = 0 | 30 | 90 | null

/** Off when both limits are null. Tokens are input + output. */
export interface AiBudget {
  monthlyTokens: number | null
  monthlyUsd: number | null
  /** Past a limit, new turns are refused (otherwise only a warning). */
  block: boolean
}

/** userData/ai-config.json. Never holds a key. */
export interface AiConfig {
  version: 8
  /** '' until the user picks one. */
  provider: string
  model: string
  /** custom-openai only. */
  baseUrl: string | null
  /** Custom endpoints accept images only when the user opts in. */
  customImageInput: boolean
  keyMode: AiKeyMode
  keyCommand: string | null
  bedrockAuth: BedrockAuth
  /** The account whose credentials call Bedrock; may differ from the account being asked about. */
  bedrockAccountId: string | null
  /** Bedrock runtime region, independent of the console's. */
  bedrockRegion: string
  /** Optional AWS CLI v2 executable for services or operations without a bundled SDK command. */
  awsCliPath: string | null
  /** Audit rows older than this are pruned (at start and daily); younger ones never are. */
  auditRetentionDays: number
  conversationRetention: ConversationRetention
  budget: AiBudget
  /** read_current_page is offered to the model (visible page text, redacted, ≤ 8 KB). */
  readPage: boolean
  /** suggest_replies is offered to the model: chips under its reply that send their text when clicked. */
  quickReplies: boolean
  /** Generic (no-adapter) change proposals get an AI impact analysis before they can be confirmed (main/ai/analysis.ts). */
  impactAnalysis: boolean
  /** Script execution time, excluding approval waits. */
  scriptMaxMinutes: number
}

/** A quick-reply chip: `label` on the chip, `text` sent as a user message when it is clicked. Checked in main/ai/replies.ts. */
export interface QuickReply {
  label: string
  text: string
}

/** A resource (or page) the console URL names, as main/parser.ts reads it. */
export interface PageResource {
  service: string
  serviceLabel: string
  resourceType: string
  name: string
  /** The console tab ("对象", "属性"), when the URL says. */
  section?: string
}

/**
 * The page the user has open, as the model gets it each turn (main/ai/page.ts): a console URL without tokens, the
 * title, and what the parser recognised. Never page content; never a non-console URL (then there is none).
 */
export interface PageContext {
  url: string
  title: string
  region: string
  /** "S3 · my-bucket · 对象"; unrecognised: "Console 首页", the title (≤ 40 chars), or "AWS Console". */
  label: string
  /** A single resource's page. */
  resource?: PageResource
  /** A list or feature page (service + route) without a single resource. */
  route?: PageResource
}

export const AUDIT_RETENTION_LIMITS = { min: 30, max: 3650, default: 180 }

/** Typed (and compared in main) to delete the audit log along with the rest of the AI data. */
export const DELETE_AUDIT_PHRASE = '删除审计记录'

export interface AiConfigView extends AiConfig {
  /** A key is stored (or a key command is set) for the configured provider. The key itself is never sent. */
  hasKey: boolean
  /** safeStorage is usable; when false, "keychain" keys only live in memory. */
  canPersistKey: boolean
  /** Whether the configured model accepts image input. */
  canAttachImages: boolean
}

export const ATTACH_LIMITS = { fileCount: 7, imageCount: 4, fileCountPerMessage: 3, imageInputBytes: 12 * 1024 * 1024, imageOutputBytes: 3_740_000, textInputBytes: 1024 * 1024, textOutputBytes: 200 * 1024, textTotalBytes: 400 * 1024, payloadBytes: 12 * 1024 * 1024, pendingPerAccount: 8, pendingGlobal: 32, pendingTtlMs: 600_000, imageSidePx: 8000, imagePixels: 40_000_000, imageOutputSidePx: 1568, thumbnailSidePx: 256, thumbnailBytes: 60 * 1024 } as const

export interface AttachmentSource { name: string; bytes: Uint8Array; hintMime?: string }
export interface AttachmentMeta {
  id: string
  kind: 'image' | 'file'
  name: string
  size: number
  width?: number
  height?: number
  redactions?: number
  truncated?: boolean
  thumbDataUrl?: string
}
export type AttachmentPrepareResult =
  | ({ ok: true; warnings: string[] } & AttachmentMeta)
  | { ok: false; name: string; reason: string }
export type AttachmentContent = { kind: 'image'; dataUrl: string } | { kind: 'file'; text: string }

/** Catalog prices are USD per 1M tokens. */
export interface TokenRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface AiModelInfo {
  id: string
  name: string
  contextWindow: number
  reasoning: boolean
  cost: TokenRates
}

export interface AiTestResult {
  ok: boolean
  /** The model answered the test prompt with a tool call. */
  toolCalling: boolean
  latencyMs: number
  error?: string
}

export interface ConversationSummary {
  id: string
  title: string
  updatedAt: number
  pinned?: boolean
  status?: { running: boolean; awaitingApproval: boolean; pendingProposals: number }
}

export interface ResourceRef { type: string; id: string; region: string }
export interface ResourceContext { resources: ResourceRef[] }
export interface ResourceCandidate extends ResourceRef { label: string }
export interface ConversationSearchResult { id: string; title: string; snippet: string }
export interface QueuedMessage { id: string; text: string; context?: ResourceContext; attachmentIds?: string[]; attachments?: AttachmentMeta[] }
export const MAX_PROMPT_CHARS = 8000

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Estimate from catalog prices, USD. */
  cost: number
  /** Some replies came from a model with no catalog price (e.g. a typed-in Bedrock profile id); they are not in `cost`. */
  costUnknown: boolean
}

/** What the panel shows; built in main from the stored transcript (never raw tool results). */
export type ChatItem =
  /** `page`: the page label it was asked on, when page context was on. */
  | { kind: 'user'; text: string; page?: string; cardAction?: boolean; ordinal?: number; resources?: ResourceCandidate[]; attachments?: AttachmentMeta[] }
  | { kind: 'assistant'; text: string; error?: string; diagnosticText?: string; aborted?: boolean; retryable?: boolean; usage?: { input: number; output: number; costUsd?: number }; model?: string; ordinal?: number; feedback?: 'up' | 'down' | null }
  /** waiting: paused on an approval card (the approval item follows it). run_script: `code` and the `calls` it made (`ec2:DescribeInstances ×3`), shown on expand. */
  | { kind: 'tool'; id: string; label: string; status: 'running' | 'waiting' | 'ok' | 'error'; summary?: string; code?: string; calls?: string[]; ms?: number; seconds?: number; callCount?: number }
  /** A render_card call (`id` is the tool call's); `card` is null while it streams (skeleton). */
  | { kind: 'card'; id: string; card: Card | null }
  /** A propose_change call that made a proposal (`id` is the tool call's). */
  | { kind: 'proposal'; id: string; proposal: ProposalView }
  /** A call that waited for the user's approval (`id` is the approval's). */
  | { kind: 'approval'; id: string; approval: ApprovalView }
  /** suggest_replies (`id` is the tool call's): chips, shown only while nothing came after the reply (renderer's visibleReplies). */
  | { kind: 'replies'; id: string; options: QuickReply[] }
  /** A quiet line from main (e.g. the step cap was reached, the answer below is from what was found). */
  | { kind: 'note'; text: string }

/** This calendar month (local time), every account and conversation, deleted ones included; and the budget's verdict. */
export interface MonthUsage {
  totals: UsageTotals
  /** A warning once 80% of a limit is used; null without a budget or below that. */
  budget: string | null
  /** A limit is passed and the budget blocks: new turns are refused. */
  blocked: boolean
}

export interface ConversationView {
  items: ChatItem[]
  usage: UsageTotals
  month: MonthUsage
  /** The conversation sends the current page each turn (its chip's ×). */
  pageContext: boolean
  queue?: QueuedMessage[]
}

/** main → renderer `ai:event`. Display data only. */
export type AiEvent =
  | { type: 'model-status'; status: 'waiting' | 'retrying' | 'received'; startedAt: number }
  | { type: 'text-delta'; text: string }
  /** `code`: run_script's script, shown read-only on the row. */
  | { type: 'tool-start'; id: string; label: string; code?: string; t?: number }
  | { type: 'tool-progress'; id: string; seconds: number; calls?: number }
  | { type: 'tool-end'; id: string; ok: boolean; summary?: string; calls?: string[]; t?: number }
  /** A render_card call started streaming; `card`, or a failed tool-end, follows. */
  | { type: 'card-pending'; id: string }
  | { type: 'card'; id: string; card: Card }
  | { type: 'card-state'; cardId: string; state: CardState }
  /** A user turn main started itself (a card button's reply), as the panel shows it. */
  | { type: 'user'; text: string; resources?: ResourceCandidate[]; attachments?: AttachmentMeta[] }
  | { type: 'queue'; items: QueuedMessage[] }
  | { type: 'queue-failed'; id: string; text: string; context?: ResourceContext; resources?: ResourceCandidate[]; attachmentIds?: string[]; message: string }
  /** propose_change made a proposal (`id` is the tool call's). */
  | { type: 'proposal'; id: string; proposal: ProposalView }
  /** A proposal changed state (confirmed, executed, cancelled, expired, drifted). Not part of a run. */
  | { type: 'proposal-state'; proposal: ProposalView }
  /** The system card with a proposal's outcome (`id` is the item's). Not part of a run; a follow-up run may come. */
  | { type: 'proposal-result'; id: string; card: Card }
  /** An approval was requested, or changed state (allowed, denied, expired, aborted). Built only by main. */
  | { type: 'approval'; approval: ApprovalView }
  /** suggest_replies' chips, as main validated them (`id` is the tool call's). */
  | { type: 'replies'; id: string; options: QuickReply[] }
  | { type: 'usage'; usage: UsageTotals; month: MonthUsage }
  /** A quiet line in the reply (not an error). */
  | { type: 'note'; text: string }
  | { type: 'error'; message: string; retryable?: boolean }
  | { type: 'done' }

export interface AiEventEnvelope {
  accountId: string
  conversationId: string
  runId: number
  event: AiEvent
}

export type CardActionResult = { ok: true } | { ok: false; error: string }

export type Risk = 'low' | 'medium' | 'high' | 'destructive'
export const RISK_LEVELS: Risk[] = ['low', 'medium', 'high', 'destructive']
export const RISK_LABEL: Record<Risk, string> = { low: '低', medium: '中', high: '高', destructive: '破坏性' }

/** The account policy's entry for every service without an adapter (generic requests). */
export const OTHER_SERVICES = 'other'

/**
 * Services with change adapters (IAM prefixes), plus OTHER_SERVICES for the rest, for the account's AI policy. A test
 * keeps the adapter part equal to the write table's.
 */
export const AI_CHANGE_SERVICES: { id: string; label: string }[] = [
  { id: 'ec2', label: 'EC2（实例、安全组、标签、卷）' },
  { id: 'rds', label: 'RDS' },
  { id: 'lambda', label: 'Lambda（配置）' },
  { id: 's3', label: 'S3（桶级）' },
  { id: 'dynamodb', label: 'DynamoDB（表设置）' },
  { id: 'ecs', label: 'ECS（任务数）' },
  { id: 'autoscaling', label: 'Auto Scaling（容量）' },
  { id: 'cloudformation', label: 'CloudFormation（change set）' },
  { id: 'tag', label: '通用标签（Tagging API）' },
  { id: OTHER_SERVICES, label: '其他服务（通用请求：原样展示参数，每项输入操作名确认；含 IAM、KMS 等强确认操作）' }
]

/** One audit row as the in-app viewer shows it: a summary, never params, results or keys. */
export interface AuditView {
  id: number
  t: number
  type: string
  accountId: string | null
  conversationId?: string
  proposalId?: string
  service?: string
  action?: string
  risk?: Risk
  targets?: string[]
  actor?: string
  /** Outcome, refusal reason or error, bounded. */
  detail?: string
  requestId?: string
}

export interface AuditFilter {
  accountId?: string
  /** Rows from this many days back. */
  days?: number
  risk?: Risk
  /** changes: proposal and policy rows only; all: tool calls too. */
  scope?: 'changes' | 'all'
}

/**
 * pending: waiting for the user. executing: confirmed, running in main. succeeded / failed: executed.
 * cancelled: by the user. expired: TTL passed (or the app restarted). superseded: the resource changed after the
 * proposal was made (drift), or the account's login changed, so it was not executed.
 */
export type ProposalState = 'pending' | 'executing' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'superseded'

/** A change proposal as the panel shows it. Built only by main (an origin=system card); it has no nonce and no params to send back. */
export interface ProposalView {
  id: string
  state: ProposalState
  title: string
  risk: Risk
  accountName: string
  /** 12-digit AWS account id. */
  awsAccountId: string
  region: string
  production: boolean
  createdAt: number
  expiresAt: number
  /** What the user must type to confirm (a resource id or name), compared in main; absent when no typing is needed. */
  confirmText?: string
  /** Risk, diff, consequences and facts, as an origin=system card. */
  card: Card
  /** After execution, or why it was not executed. */
  outcome?: string
  /** No adapter: a generic request card (params as they will be sent, no snapshot, no drift check). */
  generic?: boolean
  /** B: asked because no adapter knows it; C: strong approval (danger table). Absent for adapter proposals. */
  tier?: 'B' | 'C'
  /** Tier C: the operation's categories (neutral labels, not predicted effects), for the red banner. */
  dangers?: string[]
  /** The card needs AWS CLI, but no executable was found when it was built. */
  cliUnavailable?: boolean
  /** The AI impact analysis (generic proposals, when on): confirm waits while it runs. Its content is on the card. */
  analysis?: { status: 'running' | 'done' | 'failed'; calls: number }
}

/**
 * pending: waiting for the user. allowed / denied: decided. expired: no decision in 5 minutes (treated as denied).
 * aborted: the run was stopped meanwhile.
 */
export type ApprovalState = 'pending' | 'allowed' | 'denied' | 'expired' | 'aborted'
/** once: this call. session: this call, and the same service:action:region (reads only) for the rest of the conversation. */
export type ApprovalDecision = 'once' | 'session' | 'deny'
export const APPROVAL_DECISIONS: ApprovalDecision[] = ['once', 'session', 'deny']

/** A paused call as the approval card shows it. Built only by main; the renderer sends back the id and a decision. */
export interface ApprovalView {
  id: string
  /** The tool call it belongs to (the panel puts the card under its row). */
  toolCallId: string
  state: ApprovalState
  decision?: ApprovalDecision
  service: string
  action: string
  region: string
  accountName: string
  awsAccountId: string
  /** The complete params exactly as they will be sent (pretty JSON). */
  params: string
  /** The model's one-line reason, labelled as such on the card. */
  reason: string
  /** Why the app asks (rules, not the model). */
  why: string[]
  /** "本对话内一直允许此动作" is offered. Never for sensitive reads, unknown names or other accounts' ARNs. */
  sessionAllowed: boolean
  createdAt: number
  expiresAt: number
  /** sha256 of what will run (a prefix is shown on the card). */
  hash: string
}

/** An "always allow in this conversation" entry (AI 设置 → 本对话已允许的动作). */
export interface SessionAllowView {
  accountId: string
  conversationId: string
  conversationTitle: string
  /** service:action:region */
  key: string
  at: number
}

export interface AiSendResult {
  conversationId: string
  runId: number
  queued?: { id: string }
  /** The monthly budget is nearly or fully used (and does not block). */
  warning?: string
}

/** What a tool call does, e.g. 「查询 EC2 实例」; the panel shows 「正在查询 EC2 实例…」 while it runs. */
export function toolLabel(name: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const labels: Record<string, string> = {
    aws_whoami: '确认当前身份',
    list_ec2_instances: '查询 EC2 实例',
    describe_ec2_instance: `查看 EC2 实例 ${String(a.instanceId ?? '')}`,
    list_s3_buckets: '查询 S3 存储桶',
    describe_s3_bucket: `查看 S3 桶 ${String(a.bucket ?? '')}`,
    read_current_page: '读取当前页面',
    list_lambda_functions: '查询 Lambda 函数',
    list_rds_instances: '查询 RDS 实例',
    list_log_groups: '查询日志组',
    get_metrics: `查询指标 ${String(a.metricName ?? '')}`,
    query_logs: '查询日志',
    cost_summary: '查询成本',
    aws_read: `调用 ${String(a.service ?? '')}:${String(a.action ?? '')}`,
    run_script: '运行脚本',
    propose_change: `提议变更 ${String(a.service ?? '')}:${String(a.action ?? '')}`,
    render_card: '生成卡片',
    suggest_replies: '快捷回复'
  }
  return (labels[name] ?? `调用 ${name}`).trim()
}

/** run_script's code as the panel shows it (the tool's own limit), or undefined for other tools / bad input. */
export const scriptCode = (name: string, args: unknown): string | undefined => {
  const code = name === 'run_script' && args && typeof args === 'object' ? (args as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code.slice(0, 8000) : undefined
}

/** run_script's call list from its result details (read back from disk: checked). */
export const scriptCalls = (details: unknown): string[] | undefined => {
  const calls = (details as { calls?: unknown } | undefined)?.calls
  return Array.isArray(calls) ? calls.filter((c): c is string => typeof c === 'string').slice(0, 50).map((c) => c.slice(0, 120)) : undefined
}
