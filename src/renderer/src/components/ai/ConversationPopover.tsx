import { useEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '../../../../shared/ai'

interface Group {
  label: string
  items: ConversationSummary[]
}

/** Local calendar days, matching the dates users see in their own time zone. */
export function groupConversations(items: ConversationSummary[], now = Date.now()): Group[] {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime()
  const groups = new Map<string, ConversationSummary[]>()
  for (const item of [...items].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const date = new Date(item.updatedAt)
    const day = new Date(date)
    day.setHours(0, 0, 0, 0)
    const age = Math.round((start - day.getTime()) / 86_400_000)
    const label = age <= 0 ? '今天' : age === 1 ? '昨天' : age < 7 ? '最近 7 天' : age < 30 ? '最近 30 天' : `${date.getFullYear()}年${date.getMonth() + 1}月`
    groups.set(label, [...(groups.get(label) ?? []), item])
  }
  return [...groups].map(([label, group]) => ({ label, items: group }))
}

export function conversationKey(key: string, index: number, count: number, modified: boolean): { index: number } | { open: number } | { delete: number } | { close: true } | null {
  if (key === 'Escape') return { close: true }
  if (key === 'ArrowDown' || key === 'ArrowUp') return { index: Math.max(0, Math.min(count - 1, index + (key === 'ArrowDown' ? 1 : -1))) }
  if (count > 0 && key === 'Enter') return { open: index }
  if (count > 0 && key === 'Backspace' && modified) return { delete: index }
  return null
}

interface Props {
  conversations: ConversationSummary[]
  currentId: string | null
  running: ReadonlySet<string>
  open: boolean
  editTarget?: string | null
  onClose: () => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onClear: () => void
}

export function ConversationPopover({ conversations, currentId, running, open, editTarget, onClose, onOpen, onRename, onDelete, onClear }: Props): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [edit, setEdit] = useState<{ id: string; title: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      const target = conversations.find((c) => c.id === editTarget)
      setEdit(target ? { id: target.id, title: target.title } : null)
      searchRef.current?.focus()
    }
  }, [open, editTarget])
  if (!open) return null
  const found = conversations.filter((c) => c.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const groups = groupConversations(found)
  const flat = groups.flatMap((g) => g.items)
  const selected = flat[Math.min(active, flat.length - 1)]
  const finishEdit = (): void => {
    if (edit?.title.trim()) onRename(edit.id, edit.title.trim())
    setEdit(null)
  }
  const keyDown = (e: React.KeyboardEvent): void => {
    if (edit || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.target !== searchRef.current) return
    const action = conversationKey(e.key, Math.min(active, flat.length - 1), flat.length, e.metaKey || e.ctrlKey)
    if (!action) return
    e.preventDefault()
    if ('close' in action) onClose()
    else if ('index' in action) setActive(action.index)
    else if ('open' in action && selected) { onOpen(selected.id); onClose() }
    else if ('delete' in action && selected) onDelete(selected.id)
  }
  return (
    <div className="ai-conversation-pop" role="dialog" aria-label="切换对话" onKeyDown={keyDown}>
      <input ref={searchRef} type="search" value={query} aria-label="搜索对话标题" placeholder="搜索对话标题" onChange={(e) => { setQuery(e.target.value); setActive(0) }} />
      <div className="ai-conversation-scroll">
        {groups.map((g) => (
          <div key={g.label} role="group" aria-label={g.label}>
            <div className="ai-conversation-group">{g.label}</div>
            {g.items.map((c) => {
              const index = flat.findIndex((i) => i.id === c.id)
              return (
                <div key={c.id} className={`ai-conversation-row${active === index ? ' active' : ''}`} onMouseEnter={() => setActive(index)}>
                  {edit?.id === c.id ? (
                    <input
                      className="ai-rename"
                      autoFocus
                      value={edit.title}
                      maxLength={100}
                      aria-label="重命名对话"
                      onChange={(e) => setEdit({ id: c.id, title: e.target.value })}
                      onBlur={finishEdit}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) finishEdit()
                        if (e.key === 'Escape') setEdit(null)
                      }}
                    />
                  ) : (
                    <button type="button" className="ai-conversation-pick" onClick={() => { onOpen(c.id); onClose() }}>
                      <span className="ai-conversation-mark">{currentId === c.id ? '✓' : running.has(c.id) ? '●' : ''}</span>
                      <span className="ai-conversation-main">
                        <span>{c.title || '未命名对话'}</span>
                        <small>{currentId === c.id ? '当前对话' : running.has(c.id) ? '正在运行' : '对话'}</small>
                      </span>
                      <time dateTime={new Date(c.updatedAt).toISOString()}>{new Date(c.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                    </button>
                  )}
                  <div className="ai-conversation-actions">
                    <button type="button" aria-label={`重命名对话：${c.title}`} onClick={() => setEdit({ id: c.id, title: c.title })}>✎</button>
                    <button type="button" aria-label={`删除对话：${c.title}`} onClick={() => onDelete(c.id)}>×</button>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
        {flat.length === 0 && <p className="ai-dim">没有匹配的对话</p>}
      </div>
      <div className="ai-conversation-foot">
        <span>匹配 {found.length} / {conversations.length} 个对话 · 只搜标题</span>
        <button type="button" disabled={conversations.length === 0} onClick={onClear}>清空本账号全部对话…</button>
      </div>
    </div>
  )
}
