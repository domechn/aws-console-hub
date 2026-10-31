import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { AI_PROVIDERS, BEDROCK_PROVIDER_ID, CUSTOM_PROVIDER_ID, MAX_PROMPT_CHARS, type AiConfigView, type AiModelInfo, type MonthUsage, type ResourceCandidate, type UsageTotals } from '../../../../shared/ai'
import { formatCost, formatMonth, formatUsage } from '../../ai'
import { IconArrowUp, IconCheck, IconChevronDown, IconStop } from '../icons'
import { localCommand, menuSelection, type LocalCommand } from './commands'

export type ComposerAction = 'send' | 'stop' | 'close' | 'history-up' | 'history-down' | null

interface KeyLike {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isComposing: boolean
  keyCode?: number
}

/**
 * What a key in the input does. Nothing here approves anything: approval cards only take keys while they hold the
 * focus themselves (approvalKey), and the input never moves the focus to them.
 */
export function composerKey(e: KeyLike, busy: boolean): ComposerAction {
  // An IME uses Enter to commit a candidate and Esc to drop it; Chromium reports keyCode 229 for such keys.
  if (e.isComposing || e.keyCode === 229) return null
  if (e.key === 'Enter' && !e.shiftKey) return 'send'
  if (e.key === 'Escape') return busy ? 'stop' : 'close'
  const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
  if (plain && e.key === 'ArrowUp') return 'history-up'
  if (plain && e.key === 'ArrowDown') return 'history-down'
  return null
}

/** Browsing the sent messages: which one is shown, and the text that was there before. */
export interface Recall {
  index: number
  stash: string
}

/**
 * ↑ / ↓ through earlier messages. Starts only from an empty input or with the caret at the very start (where ↑ has
 * no line to move to); continues while the shown message is unedited. Null: the key keeps its usual meaning.
 */
export function recall(history: string[], value: string, caretAtStart: boolean, at: Recall | null, dir: 'up' | 'down'): { value: string; at: Recall | null } | null {
  const browsing = at !== null && history[at.index] === value
  if (dir === 'up') {
    if (browsing) return at.index === 0 ? { value, at } : { value: history[at.index - 1], at: { ...at, index: at.index - 1 } }
    if (!caretAtStart || history.length === 0) return null
    return { value: history[history.length - 1], at: { index: history.length - 1, stash: value } }
  }
  if (!browsing) return null
  return at.index === history.length - 1 ? { value: at.stash, at: null } : { value: history[at.index + 1], at: { ...at, index: at.index + 1 } }
}

/** Unsent text per conversation, in memory only: switching conversations (or accounts) and back finds it again. */
export function draftStore(): { get: (key: string) => string; set: (key: string, text: string) => void } {
  const drafts = new Map<string, string>()
  return {
    get: (key) => drafts.get(key) ?? '',
    set: (key, text) => void (text ? drafts.set(key, text) : drafts.delete(key))
  }
}

export const draftKey = (accountId: string | null, conversationId: string | null): string => `${accountId ?? ''}/${conversationId ?? ''}`

export function scopedContent<T>(active: string, source: string, items: T[], input: string): { items: T[]; input: string } {
  return active === source ? { items, input } : { items: [], input: '' }
}

export function restoreFailedSend(currentDraft: string, sentText: string): string {
  const joined = [currentDraft, sentText].filter((part) => part.length > 0).join('\n\n')
  if (joined.length <= MAX_PROMPT_CHARS) return joined
  const notice = '\n\n[内容过长，已截断]'
  return joined.slice(0, MAX_PROMPT_CHARS - notice.length) + notice
}

export function recallForScope(active: string, previous: string, at: Recall | null): Recall | null {
  return active === previous ? at : null
}

/** The @ token being edited, if the caret is directly after it. */
export function resourceToken(value: string, caret: number): { query: string; start: number; end: number } | null {
  const before = value.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  return match ? { query: match[2], start: caret - match[2].length - 1, end: caret + (/^[^\s@]*/.exec(value.slice(caret))?.[0].length ?? 0) } : null
}

