/**
 * What every change adapter shares (plan §9.3): the adapter interface, diff lines, consequences, risk levels and
 * the small helpers the adapters are built from. Pure.
 */
import { createHmac, randomBytes } from 'node:crypto'
import type { TSchema } from 'typebox'
import type { Risk } from '../../../shared/ai'

export type DiffLine = { path: string; op: 'add' | 'remove' | 'change'; before?: string; after?: string }

/** modify: one changed item (a field, a tag, a rule), on `target` when the change spans several resources. */
export interface ChangeRow {
  target?: string
  item: string
  before: string
  after: string
}

/**
 * The readable change preview (the card's `change` block): what a person needs to check, in plain Chinese labels and
 * friendly values. create: the new thing as labelled fields. modify: only what changes (项目 / 当前 / 改为).
 * state: per resource, 运行中 → 已停止. delete: what goes, what stays. request: a generic request's params as rows.
 */
export interface Change {
  kind: 'create' | 'modify' | 'state' | 'delete' | 'request'
  /** The headline after 「在 <账号> · <region>」; default: the plan's title. */
  summary?: string
  fields?: { label: string; value: string; note?: string }[]
  rows?: ChangeRow[]
  states?: { name: string; from: string; to: string }[]
  removed?: { name: string; detail?: string }[]
  /** delete: what survives it (snapshots, EBS volumes, EIPs…). */
  kept?: string[]
  /** request: the params as pretty JSON, exactly as sent. */
  raw?: string
}

export const NONE = '无'
export const DELETED = '（删除）'

/** AWS state names as the card says them; unknown ones as they are. */
const STATE_LABEL: Record<string, string> = {
  running: '运行中', stopped: '已停止', stopping: '正在停止', pending: '正在启动', terminated: '已终止', 'shutting-down': '正在终止',
  available: '可用', rebooting: '正在重启', starting: '正在启动', deleting: '正在删除', 'in-use': '使用中',
  Enabled: '已开启', Suspended: '已暂停', Off: '从未开启'
}
export const stateLabel = (s: string): string => STATE_LABEL[s] ?? s

/** fieldDiff output as modify rows; `label` turns a path into the row's name. */
export const rowsOf = (lines: DiffLine[], label: (path: string) => string = (p) => p, target?: string): ChangeRow[] =>
  lines.map((l) => ({
    ...(target !== undefined && { target }),
    item: label(l.path),
    before: l.op === 'add' ? NONE : friendly(l.before),
    after: l.op === 'remove' ? DELETED : friendly(l.after)
  }))

/** `show`'s ∅ (empty) as words. */
const friendly = (v: string | undefined): string => (v === undefined || v === '∅' ? '（空）' : v)
export type ConsequenceKind = 'downtime' | 'irreversible' | 'cost' | 'dependency' | 'blast-radius' | 'data' | 'throttling'
export interface Consequence {
  kind: ConsequenceKind
  text: string
  monthlyUsd?: number
}

/** One AWS call for the proposal's account; region defaults to the proposal's. */
export type Call = (service: string, action: string, params: Record<string, unknown>, region?: string) => Promise<any>

export interface ChangeCtx {
  region: string
  call: Call
  /** Also the idempotency token / change set name where AWS has one. */
  proposalId: string
}

/** Pure output of an adapter's plan: everything the confirmation card says, derived by rules, never by the model. */
export interface Plan {
  /** 「停止 1 台 EC2 实例」 */
  title: string
  /** Resource ids / names, for the audit log. */
  targets: string[]
  /** What the user types when typing is required: one id or name, or a phrase for several. */
  confirmText: string
  risk: Risk
  reasons: string[]
  /** What the card shows as the change (presentation only: drift and hash never read it). */
  change: Change
  consequences: Consequence[]
  /** Why this change can't be proposed in the current state; the model gets them, no card is made. */
  blockers?: string[]
  /** The targets' tags: env=prod on any of them raises the risk (§9.5). */
  tags?: Record<string, string>[]
}

