/**
 * The system cards of the change flow (plan §10.5 ③ and ⑤): the proposal card and the result card. Built only by
 * main from rule output, never from model text (the model's stated reason is shown labelled as such). Pure.
 */
import { createHash } from 'node:crypto'
import { Value } from 'typebox/value'
import type { Risk } from '../../../shared/ai'
import { CardSchema, PROPOSAL_RESULT_PREFIX, type AnalysisBlockData, type Block, type Card } from '../../../shared/cards'
import type { Change, Consequence } from './common'

export const clip = (s: string, n: number): string => {
  // Format characters (bidi overrides, zero-width) in AWS names could reorder or hide what the card says.
  const clean = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\p{Cf}/gu, '')
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean
}

/** Card ids are `c-` + 12 hex; proposal ids `p-` + 12 hex. Hashed with a purpose so the two cards of one proposal differ. */
const cardIdFor = (proposalId: string, purpose: string): string => `c-${createHash('sha256').update(`${purpose}:${proposalId}`).digest('hex').slice(0, 12)}`

export interface ProposalCardInput {
  id: string
  title: string
  risk: Risk
  reasons: string[]
  change: Change
  /** 「在 internal-tools · ap-northeast-1」: the headline's place, before the change's summary. */
  where: string
  consequences: Consequence[]
  facts: { label: string; value: string }[]
  createdAt: number
  expiresAt: number
  /** The AI impact analysis (generic proposals), already validated and clipped (analysis.ts). Makes the card v3. */
  analysis?: AnalysisBlockData
}

/** The plan's change as the card's `change` block: clipped to the schema, except a request's values (all of what runs). */
export function changeBlock(c: Change, summary: string): Extract<Block, { type: 'change' }> {
  // Generic requests are not clipped: the card must show all of what runs (the engine caps their params at 20 KB).
  const value = (v: string): string => (c.kind === 'request' ? v : clip(v, 1000))
  return {
    type: 'change',
    kind: c.kind,
    summary: clip(summary, 300),
    ...(c.fields && { fields: c.fields.slice(0, 300).map((f) => ({ label: clip(f.label, 200), value: value(f.value), ...(f.note && { note: clip(f.note, 300) }) })) }),
    ...(c.rows && { rows: c.rows.slice(0, 200).map((r) => ({ ...(r.target !== undefined && { target: clip(r.target, 300) }), item: clip(r.item, 300), before: clip(r.before, 1000), after: clip(r.after, 1000) })) }),
    ...(c.states && { states: c.states.slice(0, 50).map((s) => ({ name: clip(s.name, 300), from: clip(s.from, 100), to: clip(s.to, 100) })) }),
    ...(c.removed && { removed: c.removed.slice(0, 100).map((r) => ({ name: clip(r.name, 300), ...(r.detail && { detail: clip(r.detail, 300) }) })) }),
    ...(c.kept && { kept: c.kept.slice(0, 100).map((k) => clip(k, 300)) }),
    ...(c.raw !== undefined && { raw: c.raw })
  }
}

export function proposalCard(p: ProposalCardInput): Card {
  const blocks: Block[] = [
    { type: 'risk', level: p.risk, reasons: p.reasons.slice(0, 20).map((r) => clip(r, 300)) },
    changeBlock(p.change, `在 ${p.where} ${p.change.summary ?? p.title}`),
    ...(p.analysis ? [p.analysis] : []),
    { type: 'consequences', items: p.consequences.slice(0, 30).map((c) => ({ kind: c.kind, text: clip(c.text, 500), ...(c.monthlyUsd !== undefined && { monthlyUsd: c.monthlyUsd }) })) },
    { type: 'kv', items: p.facts.slice(0, 30).map((f) => ({ label: clip(f.label, 100), value: clip(f.value, 1000) })) }
  ]
  const card: Card = { v: p.analysis ? 3 : 2, id: cardIdFor(p.id, 'proposal'), origin: 'system', title: clip(p.title, 120), blocks, createdAt: p.createdAt, expiresAt: p.expiresAt, state: 'active' }
  if (!Value.Check(CardSchema, card)) throw new Error('内部错误：提案卡片无效')
  return card
}