export function insertResource(value: string, token: { start: number; end: number }): string {
  return value.slice(0, token.start) + value.slice(token.end)
}

const SHORT_PROVIDER: Record<string, string> = { [BEDROCK_PROVIDER_ID]: 'Bedrock', [CUSTOM_PROVIDER_ID]: '自定义端点' }

/** 「服务商 · 模型」 as the toolbar shows it. */
export function modelLabel(config: AiConfigView, models: AiModelInfo[]): string {
  const provider = SHORT_PROVIDER[config.provider] ?? AI_PROVIDERS.find((p) => p.id === config.provider)?.label ?? config.provider
  return `${provider} · ${models.find((m) => m.id === config.model)?.name ?? config.model}`
}

const price = (n: number): string => `$${Number(n.toPrecision(3))}`
const hasUsage = (u: UsageTotals | null | undefined): u is UsageTotals => Boolean(u && (u.input || u.output))

interface Props {
  scope: string
  value: string
  onChange: (text: string) => void
  onSend: () => void
  onCommand?: (command: LocalCommand) => void
  onStop: () => void
  onClose: () => void
  busy: boolean
  pausedOnApproval?: boolean
  /** The conversation's own messages, oldest first: what ↑ walks back through. */
  history: string[]
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  /** The current-page chip, shown inside the box above the text. */
  chip: React.ReactNode
  config: AiConfigView
  /** The configured provider's catalog; with more than one, the model chip switches between them. */
  models: AiModelInfo[]
  onModel: (id: string) => void
  onOpenSettings: () => void
  usage: UsageTotals | null
  month: MonthUsage | null
  resources?: ResourceCandidate[]
  candidates?: ResourceCandidate[]
  onResourceQuery?: (query: string | null) => void
  onSelectResource?: (candidate: ResourceCandidate) => void
  onRemoveResource?: (candidate: ResourceCandidate) => void
}