export interface ChangeAdapter<P = any, S = any> {
  service: string
  action: string
  /** Parameter summary for the tool description. */
  doc: string
  /** additionalProperties: false everywhere, so any parameter not listed is refused. */
  schema: TSchema
  /** Parameters refused with a specific reason (privilege escalation, code execution…), checked before the schema. */
  forbiddenParams?: Record<string, string>
  /** After validation: defaults, sorting, main-chosen tokens. The result is what is hashed and executed. */
  normalize?(p: P, ctx: ChangeCtx): P
  /** The region the resource lives in (S3 buckets), when it is not the conversation's. */
  locate?(p: P, call: Call): Promise<string>
  /** Side effect at proposal time that changes no resource (CloudFormation: create the change set). */
  prepare?(p: P, ctx: ChangeCtx): Promise<void>
  /** Read-only state the change depends on. Taken at proposal time and again right before execution. */
  snapshot(p: P, ctx: ChangeCtx): Promise<S>
  /** The part of a snapshot that must not have changed for the proposal to still hold. Default: all of it. */
  drift?(s: S): unknown
  plan(p: P, s: S): Plan
  /** EC2-style: the request can be sent with DryRun: true first. */
  dryRun?: boolean
  /** The AWS request for `action`. Default: the params as they are. */
  request?(p: P, s: S): Record<string, unknown>
  /** For changes that are not one plain request (merging current state, a different action). Gets the fresh snapshot. */
  execute?(p: P, s: S, ctx: ChangeCtx): Promise<any>
  /** Re-reads after execution; a one-line state summary. */
  verify?(p: P, ctx: ChangeCtx, response: any): Promise<string>
  /** Undoes `prepare` when the proposal goes away unexecuted. */
  discard?(p: P, ctx: ChangeCtx): Promise<void>
  /** Params as the audit log and the card may show them. */
  redact?(p: P): unknown
  /**
   * The resource ARNs the change acts on, for the IAM policy simulation that stands in for DryRun on services without
   * one. Absent: simulated against "*".
   */
  arns?(p: P, at: { region: string; account: string }): string[]
  /** IAM actions the change needs, when not just `${service}:${action}` (e.g. CreateBucket + PutPublicAccessBlock). */
  iamActions?: string[]
  /** The generic adapter (generic.ts): a request card instead of a diff; tier C is a strong approval. */
  generic?: { tier: 'B' | 'C'; dangers: string[] }
}

export const RISKS: Risk[] = ['low', 'medium', 'high', 'destructive']
export const riskAtLeast = (level: Risk, floor: Risk): Risk => (RISKS.indexOf(level) >= RISKS.indexOf(floor) ? level : floor)
export const bump = (level: Risk): Risk => RISKS[Math.min(RISKS.length - 1, RISKS.indexOf(level) + 1)]

/** Typed confirmation: high and destructive always; on a production account, everything from medium up. */
export const needsTyped = (level: Risk, production: boolean): boolean => level === 'high' || level === 'destructive' || (production && level !== 'low')

/** JSON with object keys sorted at every level: equal values give equal strings (hash, drift, dedupe). */
export function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v)) ?? 'null'
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v instanceof Date) return v.toISOString()
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])
    )
  }
  return v
}

/** A value as one short diff string. */
export function show(v: unknown): string {
  if (v === undefined || v === null || v === '') return '∅'
  const s = typeof v === 'string' ? v : canonical(v)
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

/**
 * Leaf-by-leaf diff of two records: nested objects become dotted paths, arrays of objects are indexed by their `id`
 * (else position), arrays of plain values compare as one value.
 */
export function fieldDiff(before: Record<string, unknown>, after: Record<string, unknown>, prefix = ''): DiffLine[] {
  const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
  const flat = (o: Record<string, unknown>, at: string, out: Map<string, string>): Map<string, string> => {
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue
      const path = at ? `${at}.${k}` : k
      if (isObj(v)) flat(v, path, out)
      else if (Array.isArray(v) && v.length && v.every(isObj)) {
        flat(Object.fromEntries(v.map((x, i) => [typeof x.id === 'string' ? x.id : String(i), x])), path, out)
      } else out.set(path, show(v))
    }
    return out
  }
  const b = flat(before, prefix, new Map())
  const a = flat(after, prefix, new Map())
  const lines: DiffLine[] = []
  for (const [path, v] of b) {
    if (!a.has(path)) lines.push({ path, op: 'remove', before: v })
    else if (a.get(path) !== v) lines.push({ path, op: 'change', before: v, after: a.get(path) })
  }
  for (const [path, v] of a) if (!b.has(path)) lines.push({ path, op: 'add', after: v })
  return lines
}

export const tagMap = (tags: { Key?: string; Value?: string }[] | undefined): Record<string, string> =>
  Object.fromEntries((tags ?? []).filter((t) => t.Key).map((t) => [t.Key as string, t.Value ?? '']))

/** env / environment / stage = prod, production, prd (§9.5). */
export const isProdTagged = (tags: Record<string, string>): boolean =>
  Object.entries(tags).some(([k, v]) => /^(env|environment|stage)$/i.test(k) && /^(prod|production|prd)$/i.test(v.trim()))

