import { scriptCalls, scriptCode, toolLabel, type ApprovalView, type AttachmentMeta, type ChatItem, type ProposalState, type ProposalView, type ResourceCandidate, type TokenRates, type UsageTotals } from '../../shared/ai'
import type { Card } from '../../shared/cards'
import { cardActionLabel, cardState, parseCardAction } from './cards'
import { parseProposalResult, resultCard, type ProposalResult, type ResultStatus } from './changes/card'
import { checkReplies } from './replies'

/** Stored transcript → what the panel shows, and token/cost totals. Pure; structural on pi's message shapes. */

interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface Part {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: unknown
}

export interface StoredAgentMessage {
  role: string
  content?: string | Part[]
  toolCallId?: string
  isError?: boolean
  details?: unknown
  stopReason?: string
  errorMessage?: string
  usage?: Usage
  provider?: string
  model?: string
  timestamp?: number
  durationMs?: number
  error?: string
  retryable?: boolean
  diagnosticText?: string
  /** User turns: the page they were asked on (app metadata, not sent to the model). */
  page?: { label: string; url: string }
  rowId?: number
  resources?: ResourceCandidate[]
  attachments?: AttachmentMeta[]
  feedback?: 'up' | 'down' | null
}

/** USD for `usage` at catalog `rates` ($ per 1M tokens). shortcut: ignores long-context price tiers; add them if a priced model in use has tiers. */
export function estimateCost(rates: TokenRates, usage: Usage): number {
  return (usage.input * rates.input + usage.output * rates.output + usage.cacheRead * rates.cacheRead + usage.cacheWrite * rates.cacheWrite) / 1e6
}

export function sumUsage(messages: StoredAgentMessage[], ratesFor: (provider: string, model: string) => TokenRates | undefined): UsageTotals {
  const total: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costUnknown: false }
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.usage) continue
    total.input += m.usage.input
    total.output += m.usage.output
    total.cacheRead += m.usage.cacheRead
    total.cacheWrite += m.usage.cacheWrite
    const rates = ratesFor(m.provider ?? '', m.model ?? '')
    // A catalog entry priced all zero (custom endpoints, typed-in ids) is "no price", not free.
    if (rates && (rates.input || rates.output)) total.cost += estimateCost(rates, m.usage)
    else total.costUnknown = true
  }
  return total
}

