// No relative imports: scripts/ai-audit.mjs runs this file under plain Node (type stripping).
/**
 * "What did the AI change in the last N days?" from the audit table of ai.sqlite (plan §9.9). Pure. Executions are
 * joined with their proposal_created row for targets and risk; the digest, the CSV and the in-app viewer name
 * actions, ids and outcomes, never params or results.
 */

export interface AuditRow {
  id?: number
  t: number
  type: string
  accountId: string | null
  data: Record<string, any>
}

/** One row as people see it (the in-app viewer's AuditView has the same shape). */
export interface AuditSummary {
  id: number
  t: number
  type: string
  accountId: string | null
  conversationId?: string
  proposalId?: string
  service?: string
  action?: string
  risk?: 'low' | 'medium' | 'high' | 'destructive'
  targets?: string[]
  actor?: string
  detail?: string
  requestId?: string
}

const COUNTED = [
  ['proposal_created', '提出'],
  ['proposal_confirmed', '确认'],
  ['proposal_executed', '已执行'],
  ['proposal_failed', '失败'],
  ['proposal_drift', '漂移未执行'],
  ['proposal_cancelled', '取消'],
  ['proposal_expired', '过期'],
  ['confirm_rejected', '确认被拒'],
  ['proposal_refused', '提案被拒'],
  ['forbidden_attempt', '禁止的尝试'],
  ['approval_requested', '请求审批'],
  ['approval_allowed', '审批允许'],
  ['approval_denied', '审批拒绝']
] as const

/** Proposal, approval and policy rows: what "changes" means in a filter. Tool calls and refusals of reads are the rest. */
export const CHANGE_TYPES = new Set<string>([
  ...COUNTED.map(([t]) => t),
  'proposal_tampered',
  'proposal_analysis',
  'approval_expired',
  'approval_aborted',
  'approval_auto',
  'approval_auto_denied',
  'approval_rate_limited',
  'approval_revoked',
  'approval_tampered'
])

const RISK: Record<string, string> = { low: '低', medium: '中', high: '高', destructive: '破坏性' }
const RISKS = ['low', 'medium', 'high', 'destructive']

const stamp = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
const str = (v: unknown, max = 300): string | undefined => (typeof v === 'string' && v ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, max) : undefined)

/** proposal id → its proposal_created row, which carries the service, action, risk and targets. */
export const createdIndex = (rows: AuditRow[]): Map<string, AuditRow> =>
  new Map(rows.filter((r) => r.type === 'proposal_created' && typeof r.data?.proposalId === 'string').map((r) => [r.data.proposalId as string, r]))

/** A row's summary: whitelisted fields only (no params, no tool arguments), strings bounded. */
export function summarize(r: AuditRow, created: Map<string, AuditRow>): AuditSummary {
  const d = r.data ?? {}
  const c = (typeof d.proposalId === 'string' ? created.get(d.proposalId)?.data : undefined) ?? {}
  const risk = RISKS.includes(d.risk) ? d.risk : RISKS.includes(c.risk) ? c.risk : undefined
  const targets = Array.isArray(d.targets) ? d.targets : Array.isArray(c.targets) ? c.targets : undefined
  const detail =
    r.type === 'proposal_executed'
      ? str(d.summary)
      : r.type === 'proposal_failed'
        ? str(d.error)
        : r.type === 'proposal_drift'
          ? str(Array.isArray(d.changes) ? d.changes[0] : undefined)
          : r.type === 'proposal_analysis'
            ? `${str(d.status, 20) ?? '?'} · ${Number(d.calls) || 0} 次查询${d.riskRaised ? ` · 风险 ${RISK[d.riskRaised.from] ?? '?'} → ${RISK[d.riskRaised.to] ?? '?'}` : ''}${str(d.cause, 120) ? ` · ${str(d.cause, 120)}` : ''}`
            : r.type === 'tool_call'
            ? `${str(d.tool, 60) ?? '?'}${d.ok === false ? ` · 失败 ${str(d.error, 200) ?? ''}` : ''}`
            : (str(d.reason) ?? str(d.cause, 60) ?? str(d.decision, 20))
  return {
    id: r.id ?? 0,
    t: r.t,
    type: r.type,
    accountId: r.accountId,
    ...(str(d.conversationId, 64) && { conversationId: str(d.conversationId, 64) }),
    ...(str(d.proposalId, 20) && { proposalId: str(d.proposalId, 20) }),
    ...((str(d.service, 40) ?? str(c.service, 40)) && { service: str(d.service, 40) ?? str(c.service, 40) }),
    ...((str(d.action, 100) ?? str(c.action, 100)) && { action: str(d.action, 100) ?? str(c.action, 100) }),
    ...(risk && { risk }),
    ...(targets && { targets: targets.slice(0, 20).map((t: unknown) => str(String(t), 200) ?? '') }),
    ...(str(d.actor, 20) && { actor: str(d.actor, 20) }),
    ...(detail && { detail }),
    ...(str(d.requestId, 100) && { requestId: str(d.requestId, 100) })
  }
}

export interface AuditQuery {
  since?: number
  until?: number
  /** App account ids (accounts.json `id`); absent = all. */
  accounts?: Set<string>
  /** Rows whose proposal has one of these risks; rows without a risk drop out. */
  risks?: Set<string>
  changesOnly?: boolean
}