/** 「web-1（i-0abc）」 when there is a Name, else the id. A long Name is cut, so it can't push the id off a clipped title. */
export const named = (id: string, name?: string | null): string => (name ? `${name.length > 40 ? `${name.slice(0, 39)}…` : name}（${id}）` : id)

/** For typed confirmation: the one id, or a phrase naming the count for several. */
export const confirmFor = (ids: string[], phrase: string): string => (ids.length === 1 ? ids[0] : phrase)

/**
 * Reference on-demand prices, USD per hour, us-east-1, Linux / single-AZ, as the card's「参考价」(§9.6). Not a quote.
 * shortcut: a hand-kept table of common types; unknown types say「价格未知」. Switch to the Pricing API if exact numbers matter.
 */
export const EC2_HOURLY: Record<string, number> = {
  't2.micro': 0.0116, 't2.small': 0.023, 't2.medium': 0.0464, 't2.large': 0.0928,
  't3.nano': 0.0052, 't3.micro': 0.0104, 't3.small': 0.0208, 't3.medium': 0.0416, 't3.large': 0.0832, 't3.xlarge': 0.1664, 't3.2xlarge': 0.3328,
  't4g.micro': 0.0084, 't4g.small': 0.0168, 't4g.medium': 0.0336, 't4g.large': 0.0672, 't4g.xlarge': 0.1344,
  'm5.large': 0.096, 'm5.xlarge': 0.192, 'm5.2xlarge': 0.384, 'm5.4xlarge': 0.768,
  'm6i.large': 0.096, 'm6i.xlarge': 0.192, 'm6i.2xlarge': 0.384, 'm6g.large': 0.077, 'm6g.xlarge': 0.154,
  'm7i.large': 0.1008, 'm7i.xlarge': 0.2016, 'm7i.2xlarge': 0.4032, 'm7g.large': 0.0816, 'm7g.xlarge': 0.1632,
  'c5.large': 0.085, 'c5.xlarge': 0.17, 'c5.2xlarge': 0.34, 'c6i.large': 0.085, 'c6i.xlarge': 0.17, 'c7i.large': 0.0893, 'c7g.large': 0.0725,
  'r5.large': 0.126, 'r5.xlarge': 0.252, 'r6i.large': 0.126, 'r6i.xlarge': 0.252, 'r7i.large': 0.1323,
  'g4dn.xlarge': 0.526, 'g5.xlarge': 1.006, 'p3.2xlarge': 3.06, 'p4d.24xlarge': 32.7726
}
export const RDS_HOURLY: Record<string, number> = {
  'db.t3.micro': 0.017, 'db.t3.small': 0.034, 'db.t3.medium': 0.068, 'db.t3.large': 0.136,
  'db.t4g.micro': 0.016, 'db.t4g.small': 0.032, 'db.t4g.medium': 0.065, 'db.t4g.large': 0.129,
  'db.m5.large': 0.171, 'db.m5.xlarge': 0.342, 'db.m6g.large': 0.152, 'db.m6i.large': 0.171, 'db.m7g.large': 0.168,
  'db.r5.large': 0.25, 'db.r5.xlarge': 0.5, 'db.r6g.large': 0.225, 'db.r6i.large': 0.25, 'db.r7g.large': 0.239
}
export const HOURS_PER_MONTH = 730
export const monthly = (table: Record<string, number>, type: string | undefined, count = 1): number | undefined =>
  type && table[type] !== undefined ? Math.round(table[type] * HOURS_PER_MONTH * count * 100) / 100 : undefined
export const usd = (n: number): string => `$${n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`

/**
 * Stand-in for a secret value (Lambda environment variables) in snapshots: equal values match, the value itself is
 * not kept. HMAC with a per-run key, so the fingerprint is useless outside this process.
 */
const FINGERPRINT_KEY = randomBytes(32)
export const fingerprint = (value: string): string => createHmac('sha256', FINGERPRINT_KEY).update(value).digest('hex').slice(0, 16)

/** AWS SDK errors as「Code: message」, bounded. */
export function awsError(err: unknown): string {
  const e = err as { name?: string; message?: string }
  const msg = (e?.message ?? String(err)).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400)
  return e?.name && e.name !== 'Error' && !msg.startsWith(e.name) ? `${e.name}: ${msg}` : msg
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Request id of an SDK response, if any. */
export const requestIdOf = (r: unknown): string | undefined => (r as { $metadata?: { requestId?: string } } | undefined)?.$metadata?.requestId
