import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  BEDROCK_PROVIDER_ID,
  CUSTOM_PROVIDER_ID,
  type AiConfigView,
  type AiModelInfo,
  type ApprovalDecision,
  type CardActionResult,
  type ChatItem,
  type ConversationSummary,
  type MonthUsage,
  type PageContext,
  type SessionAllowView,
  type UsageTotals
} from '../../../../shared/ai'
import type { FormValues } from '../../../../shared/cards'
import type { AwsAccount } from '../../../../shared/types'
import { aiReady, allowWriteWarning, applyEvent, hiddenPending, ipcError, pendingApprovals, pendingProposals, pendingStatus, visibleReplies } from '../../ai'
import { IconPause } from '../icons'
import { ActivityGroup, groupTools, type NonToolItem } from './ActivityGroup'
import { ApprovalCard } from './ApprovalCard'
import { CardSkeleton, CardView } from './CardView'
import { Composer, draftKey, draftStore, restoreFailedSend, scopedContent } from './Composer'
import { ConversationPopover } from './ConversationPopover'
import { canSendText, submitText, type LocalCommand } from './commands'
import { EmptyState } from './EmptyState'
import { Markdown } from './Markdown'
import { editKey, fromUserIndex, isOlder, MessageActions, MessageFailure, panelEscapeStops, truncatesChanges, turnActionsAt } from './MessageActions'
import { cardDisabledState, liveStatus, regenerationOrdinal, regenerationPreview } from './panelLogic'
import { PageChip } from './PageChip'
import { ProposalCard } from './ProposalCard'
import { QuickReplies } from './QuickReplies'

export const PANEL_MIN_WIDTH = 320
export const PANEL_MAX_WIDTH = 640

interface Props {
  account: AwsAccount | null
  config: AiConfigView | null
  width: number
  onResize: (width: number, done: boolean) => void
  onOpenSettings: () => void
  onOpenAudit: () => void
  /** The model chip saved a new model (ai:config-save); the app keeps the config. */
  onConfig: (config: AiConfigView) => void
  onClose: () => void
  /** The account's「允许 AI 助手提出变更」switch, saved like the account modal does. */
  onSetAllowWrite: (allow: boolean) => Promise<void>
  /** Bumped to move focus into the input. */
  focusToken: number
  /** Changes when the account's active tab navigates or retitles: the page chip asks main again. */
  pageKey: string
}

const ai = window.api.ai