/** The input box (plan ai-ux-redesign §3.7): grows 1–8 lines, one send / stop button, model and cost in its toolbar. */
export function Composer({ scope, value, onChange, onSend, onCommand, onStop, onClose, busy, pausedOnApproval = false, history, inputRef, chip, config, models, onModel, onOpenSettings, usage, month, resources = [], candidates = [], onResourceQuery, onSelectResource, onRemoveResource }: Props): React.JSX.Element {
  const at = useRef<Recall | null>(null)
  const [commandIndex, setCommandIndex] = useState(-1)
  const [closedCommand, setClosedCommand] = useState<string | null>(null)
  const [resourceIndex, setResourceIndex] = useState(0)
  const [closedResource, setClosedResource] = useState<string | null>(null)
  const [caret, setCaret] = useState(value.length)
  const previousScope = useRef(scope)
  useLayoutEffect(() => {
    at.current = recallForScope(scope, previousScope.current, at.current)
    previousScope.current = scope
  }, [scope])
  useEffect(() => {
    const update = (): void => {
      const el = inputRef.current
      if (!el || document.activeElement !== el) return
      setCaret(el.selectionStart)
      onResourceQuery?.(resourceToken(el.value, el.selectionStart)?.query ?? null)
    }
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [inputRef, onResourceQuery])
  const id = useId()
  const modelPop = `${id}-model`
  const costPop = `${id}-cost`
  const commandListId = `${id}-commands`
  const resourceListId = `${id}-resources`
  const token = resourceToken(value, caret)
  const resourceOpen = token && value !== closedResource && Boolean(onSelectResource) && resources.length < 5
  const shownCandidates = resourceOpen ? candidates.filter((c) => !resources.some((r) => r.type === c.type && r.id === c.id && r.region === c.region)) : []
  const label = modelLabel(config, models)
  const choices = ([
    { text: '/新对话', label: '新对话' },
    { text: '/只读', label: '切换为只读' },
    { text: '/清空', label: '清空本账号全部对话' }
  ] as const).filter((c) => value !== closedCommand && value.startsWith('/') && c.text.startsWith(value.trim()))
  const choose = (text: string): void => {
    const command = localCommand(text)
    if (command) onCommand?.(command)
  }
  const chooseResource = (candidate: ResourceCandidate): void => {
    if (!token) return
    onChange(insertResource(value, token))
    onSelectResource?.(candidate)
    onResourceQuery?.(null)
    setClosedResource(null)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(token.start, token.start)
    })
  }
  const monthLine = month && hasUsage(month.totals) ? formatMonth(month) : null
  // A click on any button inside closes the popover it is in.
  const closeOnPick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if ((e.target as Element).closest('button')) e.currentTarget.hidePopover()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (resourceOpen && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      if (shownCandidates.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        setResourceIndex((n) => menuSelection(n, e.key as 'ArrowUp' | 'ArrowDown', shownCandidates.length))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setClosedResource(value)
        onResourceQuery?.(null)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && shownCandidates.length) {
        e.preventDefault()
        chooseResource(shownCandidates[Math.min(resourceIndex, shownCandidates.length - 1)])
        return
      }
    }
    if (choices.length && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCommandIndex((n) => menuSelection(n, e.key as 'ArrowUp' | 'ArrowDown', choices.length))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setClosedCommand(value)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && commandIndex >= 0) {
        e.preventDefault()
        choose(choices[Math.min(commandIndex, choices.length - 1)].text)
        return
      }
    }
    const action = composerKey({ ...e, isComposing: e.nativeEvent.isComposing }, busy)
    if (action === 'send') {
      e.preventDefault()
      onSend()
    } else if (action === 'stop' || action === 'close') {
      e.preventDefault()
      if (action === 'stop') onStop()
      else onClose()
    } else if (action) {
      const el = e.currentTarget
      const next = recall(history, value, el.selectionStart === 0 && el.selectionEnd === 0, at.current, action === 'history-up' ? 'up' : 'down')
      if (!next) return
      e.preventDefault()
      at.current = next.at
      onChange(next.value)
    }
  }

  return (
    <div className="ai-composer">
      {resourceOpen && <div id={resourceListId} className="ai-command-menu ai-resource-menu" role="listbox" aria-label="资源上下文候选">
        {shownCandidates.map((c, i) => <button id={`${resourceListId}-${i}`} key={`${c.type}/${c.region}/${c.id}`} type="button" role="option" aria-selected={i === resourceIndex} onMouseDown={(e) => e.preventDefault()} onClick={() => chooseResource(c)}>{c.label} <span className="ai-dim">{c.type} · {c.id} · {c.region}</span></button>)}
        {!shownCandidates.length && <div className="ai-dim small">没有匹配的资源</div>}
      </div>}
      {choices.length > 0 && (
        <div id={commandListId} className="ai-command-menu" role="listbox" aria-label="本地命令">
          {choices.map((c, i) => <button id={`${commandListId}-${i}`} key={c.text} type="button" role="option" aria-selected={i === commandIndex} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(c.text)}>{c.text} <span className="ai-dim">{c.label}</span></button>)}
        </div>
      )}
      {(chip || resources.length > 0) && <div className="ai-composer-chips">{chip}{resources.map((r) => <span key={`${r.type}/${r.region}/${r.id}`} className="ai-chip">{r.label}<button type="button" className="ai-chip-x" aria-label={`移除资源 ${r.label}`} onClick={() => onRemoveResource?.(r)}>×</button></span>)}</div>}
      <textarea
        ref={inputRef}
        value={value}
        rows={1}
        maxLength={MAX_PROMPT_CHARS}
        aria-label="给 AI 助手的消息"
        aria-controls={resourceOpen ? resourceListId : choices.length ? commandListId : undefined}
        aria-activedescendant={resourceOpen && shownCandidates.length ? `${resourceListId}-${Math.min(resourceIndex, shownCandidates.length - 1)}` : choices.length && commandIndex >= 0 ? `${commandListId}-${Math.min(commandIndex, choices.length - 1)}` : undefined}
        placeholder="问点什么…（↵ 发送，⇧↵ 换行，↑ 上一条）"
        onChange={(e) => { setClosedCommand(null); setCommandIndex(-1); setClosedResource(null); setResourceIndex(0); setCaret(e.target.selectionStart); onChange(e.target.value); onResourceQuery?.(resourceToken(e.target.value, e.target.selectionStart)?.query ?? null) }}
        onSelect={(e) => { setCaret(e.currentTarget.selectionStart); onResourceQuery?.(resourceToken(value, e.currentTarget.selectionStart)?.query ?? null) }}
        onKeyDown={onKeyDown}
      />
      <div className="ai-composer-tools">
        {onResourceQuery && <button type="button" className="ai-mention" aria-label="添加资源上下文" title="引用本账号最近的资源" disabled={resources.length >= 5} onClick={() => { const next = `${value}${value && !/\s$/.test(value) ? ' ' : ''}@`; onChange(next); onResourceQuery(''); requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(next.length, next.length) }) }}>@</button>}
        {models.length > 1 ? (
          <>
            <button type="button" className="ai-model-chip" popoverTarget={modelPop} title={`模型：${label}（切换对所有对话生效）`}>
              <span className="ai-model-name">{label}</span>
              <IconChevronDown />
            </button>
            <div id={modelPop} popover="auto" className="ai-pop ai-model-pop" role="group" aria-label="切换模型" onClick={closeOnPick}>
              <div className="ai-pop-h">切换模型 · 对所有账号和对话生效</div>
              <div className="ai-pop-list">
                {models.map((m) => (
                  <button key={m.id} type="button" className={`ai-pop-i${m.id === config.model ? ' sel' : ''}`} aria-pressed={m.id === config.model} onClick={() => m.id !== config.model && onModel(m.id)}>
                    <span className="ai-pop-main">
                      <span className="ai-pop-l1">{m.name}</span>
                      <span className="ai-pop-l2">{m.cost.input || m.cost.output ? `目录价 ${price(m.cost.input)} / ${price(m.cost.output)} 每百万 token` : '目录里没有价格'}</span>
                    </span>
                    {m.id === config.model && <IconCheck />}
                  </button>
                ))}
              </div>
              <div className="ai-pop-ft">
                <span>{hasUsage(usage) ? `本对话 ${formatUsage(usage)}` : '本对话还没有用量'}</span>
                {monthLine && <span>{monthLine}</span>}
                <span className="ai-spacer" />
                <button type="button" className="link-btn" onClick={onOpenSettings}>
                  AI 设置…
                </button>
              </div>
            </div>
          </>
        ) : (
          // Nothing to switch to here (a custom endpoint, or one model): the provider and model are set in AI settings.
          <button type="button" className="ai-model-chip" title={`模型：${label}。点击打开 AI 设置`} onClick={onOpenSettings}>
            <span className="ai-model-name">{label}</span>
          </button>
        )}
        <span className="ai-spacer" />
        {(hasUsage(usage) || monthLine) && (
          <>
            <button type="button" className="ai-cost-chip always-visible" popoverTarget={costPop} title="本对话的估算费用，点击查看用量" aria-label="查看用量">
              {hasUsage(usage) ? (formatCost(usage) ?? '用量') : '$0'}
            </button>
            <div id={costPop} popover="auto" className="ai-pop ai-cost-pop" role="group" aria-label="用量">
              <div className="ai-pop-h">按模型目录价估算，仅供参考</div>
              <div className="ai-pop-row">{hasUsage(usage) ? `本对话 ${formatUsage(usage)}` : '本对话还没有用量'}</div>
              {monthLine && <div className="ai-pop-row">{monthLine}</div>}
            </div>
          </>
        )}
        {busy ? (
          <button type="button" className={`ai-send stop${pausedOnApproval ? ' paused' : ''}`} aria-label={pausedOnApproval ? '停止回答（不会批准或拒绝审批）' : '停止生成'} title={pausedOnApproval ? '停止回答（不会批准或拒绝审批）' : '停止生成（esc）'} onClick={onStop}>
            <IconStop />
            {pausedOnApproval && <span>停止回答</span>}
          </button>
        ) : (
          <button type="button" className="ai-send" aria-label="发送" title="发送（↵）" disabled={!value.trim()} onClick={onSend}>
            <IconArrowUp />
          </button>
        )}
      </div>
    </div>
  )
}
