import type { ChatItem } from '../../../../shared/ai'

export function cardDisabledState(busy: boolean, pending: boolean, regenerating: boolean): { message: boolean; card: boolean } {
  return { message: busy || pending || regenerating, card: regenerating }
}

export function regenerationOrdinal(item: ChatItem | undefined): number | null {
  return item?.kind === 'user' && !item.cardAction && item.ordinal !== undefined ? item.ordinal : null
}

export function regenerationPreview(items: ChatItem[], index: number, text: string): ChatItem[] {
  const earlier = items.slice(0, index)
  const proposals = new Set(earlier.flatMap((i) => i.kind === 'proposal' ? [i.id] : []))
  const kept = items.slice(index + 1).filter((i) => i.kind === 'card' && i.card?.origin === 'system' && i.id.startsWith('r-') && proposals.has(i.id.slice(2)))
  const selected = items[index]
  return selected?.kind === 'user' ? [...earlier, ...kept, { ...selected, text }] : items
}

export function liveStatus(pending: string | null, busy: boolean, justExecuted: boolean): string {
  return pending || (busy ? '正在回答' : justExecuted ? '提案执行成功' : '回答完成')
}
