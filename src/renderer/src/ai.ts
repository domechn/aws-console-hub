import type { AiConfigView, AiEvent, ChatItem, MonthUsage, TokenRates, UsageTotals } from '../../shared/ai'
import { BEDROCK_PROVIDER_ID, CUSTOM_PROVIDER_ID } from '../../shared/ai'

/** Panel-side helpers. Pure, so they can be tested without a DOM. */

/** Live events onto the shown items; the stored history replaces them when the run is done. */
export function applyEvent(items: ChatItem[], e: AiEvent): ChatItem[] {
  if (e.type === 'text-delta') {
    const last = items[items.length - 1]
    // A reply streams into the assistant item it started; after a user message or a tool call it is a new one.
    if (last?.kind === 'assistant' && !last.error) return [...items.slice(0, -1), { ...last, text: last.text + e.text }]
    return [...items, { kind: 'assistant', text: e.text }]
  }
  if (e.type === 'tool-start') return [...items, { kind: 'tool', id: e.id, label: e.label, status: 'running', ...(e.code !== undefined && { code: e.code }), ...(e.t !== undefined && { startedAt: e.t }) }]
  if (e.type === 'tool-progress') return items.map((i) => i.kind === 'tool' && i.id === e.id && (i.status === 'running' || i.status === 'waiting') ? { ...i, seconds: e.seconds, ...(e.calls !== undefined && { callCount: e.calls }) } : i)
  if (e.type === 'tool-end') {
    return items.map((i) => {
      if (i.kind === 'tool' && i.id === e.id) {
        const { startedAt, seconds: _seconds, callCount: _callCount, ...tool } = i as typeof i & { startedAt?: number }
        return { ...tool, status: e.ok ? 'ok' : 'error', summary: e.summary, ...(e.calls && { calls: e.calls }), ...(startedAt !== undefined && e.t !== undefined && { ms: Math.max(0, e.t - startedAt) }) }
      }
      // A render_card that failed (the model gets the reason and usually retries): a failed tool row, not a card.
      if (i.kind === 'card' && i.id === e.id) return { kind: 'tool', id: i.id, label: '生成卡片', status: e.ok ? 'ok' : 'error', summary: e.summary }
      return i
    })
  }
  const isCall = (i: ChatItem, id: string): boolean => i.kind === 'card' && i.id === id
  if (e.type === 'card-pending') return items.some((i) => isCall(i, e.id)) ? items : [...items, { kind: 'card', id: e.id, card: null }]
  if (e.type === 'card') {
    const item: ChatItem = { kind: 'card', id: e.id, card: e.card }
    return items.some((i) => isCall(i, e.id)) ? items.map((i) => (isCall(i, e.id) ? item : i)) : [...items, item]
  }
  if (e.type === 'card-state') {
    return items.map((i) => (i.kind === 'card' && i.card?.id === e.cardId ? { ...i, card: { ...i.card, state: e.state } } : i))
  }
  if (e.type === 'user') return [...items, { kind: 'user', text: e.text, ...(e.resources && { resources: e.resources }), ...(e.attachments && { attachments: e.attachments }) }]
  if (e.type === 'proposal') {
    // The proposal card takes the place of its propose_change call's tool row.
    const item: ChatItem = { kind: 'proposal', id: e.id, proposal: e.proposal }
    return items.some((i) => i.kind === 'tool' && i.id === e.id) ? items.map((i) => (i.kind === 'tool' && i.id === e.id ? item : i)) : [...items, item]
  }
  if (e.type === 'proposal-state') return items.map((i) => (i.kind === 'proposal' && i.proposal.id === e.proposal.id ? { ...i, proposal: e.proposal } : i))
  if (e.type === 'proposal-result') return items.some((i) => i.kind === 'card' && i.id === e.id) ? items : [...items, { kind: 'card', id: e.id, card: e.card }]
  if (e.type === 'approval') {
    const a = e.approval
    const item: ChatItem = { kind: 'approval', id: a.id, approval: a }
    // The call's row waits while a card of it is pending (run_script may have several), and runs on once none is.
    const waiting = a.state === 'pending' || items.some((i) => i.kind === 'approval' && i.id !== a.id && i.approval.toolCallId === a.toolCallId && i.approval.state === 'pending')
    const rows = items.map((i) => (i.kind === 'tool' && i.id === a.toolCallId && i.status !== 'ok' && i.status !== 'error' ? { ...i, status: waiting ? ('waiting' as const) : ('running' as const) } : i))
    if (rows.some((i) => i.kind === 'approval' && i.id === a.id)) return rows.map((i) => (i.kind === 'approval' && i.id === a.id ? item : i))
    const at = rows.findIndex((i) => i.kind === 'tool' && i.id === a.toolCallId)
    return at < 0 ? [...rows, item] : [...rows.slice(0, at + 1), item, ...rows.slice(at + 1)]
  }
  if (e.type === 'note') return [...items, { kind: 'note', text: e.text }]
  if (e.type === 'error') {
    return [...items, { kind: 'assistant', text: '', error: e.message, ...(e.retryable === false && { retryable: false }) }]
  }
  if (e.type === 'replies') return [...items.filter((i) => i.kind !== 'replies'), { kind: 'replies', id: e.id, options: e.options }]
  return items
}

/**
 * The chips to show: the last suggest_replies, while only the reply's text came after it. Never next to something
 * answered on its own buttons: a proposal or approval still waiting, or a card the model drew in this turn. Null otherwise.
 */