/** Right-hand chat panel. A sibling of the console column, so the native console view narrows instead of covering it. */
export function AssistantPanel({ account, config, width, onResize, onOpenSettings, onOpenAudit, onConfig, onClose, onSetAllowWrite, focusToken, pageKey }: Props): React.JSX.Element {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [usage, setUsage] = useState<UsageTotals | null>(null)
  const [month, setMonth] = useState<MonthUsage | null>(null)
  // Conversations with a run in flight; runs keep going when the panel switches away.
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [viewScope, setViewScope] = useState(() => draftKey(account?.id ?? null, null))
  const [drafts] = useState(draftStore)
  // The configured provider's catalog, for the model chip.
  const [models, setModels] = useState<AiModelInfo[]>([])
  // Chips the user started typing over (by their suggest_replies call id).
  const [dismissedReplies, setDismissedReplies] = useState<string | null>(null)
  const [conversationsOpen, setConversationsOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const regeneratingRef = useRef(false)
  const [justExecuted, setJustExecuted] = useState(false)
  // What main would send as the current page (undefined until asked), and the conversation's toggle for it.
  const [page, setPage] = useState<PageContext | null | undefined>(undefined)
  const [pageOn, setPageOn] = useState(true)
  // "本对话内一直允许" entries (main's memory); the panel shows the current conversation's as chips.
  const [allows, setAllows] = useState<SessionAllowView[]>([])
  const refreshAllows = useCallback(async (): Promise<void> => setAllows(await ai.sessionAllows()), [])
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickRef = useRef(true)
  const currentRef = useRef<string | null>(null)
  const accountRef = useRef<string | null>(null)
  /** Last conversation shown per account, so switching accounts and back returns to it. */
  const lastByAccount = useRef(new Map<string, string | null>())

  const accountId = account?.id ?? null
  const closeConversations = (): void => {
    setConversationsOpen(false)
    setEditTarget(null)
    requestAnimationFrame(() => titleRef.current?.focus())
  }
  accountRef.current = accountId
  const scope = draftKey(accountId, conversationId)
  currentRef.current = scope
  const { items: visibleItems, input: visibleInput } = scopedContent(scope, viewScope, items, input)
  const ready = aiReady(config)
  const busy = conversationId !== null && running.has(conversationId)
  const hasPendingDecision = visibleItems.some((item) =>
    item.kind === 'approval' && item.approval.state === 'pending' || item.kind === 'proposal' && item.proposal.state === 'pending'
  )
  useEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const outside = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node) && !menuButtonRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menuOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!panelRef.current?.contains(document.activeElement) || e.altKey || !e.shiftKey || !(window.api.platform === 'darwin' ? e.metaKey : e.ctrlKey)) return
      if ((e.key.toLowerCase() === 'k' || e.code === 'KeyK') && !e.isComposing) {
        e.preventDefault()
        e.stopPropagation()
        setConversationsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const loadConversation = useCallback(async (accId: string, id: string | null) => {
    const target = draftKey(accId, id)
    currentRef.current = target
    setConversationId(id)
    setViewScope(target)
    setItems([])
    setUsage(null)
    lastByAccount.current.set(accId, id)
    setNotice(null)
    setJustExecuted(false)
    setEditIndex(null)
    setInput(drafts.get(draftKey(accId, id)))
    if (!id) {
      setPageOn(true)
      void ai.usage().then(setMonth)
      return
    }
    try {
      const view = await ai.history(accId, id)
      if (currentRef.current !== target) return
      setItems(view.items)
      setPageOn(view.pageContext)
      setUsage(view.usage)
      setMonth(view.month)
      stickRef.current = true
    } catch (err) {
      if (currentRef.current === target) setNotice(ipcError(err))
    }
  }, [drafts])

  // Every keystroke, so switching away keeps the text without asking the input for it.
  const setDraft = (text: string): void => {
    setInput(text)
    if (accountId) drafts.set(currentRef.current ?? scope, text)
  }

  const refreshList = useCallback(async (accId: string): Promise<ConversationSummary[]> => {
    const list = await ai.conversations(accId)
    if (accountRef.current === accId) setConversations(list)
    return list
  }, [])

  // Each account has its own conversations.
  useEffect(() => {
    const target = draftKey(accountId, null)
    currentRef.current = target
    setConversationId(null)
    setViewScope(target)
    setItems([])
    setUsage(null)
    if (!accountId) {
      setConversations([])
      setInput('')
      return
    }
    setConversations([])
    setInput(drafts.get(target))
    let cancelled = false
    void refreshList(accountId).then((list) => {
      if (cancelled) return
      const remembered = lastByAccount.current.get(accountId)
      const id = remembered !== undefined ? remembered : (list[0]?.id ?? null)
      void loadConversation(accountId, id !== null && !list.some((c) => c.id === id) ? null : id)
    })
    return () => {
      cancelled = true
    }
  }, [accountId, refreshList, loadConversation, drafts])

  useEffect(
    () =>
      ai.onEvent(({ accountId: acc, conversationId: id, runId, event }) => {
        if (event.type === 'done') {
          setRunning((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          if (acc === accountId) void refreshList(acc)
          // The stored transcript is the truth; the live items were a preview of it.
          if (draftKey(acc, id) === currentRef.current) {
            void ai.history(acc, id).then((view) => {
              if (currentRef.current !== draftKey(acc, id)) return
              setItems(view.items)
              setUsage(view.usage)
              setMonth(view.month)
            })
          }
          return
        }
        if (event.type === 'proposal-state' && event.proposal.state === 'succeeded' && draftKey(acc, id) === currentRef.current) setJustExecuted(true)
        // Main starts turns too (a card button's reply), so any run event means the conversation is running.
        // Card and proposal state changes, result cards and an impact analysis's usage come outside runs (runId 0).
        if (runId !== 0 && event.type !== 'card-state' && event.type !== 'proposal-state' && event.type !== 'proposal-result' && event.type !== 'approval') {
          setRunning((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
        }
        // Month totals cover every conversation: any reply updates them.
        if (event.type === 'usage') setMonth(event.month)
        if (draftKey(acc, id) !== currentRef.current) return
        if (event.type === 'usage') setUsage(event.usage)
        else setItems((prev) => event.type === 'note' && regeneratingRef.current && prev.at(-1)?.kind === 'user'
          ? [...prev.slice(0, -1), { kind: 'note', text: event.text }, prev.at(-1)!]
          : applyEvent(prev, event))
      }),
    [accountId, refreshList]
  )

  useEffect(() => {
    if (focusToken) inputRef.current?.focus()
  }, [focusToken])

  useEffect(() => {
    if (!justExecuted) return
    const timer = setTimeout(() => setJustExecuted(false), 5000)
    return () => clearTimeout(timer)
  }, [justExecuted])

  useEffect(() => {
    void refreshAllows()
  }, [conversationId, refreshAllows])

  useEffect(() => {
    if (!accountId) return setPage(undefined)
    let cancelled = false
    ai.pageContext(accountId).then(
      (p) => !cancelled && setPage(p),
      () => !cancelled && setPage(null)
    )
    return () => {
      cancelled = true
    }
  }, [accountId, pageKey])

  const provider = config?.provider ?? ''
  useEffect(() => {
    if (!provider || provider === CUSTOM_PROVIDER_ID) return setModels([])
    let cancelled = false
    ai.models(provider).then(
      (list) => !cancelled && setModels(list),
      () => !cancelled && setModels([])
    )
    return () => {
      cancelled = true
    }
  }, [provider])

  // Global, like the settings: the next turn of every conversation uses it.
  const pickModel = (model: string): void => {
    ai.saveConfig({ model }).then(onConfig, (err) => setNotice(ipcError(err)))
  }

  const togglePage = (on: boolean): void => {
    setPageOn(on)
    if (accountId && conversationId) ai.setPageContext(accountId, conversationId, on).catch((err) => setNotice(ipcError(err)))
  }

  // Follow the stream unless the user scrolled up to read. Content also grows after React renders (markdown
  // reflow, cards, images), so besides the items effect a MutationObserver keeps following while stuck.
  const scrollToEnd = useCallback((): void => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  useEffect(() => {
    if (stickRef.current) scrollToEnd()
  }, [items, notice, scrollToEnd])
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    let frame = 0
    const follow = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (stickRef.current) scrollToEnd()
      })
    }
    const mo = new MutationObserver(follow)
    mo.observe(el, { subtree: true, childList: true, characterData: true })
    el.addEventListener('load', follow, true)
    return () => {
      mo.disconnect()
      el.removeEventListener('load', follow, true)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollToEnd])
  // Only the user's own scrolling may release the follow: layout shifts and scroll anchoring also fire scroll events.
  const userScrollRef = useRef(0)
  const markUserScroll = (): void => {
    userScrollRef.current = Date.now()
  }

  const send = async (text: string): Promise<void> => {
    if (!accountId || !canSendText(text) || busy) return
    const sentScope = scope
    setJustExecuted(false)
    setNotice(null)
    setDraft('')
    stickRef.current = true
    const previous = visibleItems
    setItems((prev) => [...prev, { kind: 'user', text: text.trim() }])
    try {
      const { conversationId: id, warning } = await ai.send(accountId, conversationId, text, pageOn)
      if (warning && currentRef.current === sentScope) setNotice(warning)
      setRunning((prev) => new Set(prev).add(id))
      void refreshList(accountId)
      if (id !== conversationId) {
        const nextScope = draftKey(accountId, id)
        if (currentRef.current !== sentScope) return
        currentRef.current = nextScope
        setConversationId(id)
        setViewScope(nextScope)
        lastByAccount.current.set(accountId, id)
      }
    } catch (err) {
      // Nothing was sent: give the text back.
      const restored = restoreFailedSend(drafts.get(sentScope), text)
      drafts.set(sentScope, restored)
      if (currentRef.current === sentScope) {
        setItems(previous)
        setInput(restored)
        setNotice(ipcError(err))
      }
    }
  }

  const stop = (): void => {
    if (conversationId) void ai.abort(conversationId)
  }

  const regenerate = async (index: number, text?: string): Promise<void> => {
    if (!accountId || !conversationId || busy || regeneratingRef.current || hasPendingDecision) return
    const selected = visibleItems[index]
    const ordinal = regenerationOrdinal(selected)
    if (ordinal === null || selected?.kind !== 'user') return
    if (truncatesChanges(visibleItems, index) && !confirm('之后的回复将被删除；其中已执行的操作不会撤销。继续吗？')) return
    const target = scope
    const previous = visibleItems
    regeneratingRef.current = true
    setRegenerating(true)
    setJustExecuted(false)
    setNotice(null)
    setItems(regenerationPreview(visibleItems, index, text ?? selected.text))
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([
        ai.regenerate(accountId, conversationId, ordinal, selected.text, text),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('重新生成超时，请刷新对话后重试')), 35_000) })
      ]).finally(() => clearTimeout(timer))
      setRunning((prev) => new Set(prev).add(result.conversationId))
      if (currentRef.current !== target) return
      setEditIndex(null)
      if (result.warning) setNotice(result.warning)
      stickRef.current = true
    } catch (err) {
      if (currentRef.current === target) { setItems(previous); setNotice(ipcError(err)) }
    } finally {
      regeneratingRef.current = false
      setRegenerating(false)
    }
  }

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).catch((err) => setNotice(ipcError(err)))
  }

  // A suggestion goes into the input for the user to edit or send; it is never sent by itself.
  const fill = (text: string): void => {
    setDraft(text)
    requestAnimationFrame(() => {
      const el = inputRef.current
      el?.focus()
      el?.setSelectionRange(text.length, text.length)
    })
  }

  const remove = async (id: string): Promise<void> => {
    if (!accountId) return
    const title = conversations.find((c) => c.id === id)?.title || '这个对话'
    if (!confirm(`删除「${title}」？`)) return
    await ai.delete(accountId, id)
    const list = await refreshList(accountId)
    if (id === conversationId) void loadConversation(accountId, list[0]?.id ?? null)
  }

  const clearAll = async (): Promise<void> => {
    if (!accountId || !account || !confirm(`删除「${account.name}」的全部 AI 对话？`)) return
    await ai.clear(accountId)
    await refreshList(accountId)
    void loadConversation(accountId, null)
  }

  const rename = async (id: string, title: string): Promise<void> => {
    if (!accountId || !title.trim()) return
    try {
      await ai.rename(accountId, id, title)
      void refreshList(accountId)
    } catch (err) {
      setNotice(ipcError(err))
    }
  }

  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const widthAt = (x: number): number => Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, window.innerWidth - x))
    const move = (ev: PointerEvent): void => onResize(widthAt(ev.clientX), false)
    const up = (ev: PointerEvent): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      onResize(widthAt(ev.clientX), true)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  const openLink = (url: string): void => {
    if (accountId) void ai.openLink(accountId, url)
  }

  const cardAction = async (cardId: string, actionId: string, rowId?: string, values?: FormValues): Promise<CardActionResult> => {
    if (!accountId || !conversationId) return { ok: false, error: '对话不存在' }
    stickRef.current = true
    return ai.cardAction(accountId, conversationId, cardId, actionId, rowId, values)
  }

  const proposalAction = async (proposalId: string, confirm: boolean, typed?: string): Promise<CardActionResult> => {
    if (!accountId || !conversationId) return { ok: false, error: '对话不存在' }
    stickRef.current = true
    return confirm ? ai.confirmProposal(accountId, conversationId, proposalId, typed) : ai.cancelProposal(accountId, conversationId, proposalId)
  }

  const toggleWrite = async (): Promise<void> => {
    if (!account) return
    const allow = !account.aiAllowWrite
    if (allow && !confirm(allowWriteWarning(account.name))) return
    await onSetAllowWrite(allow)
  }

  const runCommand = (command: LocalCommand): void => {
    if (!accountId) return
    if (command === 'new') { setDraft(''); void loadConversation(accountId, null) }
    if (command === 'clear' && account && confirm(`删除「${account.name}」的全部 AI 对话？`)) {
      setDraft('')
      void ai.clear(accountId).then(async () => { await refreshList(accountId); void loadConversation(accountId, null) }).catch((err) => setNotice(ipcError(err)))
    }
    if (command === 'readonly' && account?.aiAllowWrite && confirm(`将「${account.name}」切换为只读？之后不能提出新的变更。`)) {
      setDraft('')
      void onSetAllowWrite(false).catch((err) => setNotice(ipcError(err)))
    }
  }

  const approvalAction = async (approvalId: string, decision: ApprovalDecision): Promise<CardActionResult> => {
    if (!accountId || !conversationId) return { ok: false, error: '对话不存在' }
    stickRef.current = true
    const r = await ai.decideApproval(accountId, conversationId, approvalId, decision)
    if (r.ok && decision === 'session') void refreshAllows()
    return r
  }

  const revoke = (key: string): void => {
    if (!accountId || !conversationId) return
    ai.revokeAllow(accountId, conversationId, key).then(refreshAllows, (err) => setNotice(ipcError(err)))
  }

  const pendingCalls = pendingApprovals(visibleItems)
  const pending = pendingProposals(visibleItems)
  const { message: actionsDisabled, card: cardDisabled } = cardDisabledState(busy, hasPendingDecision, regenerating)
  // The waiting call first (the answer is paused on it).
  const pendingIds = [...pendingCalls.map((id) => `approval-${id}`), ...pending.map((id) => `proposal-${id}`)]
  const pendingKey = pendingIds.join(' ')
  // Cards the observer reported outside the list; a card counts as visible until it says so (no flash on arrival).
  const [outOfView, setOutOfView] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const root = listRef.current
    if (!root || !pendingKey) return
    const io = new IntersectionObserver(
      (entries) =>
        setOutOfView((prev) => {
          const next = new Set(prev)
          for (const e of entries) {
            if (e.isIntersecting) next.delete(e.target.id)
            else next.add(e.target.id)
          }
          return next
        }),
      { root }
    )
    for (const id of pendingKey.split(' ')) {
      const el = document.getElementById(id)
      if (el) io.observe(el)
    }
    return () => io.disconnect()
  }, [pendingKey])
  const hidden = hiddenPending(pendingIds, outOfView)
  const status = pendingStatus(pendingCalls.length, pending.length, hidden.length > 0)
  const shownReplies = busy ? null : visibleReplies(visibleItems)
  const replies = shownReplies && shownReplies.id !== dismissedReplies ? shownReplies : null
  const current = conversations.find((c) => c.id === conversationId)
  const allowed = allows.filter((a) => a.conversationId === conversationId)

  return (
    <aside ref={panelRef} className="ai-panel" style={{ width }} aria-label="AI 助手" onKeyDown={(e) => {
      if (!panelEscapeStops(e.key, busy, e.defaultPrevented, Boolean((e.target as Element).closest('.ai-approval, .ai-proposal, [popover], form, .ai-conversation-pop, .ai-header-menu')), e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) return
      e.preventDefault()
      e.stopPropagation()
      stop()
    }}>
      <div
        className="ai-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') onResize(Math.min(PANEL_MAX_WIDTH, width + 20), true)
          if (e.key === 'ArrowRight') onResize(Math.max(PANEL_MIN_WIDTH, width - 20), true)
        }}
      />

      <header className="ai-header">
        {account && ready ? (
          <button ref={titleRef} type="button" className="ai-header-title" aria-expanded={conversationsOpen} onClick={() => { setEditTarget(null); setConversationsOpen((v) => !v) }}>
            {current?.title || '新对话'} <span aria-hidden>⌄</span>
          </button>
        ) : <span className="ai-title">AI 助手</span>}
        {account &&
          (account.aiAllowWrite ? (
            <button className="ai-badge write" title="助手可以提出变更，每项都需要你在卡片上确认。点击改回只读" onClick={() => void toggleWrite()}>
              可提议变更{account.production ? ' · 生产' : ''}
            </button>
          ) : (
            <button className="ai-badge" title="助手只能查询。点击允许它提出变更（每项都需要你确认）" onClick={() => void toggleWrite()}>
              只读
            </button>
          ))}
        {account && ready && <button className="ai-icon-btn" title="新对话" aria-label="新对话" onClick={() => void loadConversation(account.id, null)}>＋</button>}
        <div className="ai-header-menu-wrap">
          <button ref={menuButtonRef} className="ai-icon-btn" title="更多操作" aria-label="更多操作" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>⋯</button>
          {menuOpen && <div ref={menuRef} className="ai-header-menu" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); menuButtonRef.current?.focus() } }}>
            <button type="button" disabled={!current} onClick={() => { if (current) { setEditTarget(current.id); setConversationsOpen(true) } setMenuOpen(false) }}>重命名对话…</button>
            <button type="button" disabled={!current} onClick={() => { if (current) void remove(current.id); setMenuOpen(false) }}>删除这个对话…</button>
            <button type="button" onClick={() => { onOpenSettings(); setMenuOpen(false) }}>AI 设置…</button>
            <button type="button" onClick={() => { onOpenAudit(); setMenuOpen(false) }}>AI 审计…</button>
          </div>}
        </div>
        <button className="ai-icon-btn" title="收起（esc）" aria-label="收起 AI 面板" onClick={onClose}>
          ×
        </button>
      </header>
      {account && ready && <ConversationPopover conversations={conversations} currentId={conversationId} running={running} open={conversationsOpen} editTarget={editTarget} onClose={closeConversations} onOpen={(id) => void loadConversation(account.id, id)} onRename={(id, title) => void rename(id, title)} onDelete={(id) => void remove(id)} onClear={() => void clearAll()} />}

      {allowed.length > 0 && (
        <div className="ai-allows" role="group" aria-label="本对话已允许的动作">
          <span className="ai-dim small">本对话已允许：</span>
          {allowed.map((a) => (
            <span key={a.key} className="ai-chip">
              {a.key}
              <button type="button" className="ai-chip-x" aria-label={`撤销 ${a.key}`} title="撤销：之后再调用会重新询问" onClick={() => revoke(a.key)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        className="ai-messages"
        ref={listRef}
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onPointerDown={markUserScroll}
        onKeyDown={markUserScroll}
        onScroll={(e) => {
          const el = e.currentTarget
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight
          if (gap < 60) stickRef.current = true
          else if (Date.now() - userScrollRef.current < 400) stickRef.current = false
          else if (stickRef.current) scrollToEnd()
        }}
      >
        {!account ? (
          <div className="ai-empty">
            <p>先选择一个账号，助手只在当前账号里查询。</p>
          </div>
        ) : !ready ? (
          <div className="ai-empty">
            <p>还没有配置 AI 服务。</p>
            <p className="ai-dim">
              {config?.provider === BEDROCK_PROVIDER_ID
                ? '选择模型，以及 Bedrock 使用的账号（或填好 Bedrock API key）后就能用自然语言查询这个账号的资源。'
                : '选择服务商和模型、填好 API key（AWS Bedrock 可以改用某个账号的凭证）后就能用自然语言查询这个账号的资源。'}
            </p>
            <button className="primary" onClick={onOpenSettings}>
              打开 AI 设置
            </button>
            <p className="ai-dim small">资源名、标签、日志等查询结果会发送给你选择的 LLM 服务商（用 Bedrock 时是你自己 AWS 账号里的 Bedrock）。</p>
          </div>
        ) : visibleItems.length === 0 ? (
          <EmptyState
            account={account}
            page={page}
            recent={conversations.filter((c) => c.id !== conversationId)}
            onPick={fill}
            onOpen={(id) => void loadConversation(account.id, id)}
            onAllowWrite={() => void toggleWrite()}
          />
        ) : (
          groupTools(visibleItems).map((item, i) => {
            const index = visibleItems.indexOf(Array.isArray(item) ? item[0] : item)
            const tail = index + (Array.isArray(item) ? item.length - 1 : 0)
            const actions = turnActionsAt(visibleItems, tail)
            const user = visibleItems[fromUserIndex(visibleItems, index)]
            return <Fragment key={Array.isArray(item) ? item[0].id : item.kind === 'card' || item.kind === 'proposal' || item.kind === 'approval' ? item.id : i}>
              {Array.isArray(item) ? <ActivityGroup tools={item} /> : <Item
                item={item}
                index={index}
                older={isOlder(visibleItems, index)}
                userIndex={fromUserIndex(visibleItems, index)}
                retryable={user?.kind === 'user' && regenerationOrdinal(user) !== null}
                actionsDisabled={actionsDisabled}
                cardDisabled={cardDisabled}
                editing={editIndex === index}
                editText={editText}
                onEditText={setEditText}
                onEdit={() => { setEditIndex(index); setEditText(item.kind === 'user' ? item.text : '') }}
                onCancelEdit={() => setEditIndex(null)}
                onRegenerate={regenerate}
                onCopy={copy}
                onOpenModel={onOpenSettings}
                onLink={openLink}
                onCardAction={cardAction}
                onProposal={proposalAction}
                onApproval={approvalAction}
                accountColor={account.color}
              />}
              {actions && <MessageActions kind="assistant" text={actions.text} model={actions.model} usage={actions.usage} disabled={actionsDisabled} onRegenerate={() => void regenerate(actions.userIndex)} onCopy={copy} />}
            </Fragment>
          })
        )}
        {replies && <QuickReplies options={replies.options} onSend={(text) => void send(text)} />}
        {/* Not while paused on an approval: the Activity line and the status line already say the run waits for the user. */}
        {busy && pendingCalls.length === 0 && visibleItems[visibleItems.length - 1]?.kind !== 'assistant' && visibleItems[visibleItems.length - 1]?.kind !== 'replies' && (
          <div className="ai-thinking">
            <span className="spinner" />
          </div>
        )}
        {notice && !(account && ready && config) && <div className="ai-notice">{notice}</div>}
      </div>
        <div className="ai-live-status" role="status" aria-live="polite" aria-atomic="true">{liveStatus(status, busy, justExecuted)}</div>

      {account && ready && config && (
        <footer className="ai-footer">
          {notice && <div className="ai-send-notice" role="alert">{notice}</div>}
          {status && (
            // Says why the answer stopped and can bring the card into view; never a way to allow (only the card, next to its parameters, does that).
            <div className="ai-status-line" role="status">
              <IconPause />
              <span className="ai-status-text">{status}</span>
              {hidden.length > 0 && (
                <button
                  type="button"
                  className="ai-card-btn"
                  // Scroll only: the focus stays where the user left it, so a ↵ typed next can't land on the card.
                  onClick={() => document.getElementById(hidden[0])?.scrollIntoView({ block: 'center' })}
                >
                  {hidden[0].startsWith('approval-') ? '跳到审批' : '跳到提案'}
                </button>
              )}
            </div>
          )}
          {/* Always in view, not in the usage popover: it may be why a turn is refused. */}
          {month?.budget && (
            <div className={`ai-budget-note${month.blocked ? ' blocked' : ''}`} role="status">
              {month.budget}
            </div>
          )}
          <Composer
            scope={scope}
            value={visibleInput}
            onChange={(text) => {
              setDraft(text)
              // Typing means the user is writing their own answer: the chips go.
              if (text && shownReplies) setDismissedReplies(shownReplies.id)
            }}
            onSend={() => submitText(visibleInput, runCommand, (text) => void send(text))}
            onCommand={runCommand}
            onStop={stop}
            onClose={onClose}
            busy={busy}
            pausedOnApproval={pendingCalls.length > 0}
            history={visibleItems.flatMap((i) => (i.kind === 'user' ? [i.text] : []))}
            inputRef={inputRef}
            chip={page !== undefined && <PageChip page={page} on={pageOn} readPage={config.readPage !== false} onToggle={togglePage} />}
            config={config}
            models={models}
            onModel={pickModel}
            onOpenSettings={onOpenSettings}
            usage={usage}
            month={month}
          />
        </footer>
      )}
    </aside>
  )
}

interface ItemProps {
  item: NonToolItem
  index: number
  userIndex: number
  retryable: boolean
  actionsDisabled: boolean
  cardDisabled: boolean
  editing: boolean
  editText: string
  onEditText: (text: string) => void
  onEdit: () => void
  onCancelEdit: () => void
  onRegenerate: (index: number, text?: string) => void
  onCopy: (text: string) => void
  onOpenModel: () => void
  older: boolean
  onLink: (url: string) => void
  onCardAction: (cardId: string, actionId: string, rowId?: string, values?: FormValues) => Promise<CardActionResult>
  onProposal: (proposalId: string, confirm: boolean, typed?: string) => Promise<CardActionResult>
  onApproval: (approvalId: string, decision: ApprovalDecision) => Promise<CardActionResult>
  accountColor: string
}

export function Item({ item, index, userIndex, retryable, actionsDisabled, cardDisabled, editing, editText, onEditText, onEdit, onCancelEdit, onRegenerate, onCopy, onOpenModel, older, onLink, onCardAction, onProposal, onApproval, accountColor }: ItemProps): React.JSX.Element | null {
  if (item.kind === 'user') {
    return (
      <div className="ai-user-turn">
        {editing ? <div className="ai-inline-edit">
          <textarea aria-label="编辑消息" autoFocus value={editText} onChange={(e) => onEditText(e.target.value)} onKeyDown={(e) => {
            const action = editKey(e.key, e.metaKey || e.ctrlKey, e.shiftKey, e.nativeEvent.isComposing)
            if (action) { e.preventDefault(); if (action === 'cancel') onCancelEdit(); else if (editText.trim()) onRegenerate(index, editText) }
          }} />
          <div><button type="button" disabled={actionsDisabled || !editText.trim()} onClick={() => onRegenerate(index, editText)}>发送修改</button><button type="button" onClick={onCancelEdit}>取消</button><span>⌘↵ 发送 · Esc 取消</span></div>
        </div> : <div className="ai-msg user">{item.text}</div>}
        {item.page && (
          <div className="ai-msg-page" title="提问时打开的页面">
            {item.page}
          </div>
        )}
        {!editing && regenerationOrdinal(item) !== null && <MessageActions kind="user" text={item.text} disabled={actionsDisabled} onRegenerate={() => onRegenerate(index)} onEdit={onEdit} onCopy={onCopy} />}
      </div>
    )
  }
  // Chips are drawn once, under the last reply (visibleReplies), not in place.
  if (item.kind === 'replies') return null
  if (item.kind === 'note') return <div className="ai-dim small">{item.text}</div>
  if (item.kind === 'approval') {
    const id = item.approval.id
    const card = <ApprovalCard approval={item.approval} disabled={cardDisabled} accountColor={accountColor} onDecide={(d) => onApproval(id, d)} />
    return older && item.approval.state !== 'pending' ? <details className="ai-old-card"><summary>上一个审批：{item.approval.service}:{item.approval.action} · {item.approval.state === 'allowed' ? '✓ 已允许' : item.approval.state === 'denied' ? '✗ 已拒绝' : '■ 已停止'}</summary>{card}</details> : card
  }
  if (item.kind === 'proposal') {
    const id = item.proposal.id
    return (
      <ProposalCard
        proposal={item.proposal}
        older={older}
        disabled={cardDisabled}
        accountColor={accountColor}
        onLink={onLink}
        onConfirm={(typed) => onProposal(id, true, typed)}
        onCancel={() => onProposal(id, false)}
      />
    )
  }
  if (item.kind === 'card') {
    const card = item.card
    if (!card) return <CardSkeleton />
    const view = <CardView card={card} disabled={cardDisabled} onLink={onLink} accountColor={accountColor} onAction={(a, row, values) => onCardAction(card.id, a, row, values)} />
    return older && card.state !== 'active' && card.origin === 'system' ? <details className="ai-old-card"><summary>上一个卡片：{card.title} · {card.state === 'resolved' ? '✓ 已处理' : '■ 已失效'}</summary>{view}</details> : view
  }
  return (
    <div className="ai-assistant-turn">
      {item.text && <div className="ai-msg assistant"><Markdown text={item.text} onLink={onLink} /></div>}
      <MessageFailure error={item.error} aborted={item.aborted} disabled={actionsDisabled} hideRetry={!retryable || item.retryable === false} onRetry={() => onRegenerate(userIndex)} onModel={onOpenModel} onCopy={onCopy} />
    </div>
  )
}