export type ResultStatus = 'succeeded' | 'failed' | 'drifted' | 'cancelled'

/** The [proposal_result] turn: main writes it, the model reads it, history renders it as the result card. */
export interface ProposalResult {
  proposalId: string
  status: ResultStatus
  title: string
  summary?: string
  requestId?: string
  error?: string
  /** drifted: what changed since the proposal. */
  changes?: string[]
}

export const proposalResultText = (r: ProposalResult): string =>
  PROPOSAL_RESULT_PREFIX +
  JSON.stringify({
    proposalId: r.proposalId,
    status: r.status,
    title: clip(r.title, 120),
    ...(r.summary && { summary: clip(r.summary, 500) }),
    ...(r.requestId && { requestId: clip(r.requestId, 100) }),
    ...(r.error && { error: clip(r.error, 500) }),
    ...(r.changes?.length && { changes: r.changes.slice(0, 20).map((c) => clip(c, 300)) })
  })

const STATUSES: ResultStatus[] = ['succeeded', 'failed', 'drifted', 'cancelled']

export function parseProposalResult(text: string): ProposalResult | null {
  if (!text.startsWith(PROPOSAL_RESULT_PREFIX)) return null
  try {
    const r = JSON.parse(text.slice(PROPOSAL_RESULT_PREFIX.length)) as ProposalResult
    return typeof r?.proposalId === 'string' && /^p-[0-9a-f]{12}$/.test(r.proposalId) && STATUSES.includes(r.status) && typeof r.title === 'string' ? r : null
  } catch {
    return null
  }
}

const LABEL: Record<ResultStatus, { text: string; tone: 'ok' | 'danger' | 'warn' | 'neutral' }> = {
  succeeded: { text: '已执行', tone: 'ok' },
  failed: { text: '执行失败', tone: 'danger' },
  drifted: { text: '未执行：状态已变化', tone: 'warn' },
  cancelled: { text: '已取消', tone: 'neutral' }
}

const str = (v: unknown, n: number): string => clip(typeof v === 'string' ? v : '', n)

/** The result card for a [proposal_result] turn. Its fields are re-clipped: history may read them back from disk. */
export function resultCard(r: ProposalResult, at: number): Card {
  const label = LABEL[r.status]
  const kv = [
    { label: '提案', value: r.proposalId },
    ...(r.summary ? [{ label: '结果', value: str(r.summary, 1000) }] : []),
    ...(r.requestId ? [{ label: 'Request ID', value: str(r.requestId, 100), copy: true }] : [])
  ]
  const blocks: Block[] = [{ type: 'badges', items: [{ text: label.text, tone: label.tone }] }, { type: 'kv', items: kv }]
  if (r.status === 'failed') blocks.push({ type: 'error', message: '执行失败，没有自动重试', ...(r.error && { detail: str(r.error, 4000) }) })
  if (r.status === 'drifted') {
    const changes = Array.isArray(r.changes) ? r.changes.map((c) => str(c, 300)) : []
    blocks.push({ type: 'error', message: '确认时资源的状态和提案时不一样，为安全起见没有执行。请让助手重新查询并生成提案。' })
    // The engine's drift lines are「path：before → after」; one that isn't is shown whole.
    const rows = changes.slice(0, 20).map((c) => {
      const m = /^(.+?)：(.*) → (.*)$/s.exec(c)
      return m ? { item: m[1], before: m[2], after: m[3] } : { item: c, before: '', after: '' }
    })
    if (rows.length) blocks.push({ ...changeBlock({ kind: 'modify', rows }, '确认时发现这些地方变了'), heads: { before: '提案时', after: '确认时' } })
  }
  const card: Card = { v: 2, id: cardIdFor(r.proposalId, 'result'), origin: 'system', title: clip(`${label.text} · ${str(r.title, 100)}`, 120), blocks, createdAt: at, expiresAt: Number.MAX_SAFE_INTEGER, state: 'active' }
  if (!Value.Check(CardSchema, card)) throw new Error('内部错误：结果卡片无效')
  return card
}