export function visibleReplies(items: ChatItem[], now = Date.now()): Extract<ChatItem, { kind: 'replies' }> | null {
  const at = items.findLastIndex((i) => i.kind === 'replies')
  if (at < 0 || items.slice(at + 1).some((i) => i.kind !== 'assistant')) return null
  if (pendingProposals(items, now).length || pendingApprovals(items, now).length) return null
  const turn = items.slice(items.findLastIndex((i) => i.kind === 'user') + 1)
  // A result card (origin=system) is main's record of an outcome, not something to answer.
  if (turn.some((i) => i.kind === 'card' && i.card?.origin !== 'system')) return null
  return items[at] as Extract<ChatItem, { kind: 'replies' }>
}

/** Proposals still waiting for the user (the status line above the input). */
export const pendingProposals = (items: ChatItem[], now = Date.now()): string[] =>
  items.flatMap((i) => (i.kind === 'proposal' && i.proposal.state === 'pending' && i.proposal.expiresAt > now ? [i.proposal.id] : []))

/** Calls paused on an approval card (the status line jumps to them first: the answer waits on them). */
export const pendingApprovals = (items: ChatItem[], now = Date.now()): string[] =>
  items.flatMap((i) => (i.kind === 'approval' && i.approval.state === 'pending' && i.approval.expiresAt > now ? [i.approval.id] : []))

/**
 * Pending card element ids scrolled out of the message list, in order: the status line offers its jump button only
 * while this is non-empty. `outOfView` may hold stale ids of decided cards; only pending ones count.
 */
export const hiddenPending = (cardIds: string[], outOfView: ReadonlySet<string>): string[] => cardIds.filter((id) => outOfView.has(id))

/** The status line above the input: always while the answer waits on an approval; proposals (they pause nothing) once a card is out of view. */
export function pendingStatus(calls: number, proposals: number, anyHidden: boolean): string {
  return [
    calls > 1 ? `回答已暂停，等你处理上面的 ${calls} 个审批` : calls === 1 ? '回答已暂停，等你处理上面的审批' : '',
    proposals > 0 && (calls > 0 || anyHidden) ? `${proposals} 个变更提案等待你确认` : ''
  ]
    .filter(Boolean)
    .join('；')
}

/** An approval's countdown colour: amber under two minutes, red under one. */
export const countdownTone = (ms: number): '' | 'soon' | 'urgent' => (ms < 60_000 ? 'urgent' : ms < 120_000 ? 'soon' : '')

/** Shown before the write switch is turned on, in the panel and in the account settings. */
export const allowWriteWarning = (accountName: string): string =>
  `允许 AI 助手在「${accountName}」里提出变更？\n\n` +
  '· 助手只能「提出」变更：每个变更都显示成一张确认卡片（变更内容、风险、影响），你点两次确认后，应用才会执行。\n' +
  '· 执行用的是这个账号当前的 role，权限和你在 Console 里一样大。\n' +
  '· 没有专门适配器的操作会显示「通用请求」卡，原样展示参数，要你输入操作名才执行；IAM 提权、关闭 CloudTrail、KMS、公开数据等危险操作是红色强确认卡。\n' +
  '· 随时可以改回只读；改回后，还没确认的提案也不能再执行。'

/** "9:41" left on a proposal. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Ready to chat: a provider and model are chosen, and a key is set. A local custom endpoint may go without (it needs
 * a baseURL); Bedrock in account mode needs the account instead.
 */
export function aiReady(c: AiConfigView | null): boolean {
  if (!c?.provider || !c.model) return false
  if (c.provider === CUSTOM_PROVIDER_ID) return Boolean(c.baseUrl)
  if (c.provider === BEDROCK_PROVIDER_ID && c.bedrockAuth === 'account') return Boolean(c.bedrockAccountId)
  return c.hasKey
}

export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** Small amounts need more digits to be anything but $0.00. */
export function formatUsd(n: number): string {
  if (n === 0) return '$0'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

/** The estimate, "+" when some replies had no price; null when none had one. */
export function formatCost(u: UsageTotals): string | null {
  return !u.costUnknown ? formatUsd(u.cost) : u.cost ? `${formatUsd(u.cost)}+` : null
}

export function formatUsage(u: UsageTotals): string {
  const cached = u.cacheRead ? ` / 缓存 ${formatTokens(u.cacheRead)}` : ''
  return `输入 ${formatTokens(u.input)} / 输出 ${formatTokens(u.output)}${cached} tokens · ${formatCost(u) ?? '费用未知'}`
}

/** The usage popover's month line: tokens in + out, and the estimate only when there is one (the chat line says "费用未知"). */
export function formatMonth(m: MonthUsage): string {
  const cost = formatCost(m.totals)
  return `本月 ${formatTokens(m.totals.input + m.totals.output)} tokens${cost ? ` · ${cost}` : ''}`
}

/** Catalog prices as the settings show them. */
export function formatRates(r: TokenRates): string {
  if (!r.input && !r.output) return '目录里没有价格（费用显示为「费用未知」）'
  const p = (n: number): string => `$${Number(n.toPrecision(4))}`
  return `输入 ${p(r.input)} · 输出 ${p(r.output)}${r.cacheRead ? ` · 缓存读 ${p(r.cacheRead)}` : ''}（每百万 token，目录价）`
}

/** Electron prefixes rejected invokes with the channel; users only need the message. */
export function ipcError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
