import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  ATTACH_LIMITS,
  BEDROCK_PROVIDER_ID,
  CUSTOM_PROVIDER_ID,
  type AiConfigView,
  type AttachmentMeta,
  type AiModelInfo,
  type ApprovalDecision,
  type CardActionResult,
  type ChatItem,
  type ConversationSummary,
  type MonthUsage,
  type PageContext,
  type ResourceCandidate,
  type QueuedMessage,
  type ConversationSearchResult,
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
import { chipReducer, classifyAttachment, discardLatePrepared, dragFilesVisible, expiredChips, readyChips, sendText, sourceFromFile, type AttachmentChip } from './attachments'
import { MessageAttachments } from './MessageAttachments'
import { ConversationPopover } from './ConversationPopover'
import { canSendText, submitText, type LocalCommand } from './commands'
import { EmptyState } from './EmptyState'
import { Markdown } from './Markdown'
import { editKey, fromUserIndex, isOlder, MessageActions, MessageFailure, panelEscapeStops, truncatesChanges, turnActionsAt } from './MessageActions'
import { cardDisabledState, liveStatus, pendingDecisionCount, regenerationOrdinal, regenerationPreview, resultChange, restoreQueuedDraft, removeQueuedPreview, mergeQueuedResources, invalidatesHistoryReload, historyConversationDeleted, modelWaitingText } from './panelLogic'
import type { Block } from '../../../../shared/cards'
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
  const [conversationsAccount, setConversationsAccount] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [usage, setUsage] = useState<UsageTotals | null>(null)
  const [month, setMonth] = useState<MonthUsage | null>(null)
  // Conversations with a run in flight; runs keep going when the panel switches away.
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set())
  const [modelStatus, setModelStatus] = useState<ReadonlyMap<string, { status: 'waiting' | 'retrying' | 'received'; startedAt: number }>>(new Map())
  const [clock, setClock] = useState(() => ({ now: Date.now(), previous: Date.now() - 1000 }))
  const [notice, setNotice] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentChip[]>([])
  const attachmentDrafts = useRef(new Map<string, AttachmentChip[]>())
  const knownAttachments = useRef(new Map<string, { chip: AttachmentChip; accountId: string }>())
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null)
  const [attachmentAnnouncement, setAttachmentAnnouncement] = useState('')
  const imageConversion = useRef(Promise.resolve())
  const announcementCount = useRef(0)
  const announceAttachment = (text: string): void => { announcementCount.current++; setAttachmentAnnouncement(text + "\u200b".repeat(announcementCount.current % 2 + 1)) }
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [resources, setResources] = useState<ResourceCandidate[]>([])
  const [resourceQuery, setResourceQuery] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<ResourceCandidate[]>([])
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ConversationSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [viewScope, setViewScope] = useState(() => draftKey(account?.id ?? null, null))
  const [drafts] = useState(draftStore)
  const resourceDrafts = useRef(new Map<string, ResourceCandidate[]>())
  const failedNotices = useRef(new Map<string, string>())
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
  const [editResources, setEditResources] = useState<ResourceCandidate[]>([])
  const [editAttachments, setEditAttachments] = useState<AttachmentMeta[]>([])
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
  const eventVersions = useRef(new Map<string, number>())
  const accountRef = useRef<string | null>(null)
  /** Last conversation shown per account, so switching accounts and back returns to it. */
  const lastByAccount = useRef(new Map<string, string | null>())

  const accountId = account?.id ?? null
  useEffect(() => {
    if (!running.size) return
    const timer = setInterval(() => setClock((current) => ({ now: Date.now(), previous: current.now })), 1000)
    return () => clearInterval(timer)
  }, [running])
  const closeConversations = (): void => {
    setConversationsOpen(false)
    setEditTarget(null)
    requestAnimationFrame(() => titleRef.current?.focus())
  }
  accountRef.current = accountId
  const scope = draftKey(accountId, conversationId)
  currentRef.current = scope
  const { items: visibleItems, input: visibleInput } = scopedContent(scope, viewScope, items, input)
  const visibleConversations = conversationsAccount === accountId ? conversations : []
  const ready = aiReady(config)
  const busy = conversationId !== null && running.has(conversationId)
  const setAttachmentDraft = (target: string, chips: AttachmentChip[]): void => {
    attachmentDrafts.current.set(target, chips)
    if (currentRef.current === target) setAttachments(chips)
  }
  const restoreAttachments = (target: string): void => {
    const before = attachmentDrafts.current.get(target) ?? []
    const next = expiredChips(before, Date.now())
    if (next.length !== before.length) setAttachmentNotice('附件已过期，请重新添加')
    for (const chip of before) if (!next.includes(chip) && chip.id) { knownAttachments.current.delete(chip.id); void ai.attachmentDiscard(target.split('/')[0], chip.id).catch(() => {}) }
    setAttachmentDraft(target, next)
  }
  const discardScope = (target: string): void => {
    for (const chip of attachmentDrafts.current.get(target) ?? []) if (chip.id) { knownAttachments.current.delete(chip.id); void ai.attachmentDiscard(target.split('/')[0], chip.id).catch(() => {}) }
    attachmentDrafts.current.delete(target)
    if (currentRef.current === target) setAttachments([])
  }
  useEffect(() => {
    const timer = setInterval(() => {
      for (const key of attachmentDrafts.current.keys()) {
        const before = attachmentDrafts.current.get(key) ?? []
        const next = chipReducer(before, { type: 'expire', now: Date.now() })
        if (next.length !== before.length) {
          setAttachmentDraft(key, next)
          for (const chip of before) if (!next.includes(chip) && chip.id) { knownAttachments.current.delete(chip.id); void ai.attachmentDiscard(key.split('/')[0], chip.id).catch(() => {}) }
          if (currentRef.current === key) setAttachmentNotice('附件已过期，请重新添加')
        }
      }
      for (const [id, known] of knownAttachments.current) if (Date.now() - known.chip.createdAt >= ATTACH_LIMITS.pendingTtlMs) { knownAttachments.current.delete(id); void ai.attachmentDiscard(known.accountId, id).catch(() => {}) }
    }, 15_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const reset = (): void => setDraggingFiles(false)
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') reset() }
    for (const type of ['drop', 'dragend', 'blur']) window.addEventListener(type, reset)
    window.addEventListener('keydown', escape)
    return () => { for (const type of ['drop', 'dragend', 'blur']) window.removeEventListener(type, reset); window.removeEventListener('keydown', escape) }
  }, [])
  const addAttachments = (files: File[]): void => {
    if (!accountId || !config || !ready) return
    const target = currentRef.current ?? scope
    let chips = attachmentDrafts.current.get(target) ?? []
    const addError = (file: File, reason: string): void => {
      const rejected: AttachmentChip = { localId: crypto.randomUUID(), id: '', kind: /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(file.name) ? 'image' : 'file', name: file.name, size: file.size, state: 'error', reason, createdAt: Date.now() }
      chips = chipReducer(chips, { type: 'add', chip: rejected })
      setAttachmentDraft(target, chips)
      announceAttachment(`${file.name}：${reason}`)
    }
    for (const file of files) {
      const pending = [...attachmentDrafts.current.entries()].flatMap(([key, draft]) => key.startsWith(`${accountId}/`) ? draft : []).filter((c) => c.state !== 'error').length
      if (pending >= ATTACH_LIMITS.pendingPerAccount) { addError(file, `待发送附件最多 ${ATTACH_LIMITS.pendingPerAccount} 个`); continue }
      const globalPending = [...attachmentDrafts.current.values()].flat().filter((c) => c.state !== 'error').length
      if (globalPending >= ATTACH_LIMITS.pendingGlobal) { addError(file, `待发送附件总计最多 ${ATTACH_LIMITS.pendingGlobal} 个`); continue }
      const images = chips.filter((c) => c.kind === 'image' && c.state !== 'error').length
      const textFiles = chips.filter((c) => c.kind === 'file' && c.state !== 'error').length
      const textBytes = chips.filter((c) => c.kind === 'file' && c.state !== 'error').reduce((total, c) => total + (c.state === 'ready' ? c.size : Math.min(c.size, ATTACH_LIMITS.textOutputBytes)), 0)
      const result = classifyAttachment(file, config.canAttachImages, images, textFiles, textBytes)
      if (!result.kind) { addError(file, result.reason ?? '不支持此文件类型'); continue }
      const chip: AttachmentChip = { localId: crypto.randomUUID(), id: '', kind: result.kind, name: file.name, size: file.size, state: 'preparing', createdAt: Date.now() }
      chips = chipReducer(chips, { type: 'add', chip })
      setAttachmentDraft(target, chips)
      setAttachmentNotice(null)
      void (async () => {
        const reject = (reason: string): void => {
          const current = attachmentDrafts.current.get(target) ?? []
          setAttachmentDraft(target, chipReducer(current, { type: 'prepared', localId: chip.localId, chip: { ...chip, state: 'error', reason } }))
          announceAttachment(`${chip.name}：${reason}`)
        }
        let source
        try {
          if (result.kind === 'image') {
            const conversion = imageConversion.current.then(() => sourceFromFile(file, 'image'))
            imageConversion.current = conversion.then(() => {}, () => {})
            source = await conversion
          } else source = await sourceFromFile(file, 'file')
        } catch (err) {
          reject(ipcError(err).includes('图片太大') ? '图片太大' : ipcError(err).includes('图片尺寸超出限制') ? '图片尺寸超出限制' : result.kind === 'image' ? '无法读取这张图片' : '无法读取文件')
          return
        }
        if (!(attachmentDrafts.current.get(target) ?? []).some((c) => c.localId === chip.localId)) return
        try {
          const prepared = (await ai.attachmentPrepare(accountId, target.split('/').slice(1).join('/') || null, [source]))[0]
          const current = attachmentDrafts.current.get(target) ?? []
          if (discardLatePrepared(current, chip.localId, Boolean(prepared?.ok))) { if (prepared?.ok) void ai.attachmentDiscard(accountId, prepared.id).catch(() => {}); return }
          if (!current.some((c) => c.localId === chip.localId)) return
          const next: AttachmentChip = prepared?.ok ? { ...chip, ...prepared, state: 'ready', createdAt: Date.now() } : { ...chip, state: 'error', reason: prepared?.reason ?? '附件准备失败' }
          if (prepared?.ok) { knownAttachments.current.set(prepared.id, { chip: next, accountId }); announceAttachment(`已添加 ${next.name}`) }
          else announceAttachment(`${next.name}：${next.reason}`)
          setAttachmentDraft(target, chipReducer(current, { type: 'prepared', localId: chip.localId, chip: next }))
        } catch (err) {
          reject(ipcError(err))
        }
      })()
    }
  }
  const removeAttachment = (chip: AttachmentChip): void => {
    const target = currentRef.current ?? scope
    setAttachmentDraft(target, chipReducer(attachmentDrafts.current.get(target) ?? [], { type: 'remove', localId: chip.localId }))
    if (chip.id && accountId) void ai.attachmentDiscard(accountId, chip.id).catch(() => {})
    if (chip.id) knownAttachments.current.delete(chip.id)
    announceAttachment('已移除')
  }
  const waitText = modelWaitingText(conversationId ? modelStatus.get(conversationId) : undefined, clock.now, clock.previous)
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
    if (currentRef.current === draftKey(accId, null) && target !== currentRef.current) discardScope(currentRef.current)
    currentRef.current = target
    setConversationId(id)
    setViewScope(target)
    setItems([])
    setQueue([])
    setResources(resourceDrafts.current.get(target) ?? [])
    setAttachmentNotice(null)
    restoreAttachments(target)
    setResourceQuery(null)
    setUsage(null)
    lastByAccount.current.set(accId, id)
    setNotice(failedNotices.current.get(target) ?? null)
    failedNotices.current.delete(target)
    setJustExecuted(false)
    setEditIndex(null)
    setEditAttachments([])
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
      setQueue(view.queue ?? [])
      setPageOn(view.pageContext)
      setUsage(view.usage)
      setMonth(view.month)
      stickRef.current = true
    } catch (err) {
      if (currentRef.current === target) {
        if (historyConversationDeleted(ipcError(err))) void loadConversation(accId, null)
        setNotice(ipcError(err))
      }
    }
  }, [drafts])

  // Every keystroke, so switching away keeps the text without asking the input for it.
  const setDraft = (text: string): void => {
    setInput(text)
    if (accountId) drafts.set(currentRef.current ?? scope, text)
  }

  const refreshList = useCallback(async (accId: string): Promise<ConversationSummary[]> => {
    const list = await ai.conversations(accId)
    if (accountRef.current === accId) { setConversations(list); setConversationsAccount(accId) }
    return list
  }, [])

  // Each account has its own conversations.
  useEffect(() => {
    const target = draftKey(accountId, null)
    currentRef.current = target
    setConversationId(null)
    setViewScope(target)
    setItems([])
    setQueue([])
    setResources(resourceDrafts.current.get(target) ?? [])
    setAttachmentNotice(null)
    restoreAttachments(target)
    setResourceQuery(null)
    setUsage(null)
    if (!accountId) {
      setConversations([])
      setInput('')
      return
    }
    setConversations([])
    setConversationsAccount(null)
    setSearchResults([])
    setSearchQuery('')
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

  useEffect(() => {
    if (!accountId || resourceQuery === null || resources.length >= 5) { setCandidates([]); return }
    let cancelled = false
    const timer = setTimeout(() => {
      void ai.resourceCandidates(accountId, resourceQuery).then(
        (list) => { if (!cancelled) setCandidates(list) },
        () => { if (!cancelled) setCandidates([]) }
      )
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [accountId, resourceQuery, resources.length])

  useEffect(() => {
    if (!accountId || !conversationsOpen || !searchQuery.trim()) { setSearchResults([]); setSearchLoading(false); return }
    let cancelled = false
    setSearchLoading(true)
    const timer = setTimeout(() => {
      void ai.search(accountId, searchQuery.trim()).then(
        (list) => { if (!cancelled) { setSearchResults(list); setSearchLoading(false) } },
        () => { if (!cancelled) { setSearchResults([]); setSearchLoading(false) } }
      )
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [accountId, conversationsOpen, searchQuery])

  useEffect(
    () =>
      ai.onEvent(({ accountId: acc, conversationId: id, runId, event }) => {
        if (invalidatesHistoryReload(runId, event.type)) eventVersions.current.set(id, (eventVersions.current.get(id) ?? 0) + 1)
        if (event.type === 'done') {
          setModelStatus((prev) => { const next = new Map(prev); next.delete(id); return next })
          const version = eventVersions.current.get(id) ?? 0
          setRunning((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          if (acc === accountId) void refreshList(acc)
          // The stored transcript is the truth; the live items were a preview of it.
          if (draftKey(acc, id) === currentRef.current) {
            void ai.history(acc, id).then((view) => {
              if (currentRef.current !== draftKey(acc, id) || version !== (eventVersions.current.get(id) ?? 0)) return
              setItems(view.items)
              setQueue(view.queue ?? [])
              setUsage(view.usage)
              setMonth(view.month)
            }).catch((err) => {
              if (currentRef.current !== draftKey(acc, id)) return
              if (historyConversationDeleted(ipcError(err))) void loadConversation(acc, null)
              setNotice(ipcError(err))
            })
          }
          return
        }
        if (event.type === 'model-status') {
          setModelStatus((prev) => new Map(prev).set(id, { status: event.status, startedAt: event.startedAt }))
        }
        if (event.type === 'queue') {
          if (draftKey(acc, id) === currentRef.current) setQueue(event.items)
          return
        }
        if (event.type === 'user') for (const attachment of event.attachments ?? []) knownAttachments.current.delete(attachment.id)
        if (event.type === 'queue-failed') {
          const target = event.message === '对话已删除' ? draftKey(acc, null) : draftKey(acc, id)
          const deleted = event.message === '对话已删除'
          const restored = deleted ? null : restoreQueuedDraft(drafts, currentRef.current, target, event.attachmentIds?.length && event.text === '请看附件。' ? '' : event.text)
          const merged = deleted ? [] : mergeQueuedResources(resourceDrafts.current.get(target) ?? [], event.context?.resources ?? [], event.resources)
          if (!deleted) resourceDrafts.current.set(target, merged)
          if (!deleted && event.attachmentIds?.length) {
            const returned = event.attachmentIds.flatMap((attachmentId) => {
              const chip = knownAttachments.current.get(attachmentId)?.chip
              return chip ? [chip] : []
            })
            const valid = expiredChips(returned, Date.now())
            for (const chip of returned) if (!valid.includes(chip)) { knownAttachments.current.delete(chip.id); void ai.attachmentDiscard(acc, chip.id).catch(() => {}) }
            if (valid.length !== returned.length) setAttachmentNotice('附件已过期，请重新添加')
            setAttachmentDraft(target, chipReducer(attachmentDrafts.current.get(target) ?? [], { type: 'restore', chips: valid, now: Date.now() }))
          }
          const message = deleted ? '对话已删除，排队消息已丢弃' : `排队消息未发送：${event.message}`
          if (target !== currentRef.current) failedNotices.current.set(target, message)
          if (deleted && currentRef.current === target) setNotice(message)
          if (restored !== null) {
            setInput(restored)
            setResources(merged)
            setNotice(message)
          }
          return
        }
        if (acc === accountId && (event.type === 'approval' || event.type === 'proposal' || event.type === 'proposal-state')) void refreshList(acc)
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
    [accountId, refreshList, loadConversation]
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
    if (stickRef.current) scrollToEnd()
  }, [attachments, scrollToEnd])
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
    const sentChips = readyChips(attachmentDrafts.current.get(scope) ?? [])
    if (!accountId || (!canSendText(text) && !sentChips.length) || (attachmentDrafts.current.get(scope) ?? []).some((c) => c.state === 'preparing')) return
    const originalText = text
    text = sendText(text, sentChips)
    const sentScope = scope
    setJustExecuted(false)
    setNotice(null)
    setDraft('')
    stickRef.current = true
    const sentResources = resources
    const preview: ChatItem = { kind: 'user', text: text.trim(), resources: sentResources, attachments: sentChips }
    setAttachmentDraft(sentScope, [])
    setResources([])
    resourceDrafts.current.delete(sentScope)
    setResourceQuery(null)
    if (!busy) setItems((prev) => [...prev, preview])
    try {
      const { conversationId: id, warning, queued } = await ai.send(accountId, conversationId, text, pageOn, sentResources.length ? { resources: sentResources.map(({ type, id, region }) => ({ type, id, region })) } : undefined, sentChips.map((c) => c.id))
      if (queued && !busy && currentRef.current === sentScope) setItems((prev) => removeQueuedPreview(prev, preview))
      if (warning && currentRef.current === sentScope) setNotice(warning)
      if (!queued) setRunning((prev) => new Set(prev).add(id))
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
      const restored = restoreFailedSend(drafts.get(sentScope), originalText)
      drafts.set(sentScope, restored)
      const merged = mergeQueuedResources(resourceDrafts.current.get(sentScope) ?? [], sentResources)
      resourceDrafts.current.set(sentScope, merged)
      const valid = ipcError(err).includes('附件已过期') ? [] : expiredChips(sentChips, Date.now())
      setAttachmentDraft(sentScope, chipReducer(attachmentDrafts.current.get(sentScope) ?? [], { type: 'restore', chips: valid, now: Date.now() }))
      if (valid.length !== sentChips.length || ipcError(err).includes('附件已过期')) setAttachmentNotice('附件已过期，请重新添加')
      if (currentRef.current === sentScope) {
        setItems((prev) => removeQueuedPreview(prev, preview))
        setInput(restored)
        setResources(merged)
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
    setItems(regenerationPreview(visibleItems, index, text ?? selected.text).map((item) =>
      item.kind === 'user' && item.ordinal === ordinal && text !== undefined && editIndex === index ? { ...item, resources: editResources, attachments: editAttachments } : item))
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([
        ai.regenerate(accountId, conversationId, ordinal, selected.text, text, text !== undefined && editIndex === index
          ? { resources: editResources.map(({ type, id, region }) => ({ type, id, region })) } : undefined,
        text !== undefined && editIndex === index ? editAttachments.map((a) => a.id) : undefined),
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
    const title = visibleConversations.find((c) => c.id === id)?.title || '这个对话'
    if (!confirm(`删除「${title}」？`)) return
    try {
      await ai.delete(accountId, id)
      discardScope(draftKey(accountId, id))
      await refreshList(accountId)
      if (id === conversationId) void loadConversation(accountId, null)
    } catch (err) {
      setNotice(ipcError(err))
    }
  }

  const clearAll = async (): Promise<void> => {
    if (!accountId || !account || !confirm(`删除「${account.name}」的全部 AI 对话？`)) return
    await ai.clear(accountId)
    for (const key of attachmentDrafts.current.keys()) if (key.startsWith(`${accountId}/`)) discardScope(key)
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

  const pin = async (id: string, pinned: boolean): Promise<void> => {
    if (!accountId) return
    try { await ai.pin(accountId, id, pinned); void refreshList(accountId) }
    catch (err) { setNotice(ipcError(err)) }
  }

  const feedback = async (ordinal: number, value: 'up' | 'down' | null): Promise<void> => {
    if (!accountId || !conversationId) return
    const old = items.find((item) => item.kind === 'assistant' && item.ordinal === ordinal)
    setItems((prev) => prev.map((item) => item.kind === 'assistant' && item.ordinal === ordinal ? { ...item, feedback: value } : item))
    try { await ai.feedback(accountId, conversationId, ordinal, value) }
    catch (err) { setItems((prev) => prev.map((item) => item.kind === 'assistant' && item.ordinal === ordinal && old?.kind === 'assistant' ? { ...item, feedback: old.feedback } : item)); setNotice(ipcError(err)) }
  }

  const denyAll = async (): Promise<void> => {
    if (!accountId || !conversationId || !confirm('拒绝这个对话中全部待处理的审批和提案？')) return
    try { await ai.denyAll(accountId, conversationId) }
    catch (err) { setNotice(ipcError(err)) }
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
  const current = visibleConversations.find((c) => c.id === conversationId)
  const allowed = allows.filter((a) => a.conversationId === conversationId)

  return (
    <aside ref={panelRef} className="ai-panel" style={{ width }} aria-label="AI 助手" onDragEnter={(e) => {
      if (!accountId || !ready || !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDraggingFiles((current) => dragFilesVisible(current, 'enter', true))
    }} onDragLeave={(e) => {
      if (!e.dataTransfer.types.includes('Files')) return
      setDraggingFiles((current) => dragFilesVisible(current, 'leave', Boolean(e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node))))
    }} onDragOver={(e) => { if (accountId && ready && e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={(e) => {
      setDraggingFiles(false)
      if (accountId && ready && e.dataTransfer.types.includes('Files')) {
        e.preventDefault()
        const files = [...e.dataTransfer.items].filter((item) => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file))
        addAttachments(e.dataTransfer.items.length ? files : [...e.dataTransfer.files])
      }
    }} onKeyDown={(e) => {
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
      {account && ready && <ConversationPopover key={account.id} conversations={visibleConversations} currentId={conversationId} running={running} open={conversationsOpen} editTarget={editTarget} onClose={closeConversations} onOpen={(id) => void loadConversation(account.id, id)} onRename={(id, title) => void rename(id, title)} onDelete={(id) => void remove(id)} onClear={() => void clearAll()} onPin={(id, pinned) => void pin(id, pinned)} searchQuery={searchQuery} searchResults={searchResults} searchLoading={searchLoading} onSearch={setSearchQuery} />}

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
            recent={visibleConversations.filter((c) => c.id !== conversationId)}
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
                resultChange={item.kind === 'card' ? resultChange(visibleItems, item.id) : null}
                index={index}
                older={isOlder(visibleItems, index)}
                userIndex={fromUserIndex(visibleItems, index)}
                retryable={user?.kind === 'user' && regenerationOrdinal(user) !== null}
                actionsDisabled={actionsDisabled}
                cardDisabled={cardDisabled}
                editing={editIndex === index}
                editText={editText}
                editResources={editResources}
                editAttachments={editAttachments}
                accountId={accountId ?? ''}
                conversationId={conversationId}
                onEditText={setEditText}
                onRemoveEditResource={(candidate) => setEditResources((prev) => prev.filter((r) => r.type !== candidate.type || r.id !== candidate.id || r.region !== candidate.region))}
                onRemoveEditAttachment={(attachmentId) => setEditAttachments((prev) => prev.filter((a) => a.id !== attachmentId))}
                onEdit={() => { setEditIndex(index); setEditText(item.kind === 'user' ? item.text : ''); setEditResources(item.kind === 'user' ? item.resources ?? [] : []); setEditAttachments(item.kind === 'user' ? item.attachments ?? [] : []) }}
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
              {actions && <MessageActions kind="assistant" text={actions.text} model={actions.model} usage={actions.usage} feedback={actions.feedback} onFeedback={actions.ordinal === undefined ? undefined : (value) => void feedback(actions.ordinal!, value)} disabled={actionsDisabled} onRegenerate={() => void regenerate(actions.userIndex)} onCopy={copy} />}
            </Fragment>
          })
        )}
        {replies && <QuickReplies options={replies.options} disabled={attachments.some((a) => a.state === 'preparing')} onSend={(text) => void send(text)} />}
        {/* Not while paused on an approval: the Activity line and the status line already say the run waits for the user. */}
        {busy && pendingCalls.length === 0 && visibleItems[visibleItems.length - 1]?.kind !== 'assistant' && visibleItems[visibleItems.length - 1]?.kind !== 'replies' && (
          <div className="ai-thinking">
            <span className="spinner" aria-hidden="true" />
            <span aria-hidden="true">{waitText.visual}</span>
            <span className="sr-only" aria-live="polite">{waitText.announcement}</span>
          </div>
        )}
        {notice && !(account && ready && config) && <div className="ai-notice">{notice}</div>}
      </div>
        <div className="ai-live-status" role="status" aria-live="polite" aria-atomic="true">{liveStatus(status, busy, justExecuted)}</div>

      {draggingFiles && <div className="ai-drop-overlay" aria-live="polite">松开以添加附件</div>}
      {account && ready && config && (
        <footer className="ai-footer">
          {notice && <div className="ai-send-notice" role="alert">{notice}</div>}
          {pendingDecisionCount(visibleItems) >= 2 && <button type="button" className="ai-deny-all" disabled={regenerating} onClick={() => void denyAll()}>全部拒绝（{pendingDecisionCount(visibleItems)}）</button>}
          {queue.length > 0 && <QueueView queue={queue} accountId={accountId ?? ''} conversationId={conversationId} onCancel={(q) => { if (accountId && conversationId) void ai.queueCancel(accountId, conversationId, q.id).catch((err) => setNotice(ipcError(err))) }} />}
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
            onSend={() => readyChips(attachments).length && !visibleInput.trim() ? void send('') : submitText(visibleInput, runCommand, (text) => void send(text))}
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
            resources={resources}
            candidates={candidates}
            onResourceQuery={setResourceQuery}
            onSelectResource={(candidate) => setResources((prev) => {
              const next = [...prev, candidate]
              resourceDrafts.current.set(scope, next)
              return next
            })}
            onRemoveResource={(candidate) => setResources((prev) => {
              const next = prev.filter((r) => r.type !== candidate.type || r.id !== candidate.id || r.region !== candidate.region)
              resourceDrafts.current.set(scope, next)
              return next
            })}
            attachments={attachments}
            onAddAttachments={addAttachments}
            onRemoveAttachment={removeAttachment}
            attachmentNotice={attachmentNotice}
            attachmentAnnouncement={attachmentAnnouncement}
          />
        </footer>
      )}
    </aside>
  )
}

export function QueueView({ queue, accountId = '', conversationId = null, onCancel }: { queue: QueuedMessage[]; accountId?: string; conversationId?: string | null; onCancel: (item: QueuedMessage) => void }): React.JSX.Element {
  return <div className="ai-queue" role="list" aria-label="排队消息">{queue.map((q) => <div key={q.id} role="listitem" className="ai-msg user ai-queued-user"><span><span className="ai-dim small">排队中 · </span>{q.text}{q.attachments?.length ? <MessageAttachments accountId={accountId} conversationId={conversationId} attachments={q.attachments} previewOnly onCopy={() => {}} /> : null}</span><button type="button" aria-label={`取消排队：${q.text}`} onClick={() => onCancel(q)}>取消</button></div>)}</div>
}

interface ItemProps {
  item: NonToolItem
  resultChange?: Extract<Block, { type: 'change' }> | null
  index: number
  userIndex: number
  retryable: boolean
  actionsDisabled: boolean
  cardDisabled: boolean
  editing: boolean
  editText: string
  editResources?: ResourceCandidate[]
  editAttachments?: AttachmentMeta[]
  accountId?: string
  conversationId?: string | null
  onRemoveEditAttachment?: (id: string) => void
  onEditText: (text: string) => void
  onRemoveEditResource?: (resource: ResourceCandidate) => void
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

export function Item({ item, resultChange: change, index, userIndex, retryable, actionsDisabled, cardDisabled, editing, editText, editResources, editAttachments, accountId = '', conversationId = null, onEditText, onRemoveEditResource, onRemoveEditAttachment, onEdit, onCancelEdit, onRegenerate, onCopy, onOpenModel, older, onLink, onCardAction, onProposal, onApproval, accountColor }: ItemProps): React.JSX.Element | null {
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
        {(editing ? editResources : item.resources)?.length ? <div className="ai-msg-resources" aria-label="引用的资源">{(editing ? editResources : item.resources)!.map((r) => <span key={`${r.type}/${r.region}/${r.id}`} className="ai-chip">{r.label} · {r.id} · {r.region}{editing && <button type="button" aria-label={`移除资源引用：${r.label}`} onClick={() => onRemoveEditResource?.(r)}>×</button>}</span>)}</div> : null}
        {(editing ? editAttachments : item.attachments)?.length ? <MessageAttachments accountId={accountId} conversationId={conversationId} attachments={(editing ? editAttachments : item.attachments)!} editing={editing} onRemove={onRemoveEditAttachment} onCopy={onCopy} /> : null}
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
    const view = <CardView card={change ? { ...card, blocks: [...card.blocks, { ...change, summary: '已执行的变更（提案时 → 执行目标）' }] } : card} disabled={cardDisabled} onLink={onLink} accountColor={accountColor} onAction={(a, row, values) => onCardAction(card.id, a, row, values)} />
    return older && card.state !== 'active' && card.origin === 'system' ? <details className="ai-old-card"><summary>上一个卡片：{card.title} · {card.state === 'resolved' ? '✓ 已处理' : '■ 已失效'}</summary>{view}</details> : view
  }
  return (
    <div className="ai-assistant-turn">
      {item.text && <div className="ai-msg assistant"><Markdown text={item.text} onLink={onLink} /></div>}
      <MessageFailure error={item.error} diagnosticText={item.diagnosticText} aborted={item.aborted} disabled={actionsDisabled} hideRetry={!retryable || item.retryable === false} onRetry={() => onRegenerate(userIndex)} onModel={onOpenModel} onCopy={onCopy} />
    </div>
  )
}
