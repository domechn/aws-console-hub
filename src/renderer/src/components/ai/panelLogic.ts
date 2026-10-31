import type { AiEvent, ChatItem, ResourceCandidate, ResourceRef } from '../../../../shared/ai'
import type { Block } from '../../../../shared/cards'
import { restoreFailedSend } from './Composer'

export function invalidatesHistoryReload(runId: number, type: AiEvent['type']): boolean {
  return type !== 'done' && (runId !== 0 || type === 'proposal-result' || type === 'proposal' || type === 'proposal-state' || type === 'approval' || type === 'note' || type === 'error')
}

export function restoreQueuedDraft(drafts: { get(key: string): string; set(key: string, text: string): void }, current: string | null, target: string, text: string): string | null {
  const restored = restoreFailedSend(drafts.get(target), text)
  drafts.set(target, restored)
  return target === current ? restored : null
}

export function mergeQueuedResources(current: ResourceCandidate[], refs: ResourceRef[], known: ResourceCandidate[] = []): ResourceCandidate[] {
  const result = [...current]
  for (const ref of refs) if (!result.some((r) => r.type === ref.type && r.id === ref.id && r.region === ref.region)) {
    const label = known.find((r) => r.type === ref.type && r.id === ref.id && r.region === ref.region)?.label ?? ref.id
    result.push({ ...ref, label })
  }
  return result.slice(0, 5)
}

export function removeQueuedPreview(items: ChatItem[], preview: ChatItem): ChatItem[] {
  return items.filter((item) => item !== preview)
}

export function resultChange(items: ChatItem[], id: string): Extract<Block, { type: 'change' }> | null {
  const result = items.find((i) => i.kind === 'card' && i.id === id)
  if (result?.kind !== 'card' || result.card?.origin !== 'system' || !result.card.title?.startsWith('已执行') || !id.startsWith('r-')) return null
  const proposal = items.find((i) => i.kind === 'proposal' && i.proposal.id === id.slice(2))
  if (proposal?.kind !== 'proposal' || proposal.proposal.card.origin !== 'system') return null
  return proposal.proposal.card.blocks.find((b): b is Extract<Block, { type: 'change' }> => b.type === 'change' && !!b.rows?.length) ?? null
}

export function pendingDecisionCount(items: ChatItem[], now = Date.now()): number {
  return items.filter((i) => i.kind === 'approval' && i.approval.state === 'pending' && i.approval.expiresAt > now || i.kind === 'proposal' && i.proposal.state === 'pending' && i.proposal.expiresAt > now).length
}

export function cardDisabledState(busy: boolean, pending: boolean, regenerating: boolean): { message: boolean; card: boolean } {
  return { message: busy || pending || regenerating, card: regenerating }
}

export function regenerationOrdinal(item: ChatItem | undefined): number | null {
  return item?.kind === 'user' && !item.cardAction && item.ordinal !== undefined ? item.ordinal : null
}

export function regenerationPreview(items: ChatItem[], index: number, text: string): ChatItem[] {
  const earlier = items.slice(0, index)
  const proposals = new Set(earlier.flatMap((i) => i.kind === 'proposal' ? [i.proposal.id] : []))
  const kept = items.slice(index + 1).filter((i) => i.kind === 'card' && i.card?.origin === 'system' && i.id.startsWith('r-') && proposals.has(i.id.slice(2)))
  const selected = items[index]
  return selected?.kind === 'user' ? [...earlier, ...kept, { ...selected, text }] : items
}

export function liveStatus(pending: string | null, busy: boolean, justExecuted: boolean): string {
  return pending || (busy ? '正在回答' : justExecuted ? '提案执行成功' : '回答完成')
}
