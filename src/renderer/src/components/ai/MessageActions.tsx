import type { ChatItem } from '../../../../shared/ai'
import { formatTokens, formatUsd } from '../../ai'

export function fromUserIndex(items: ChatItem[], index: number): number {
  for (let i = index; i >= 0; i--) if (items[i].kind === 'user') return i
  return -1
}

export const isOlder = (items: ChatItem[], index: number): boolean => items.slice(index + 1).some((item) => item.kind === 'user')

/** The bar belongs to the complete turn, after its cards, with the last assistant item's cumulative usage. */
export function turnActionsAt(items: ChatItem[], index: number): { userIndex: number; text: string; model?: string; usage?: Extract<ChatItem, { kind: 'assistant' }>['usage'] } | null {
  if (items[index]?.kind === 'user' || items[index]?.kind === 'replies') return null
  const next = items.slice(index + 1).find((item) => item.kind !== 'replies')
  if (next && next.kind !== 'user') return null
  const userIndex = fromUserIndex(items, index)
  if (userIndex < 0) return null
  if (items[userIndex].kind === 'user' && items[userIndex].cardAction) return null
  const answers = items.slice(userIndex + 1, index + 1).filter((item): item is Extract<ChatItem, { kind: 'assistant' }> => item.kind === 'assistant')
  const last = answers.at(-1)
  if (!last || last.error || last.aborted) return null
  return { userIndex, text: answers.map((answer) => answer.text).filter(Boolean).join('\n\n'), ...(last.model && { model: last.model }), ...(last.usage && { usage: last.usage }) }
}

/** A removed proposal may have changed AWS already, or may still need a decision. */
export function truncatesChanges(items: ChatItem[], fromUserIndex: number): boolean {
  return items.slice(fromUserIndex + 1).some((item) =>
    item.kind === 'proposal' && ['pending', 'executing', 'succeeded', 'failed'].includes(item.proposal.state) ||
    item.kind === 'card' && item.id.startsWith('r-')
  )
}

export function editKey(key: string, command: boolean, shift: boolean, composing: boolean): 'submit' | 'cancel' | null {
  if (composing) return null
  if (key === 'Escape') return 'cancel'
  if (key === 'Enter' && command && !shift) return 'submit'
  return null
}

export function panelEscapeStops(key: string, busy: boolean, handled: boolean, inDecisionCard: boolean, composing = false): boolean {
  return key === 'Escape' && busy && !handled && !inDecisionCard && !composing
}

interface ActionsProps {
  kind: 'user' | 'assistant'
  text: string
  model?: string
  usage?: Extract<ChatItem, { kind: 'assistant' }>['usage']
  disabled?: boolean
  onRegenerate: () => void
  onEdit?: () => void
  onCopy?: (text: string) => void
}

export function MessageActions({ kind, text, model, usage, disabled, onRegenerate, onEdit, onCopy }: ActionsProps): React.JSX.Element {
  const meta = usage ? [model, `${formatTokens(usage.input + usage.output)} tokens`, usage.costUsd === undefined ? undefined : `≈${formatUsd(usage.costUsd)}`].filter(Boolean).join(' · ') : null
  return <div className={`ai-message-actions ${kind}`}>
    <div className="ai-message-buttons">
      {kind === 'user' && <button type="button" disabled={disabled} onClick={onEdit}>编辑并重发</button>}
      <button type="button" onClick={() => onCopy ? onCopy(text) : void navigator.clipboard.writeText(text)}>复制</button>
      {kind === 'assistant' && <button type="button" disabled={disabled} onClick={onRegenerate}>重新生成</button>}
    </div>
    {meta && <span className="ai-message-meta">{meta}</span>}
  </div>
}

interface FailureProps {
  error?: string
  aborted?: boolean
  disabled?: boolean
  hideRetry?: boolean
  onRetry: () => void
  onModel: () => void
  onCopy?: (text: string) => void
}

export function MessageFailure({ error, aborted, disabled, hideRetry, onRetry, onModel, onCopy }: FailureProps): React.JSX.Element | null {
  if (!error && !aborted) return null
  if (aborted && !error) return <div className="ai-stopped">■ 已停止 {!hideRetry && <><span aria-hidden>·</span> <button type="button" disabled={disabled} onClick={onRetry}>重新生成</button></>}</div>
  const [explanation, raw] = (error ?? '').split('\n原始错误：', 2)
  return <div className="ai-turn-error" role="alert">
    <div><strong>回答没有完成。</strong> {explanation}</div>
    {raw && <code className="ai-turn-error-raw">{raw}</code>}
    <div className="ai-turn-error-actions">
      {!hideRetry && <button type="button" className="primary" disabled={disabled} onClick={onRetry}>重试</button>}
      <button type="button" disabled={disabled} onClick={onModel}>更换模型…</button>
      <button type="button" onClick={() => onCopy ? onCopy(error ?? '') : void navigator.clipboard.writeText(error ?? '')}>复制错误</button>
    </div>
    <div className="ai-turn-error-hint">已完成的查询会保留；已执行的变更不会撤销。</div>
  </div>
}