/** Rows matching `q`. Risk comes from the row or its proposal_created row (looked up in all of `rows`). */
export function filterAudit(rows: AuditRow[], q: AuditQuery): AuditRow[] {
  const created = q.risks ? createdIndex(rows) : new Map<string, AuditRow>()
  return rows.filter((r) => {
    if (q.since !== undefined && r.t < q.since) return false
    if (q.until !== undefined && r.t > q.until) return false
    if (q.accounts && !q.accounts.has(r.accountId ?? '')) return false
    if (q.changesOnly && !CHANGE_TYPES.has(r.type)) return false
    if (q.risks) {
      const risk = r.data?.risk ?? (typeof r.data?.proposalId === 'string' ? created.get(r.data.proposalId)?.data?.risk : undefined)
      if (!q.risks.has(risk)) return false
    }
    return true
  })
}

const CSV_COLUMNS: (keyof AuditSummary)[] = ['t', 'type', 'accountId', 'proposalId', 'service', 'action', 'risk', 'targets', 'actor', 'detail', 'requestId', 'conversationId']

/** RFC 4180 CSV of the summaries; a leading =+-@ is quoted away so a spreadsheet does not run it as a formula. */
export function auditCsv(rows: AuditSummary[], accountName?: (id: string) => string | undefined): string {
  const cell = (v: unknown): string => {
    let s = (Array.isArray(v) ? v.join(' ') : v === undefined || v === null ? '' : String(v)).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = [...CSV_COLUMNS.map((c) => (c === 't' ? 'time_utc' : c)), 'account_name']
  const lines = rows.map((r) => [...CSV_COLUMNS.map((c) => cell(c === 't' ? new Date(r.t).toISOString() : r[c])), cell(r.accountId ? accountName?.(r.accountId) : '')].join(','))
  return [head.join(','), ...lines].join('\r\n')
}

export interface DigestOptions {
  now: number
  days: number
  /** Overrides `days` as the start of the period. */
  since?: number
  accountName?: (id: string) => string | undefined
}

/** Per account: counts, then executions grouped by day (UTC), then forbidden attempts. `rows` may be pre-filtered. */
export function auditDigest(rows: AuditRow[], o: DigestOptions): string {
  const since = o.since ?? o.now - o.days * 86400_000
  const recent = rows.filter((r) => r.t >= since && r.t <= o.now)
  const created = createdIndex(rows)
  const days = Math.max(1, Math.round((o.now - since) / 86400_000))
  const lines = [`AI 变更审计 · 过去 ${days} 天（${stamp(since).slice(0, 10)} ~ ${stamp(o.now).slice(0, 10)}，UTC）`]
  const accounts = [...new Set(recent.filter((r) => CHANGE_TYPES.has(r.type)).map((r) => r.accountId ?? '?'))]
  if (!accounts.length) return [...lines, '', '没有任何变更提案。'].join('\n')
  for (const acc of accounts) {
    const mine = recent.filter((r) => (r.accountId ?? '?') === acc)
    const name = o.accountName?.(acc)
    lines.push('', `账号 ${name ? `${name}（${acc}）` : acc}`)
    lines.push(`  ${COUNTED.map(([type, label]) => `${label} ${mine.filter((r) => r.type === type).length}`).join(' · ')}`)
    const done = mine.filter((r) => r.type === 'proposal_executed' || r.type === 'proposal_failed' || r.type === 'proposal_drift')
    if (done.length) {
      lines.push('  执行记录：')
      let day = ''
      for (const r of done) {
        if (stamp(r.t).slice(0, 10) !== day) {
          day = stamp(r.t).slice(0, 10)
          lines.push(`   ${day}`)
        }
        const s = summarize(r, created)
        const targets = (s.targets ?? []).slice(0, 5).join(', ')
        const outcome =
          r.type === 'proposal_executed'
            ? `✓ 成功${s.requestId ? ` · ${s.requestId}` : ''}${s.detail ? ` · ${s.detail}` : ''}`
            : r.type === 'proposal_failed'
              ? `✗ 失败 · ${s.detail ?? ''}`
              : `⚠ 状态已变化，未执行${s.detail ? ` · ${s.detail}` : ''}`
        lines.push(`    ${`${stamp(r.t).slice(11)}  ${s.service ?? '?'}:${s.action ?? '?'}  ${targets}  ${s.risk ? `${RISK[s.risk]}风险` : ''}  ${outcome}  [${s.proposalId ?? ''}]`.replace(/ {3,}/g, '  ')}`)
      }
    }
    const forbidden = new Map<string, number>()
    for (const r of mine.filter((x) => x.type === 'forbidden_attempt')) {
      const key = `${r.data.service}:${r.data.action}${r.data.param ? `（参数 ${r.data.param}）` : ''}`
      forbidden.set(key, (forbidden.get(key) ?? 0) + 1)
    }
    if (forbidden.size) lines.push(`  被禁止的尝试：${[...forbidden].map(([k, n]) => `${k} ×${n}`).join('，')}`)
  }
  // Rows hold model-written and AWS strings (tag values in drift lines): no escape sequence reaches the terminal.
  return lines.join('\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
}

/** `--since`: an ISO date (UTC midnight) or "<n>d". NaN when neither. */
export function parseSince(v: string, now: number): number {
  const rel = /^(\d{1,4})d$/.exec(v)
  if (rel) return now - Number(rel[1]) * 86400_000
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN
}