export const textOf = (content: StoredAgentMessage['content']): string =>
  typeof content === 'string' ? content : (content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('')

/** The message is an assistant reply with some answer text (not only tool calls). */
export const hasAnswer = (m: StoredAgentMessage | undefined): boolean => m?.role === 'assistant' && textOf(m.content).trim() !== ''

/** Main's one nudge when a run ended without answer text; stored, never shown as something the user said. */
export const ANSWER_REQUEST = '[answer_request] 你还没有用文字回答用户。请根据上面的工具结果，用文字写出完整的回答。'

/** The same nudge when the run hit a step cap: a last round without tools. Shown as LIMIT_NOTE, a quiet line. */
export const LIMIT_REQUEST = '[answer_request] 已达到本轮步骤上限。请只根据已有的工具结果给出最终回答，说明哪些没来得及查，不要再调用工具。'
export const LIMIT_NOTE = '已达到步骤上限，以下基于已有结果'

const cardOf = (m: StoredAgentMessage): Card | undefined =>
  m.role === 'toolResult' && !m.isError ? (m.details as { card?: Card } | undefined)?.card : undefined

/**
 * Every card in the conversation with its state at `now`. The transcript is the record: a card is resolved once a
 * [card_action] turn for it is stored (or `pending` has a click main accepted that is still queued), superseded
 * once a later card names it.
 */
export function transcriptCards(messages: StoredAgentMessage[], now: number, pending: ReadonlySet<string> = new Set()): Map<string, Card> {
  const cards = new Map<string, Card>()
  const resolved = new Set(pending)
  const superseded = new Set<string>()
  for (const m of messages) {
    const card = cardOf(m)
    if (card) {
      cards.set(card.id, card)
      if (card.supersedes) superseded.add(card.supersedes)
    } else if (m.role === 'user') {
      const action = parseCardAction(textOf(m.content))
      if (action) resolved.add(action.cardId)
    }
  }
  for (const [id, c] of cards) cards.set(id, { ...c, state: cardState(c, now, resolved.has(id), superseded.has(id)) })
  return cards
}

const proposalOf = (m: StoredAgentMessage): ProposalView | undefined =>
  m.role === 'toolResult' && !m.isError ? (m.details as { proposal?: ProposalView } | undefined)?.proposal : undefined

const RESULT_STATE: Record<ResultStatus, ProposalState> = { succeeded: 'succeeded', failed: 'failed', drifted: 'superseded', cancelled: 'cancelled' }

/**
 * A stored proposal snapshot (taken when it was made, so "pending") with its state now: what main still holds in
 * memory, else what its [proposal_result] turn says, else expired (the TTL passed or the app restarted: pending
 * proposals only live in memory).
 */
function proposalNow(snap: ProposalView, results: Map<string, ProposalResult>, live?: (id: string) => ProposalView | undefined): ProposalView {
  const current = live?.(snap.id)
  if (current) return current
  // Stored when it was made, so its analysis was still running; nothing will finish that one now.
  if (snap.analysis) {
    snap = { ...snap, analysis: { ...snap.analysis, status: 'failed' }, card: { ...snap.card, blocks: snap.card.blocks.filter((b) => b.type !== 'analysis') } }
  }
  const r = results.get(snap.id)
  if (r) return { ...snap, state: RESULT_STATE[r.status], outcome: r.summary ?? r.error ?? r.changes?.[0] ?? '' }
  return snap.state === 'pending' || snap.state === 'executing' ? { ...snap, state: 'expired' } : snap
}

/** The approvals a call waited for: aws_read's one, or run_script's list. */
const approvalsOf = (m: StoredAgentMessage): ApprovalView[] => {
  const d = m.details as { approval?: ApprovalView; approvals?: unknown } | undefined
  const list = Array.isArray(d?.approvals) ? (d.approvals as ApprovalView[]) : d?.approval ? [d.approval] : []
  return list.filter((a) => a && typeof a.id === 'string' && /^a-[0-9a-f]{12}$/.test(a.id))
}

/**
 * `live`: main's in-memory proposals (their current state). `liveApproval`: an approval a call is waiting on now,
 * by tool call id (its result is not stored yet).
 */
export function toChatItems(
  messages: StoredAgentMessage[],
  now = Date.now(),
  pending?: ReadonlySet<string>,
  live?: (proposalId: string) => ProposalView | undefined,
  liveApproval?: (toolCallId: string) => ApprovalView | undefined,
  ratesFor?: (provider: string, model: string) => TokenRates | undefined
): ChatItem[] {
  const cards = transcriptCards(messages, now, pending)
  const results = new Map<string, ProposalResult>()
  for (const m of messages) {
    const r = m.role === 'user' ? parseProposalResult(textOf(m.content)) : null
    if (r) results.set(r.proposalId, r)
  }
  const items: ChatItem[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  const replyCalls = new Set<string>()
  const toolStarted = new Map<string, number>()
  let turnUsage: { input: number; output: number; costUsd?: number } | undefined
  let turnModel: string | undefined
  let turnAssistant: Extract<ChatItem, { kind: 'assistant' }> | undefined
  let userOrdinal = 0
  let assistantOrdinal = 0
  for (const m of messages) {
    if (m.role === 'note') {
      items.push(m.error ? { kind: 'assistant', text: '', error: m.error, ...(m.diagnosticText && { diagnosticText: m.diagnosticText }), ...(m.retryable === false && { retryable: false }) } : { kind: 'note', text: textOf(m.content) })
    } else if (m.role === 'user') {
      const text = textOf(m.content)
      if (text !== ANSWER_REQUEST && text !== LIMIT_REQUEST) {
        turnUsage = undefined
        turnModel = undefined
        turnAssistant = undefined
      }
      if (text === ANSWER_REQUEST) continue
      if (text === LIMIT_REQUEST) {
        items.push({ kind: 'note', text: LIMIT_NOTE })
        continue
      }
      // main's own turn with a proposal's outcome: shown as the result card, not as something the user said.
      const result = parseProposalResult(text)
      if (result) {
        items.push({ kind: 'card', id: `r-${result.proposalId}`, card: resultCard(result, now) })
        continue
      }
      const action = parseCardAction(text)
      const page = typeof m.page?.label === 'string' ? m.page.label : undefined
      items.push({ kind: 'user', text: action ? cardActionLabel(action) : text, ...(action && { cardAction: true }), ...(page && { page }), ...(m.rowId !== undefined && { ordinal: userOrdinal }), ...(m.resources?.length && { resources: m.resources }), ...(m.attachments?.length && { attachments: m.attachments }) })
      userOrdinal++
    } else if (m.role === 'assistant') {
      if (m.usage) {
        const rates = ratesFor?.(m.provider ?? '', m.model ?? '')
        const cost = rates && (rates.input || rates.output) ? estimateCost(rates, m.usage) : undefined
        turnUsage = {
          input: (turnUsage?.input ?? 0) + m.usage.input,
          output: (turnUsage?.output ?? 0) + m.usage.output,
          ...(cost !== undefined && (turnUsage === undefined || turnUsage.costUsd !== undefined) && { costUsd: (turnUsage?.costUsd ?? 0) + cost })
        }
      }
      if (m.model) turnModel = m.model
      const text = textOf(m.content)
      const error = m.stopReason === 'error' ? (m.errorMessage ?? '请求失败') : undefined
      if (text || error || m.stopReason === 'aborted') {
        turnAssistant = { kind: 'assistant', text, ...(error && { error }), ...(m.diagnosticText && { diagnosticText: m.diagnosticText }), ...(m.stopReason === 'aborted' && { aborted: true }), ...(m.rowId !== undefined && { ordinal: assistantOrdinal }), ...(m.feedback && { feedback: m.feedback }) }
        items.push(turnAssistant)
        assistantOrdinal++
      }
      if (turnAssistant) Object.assign(turnAssistant, { ...(turnUsage && { usage: turnUsage }), ...(turnModel && { model: turnModel }) })
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p.type !== 'toolCall' || !p.id) continue
        // No tool row: its result becomes the chips.
        if (p.name === 'suggest_replies') {
          replyCalls.add(p.id)
          continue
        }
        const code = scriptCode(p.name ?? '', p.arguments)
        const item = { kind: 'tool' as const, id: p.id, label: toolLabel(p.name ?? '', p.arguments), status: 'running' as const, ...(code !== undefined && { code }) }
        tools.set(p.id, item)
        if (Number.isFinite(m.timestamp)) toolStarted.set(p.id, m.timestamp!)
        items.push(item)
      }
    } else if (m.role === 'toolResult' && m.toolCallId && replyCalls.has(m.toolCallId)) {
      // Re-checked: the stored list is read back from disk.
      const options = m.isError ? [] : checkReplies({ options: (m.details as { replies?: unknown } | undefined)?.replies })
      if (options.length) items.push({ kind: 'replies', id: m.toolCallId, options })
    } else if (m.role === 'toolResult' && m.toolCallId) {
      const item = tools.get(m.toolCallId)
      if (!item) continue
      const card = cardOf(m)
      if (card) {
        // The card takes its call's place; a failed render_card stays a failed tool row.
        items[items.indexOf(item)] = { kind: 'card', id: m.toolCallId, card: cards.get(card.id) ?? card }
        tools.delete(m.toolCallId)
        continue
      }
      const proposal = proposalOf(m)
      if (proposal) {
        items[items.indexOf(item)] = { kind: 'proposal', id: m.toolCallId, proposal: proposalNow(proposal, results, live) }
        tools.delete(m.toolCallId)
        continue
      }
      const summary = (m.details as { summary?: unknown } | undefined)?.summary
      const denied = (m.details as { denied?: unknown } | undefined)?.denied === true
      const calls = item.code === undefined ? undefined : scriptCalls(m.details)
      Object.assign(item, {
        status: m.isError || denied ? 'error' : 'ok',
        ...(Number.isFinite(m.durationMs) && m.durationMs! >= 0 ? { ms: m.durationMs } : Number.isFinite(m.timestamp) && toolStarted.has(item.id) ? { ms: Math.max(0, m.timestamp! - toolStarted.get(item.id)!) } : {}),
        summary: typeof summary === 'string' ? summary : m.isError ? textOf(m.content).slice(0, 200) : undefined,
        ...(calls && { calls })
      })
      items.splice(items.indexOf(item) + 1, 0, ...approvalsOf(m).map((approval) => ({ kind: 'approval' as const, id: approval.id, approval })))
    }
  }
  for (const item of tools.values()) {
    if (item.status !== 'running') continue
    // Waiting on the user right now (the run is paused on it).
    const waiting = liveApproval?.(item.id)
    if (waiting?.state === 'pending') {
      Object.assign(item, { status: 'waiting' })
      items.splice(items.indexOf(item) + 1, 0, { kind: 'approval', id: waiting.id, approval: waiting })
    }
    // A call without a result was cut off (abort, quit): it is not running any more.
    else Object.assign(item, { status: 'error', summary: '已中断' })
  }
  // Chips belong to the last reply only: anything from before the latest user turn, and all but the newest, go;
  // and none under a reply that never answered in words.
  const lastUser = items.findLastIndex((i) => i.kind === 'user')
  const lastReplies = hasAnswer(messages.findLast((m) => m.role === 'assistant')) ? items.findLastIndex((i) => i.kind === 'replies') : -1
  return items.filter((i, at) => i.kind !== 'replies' || (at === lastReplies && at > lastUser))
}
