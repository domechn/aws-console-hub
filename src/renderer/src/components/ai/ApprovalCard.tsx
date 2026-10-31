import { useEffect, useState } from 'react'
import type { ApprovalDecision, ApprovalState, ApprovalView, CardActionResult } from '../../../../shared/ai'
import { countdownTone, formatCountdown, ipcError } from '../../ai'

/**
 * A call paused for the user's approval (docs/plans/ai-approval.md). Everything on it came from main: the request
 * exactly as it will run (the hash binds it), why the app asks, and the model's reason, labelled as such. The
 * buttons send only the approval id and a decision; they arm a second after the card appears, so a click meant
 * for something that just moved under the pointer doesn't count.
 */

const STATE_NOTE: Record<Exclude<ApprovalState, 'pending'>, string> = {
  allowed: '已允许',
  denied: '已拒绝',
  expired: '已超时（视为拒绝）',
  aborted: '已停止'
}
const ARM_MS = 1000

/** The parts of a keydown that decide; a React.KeyboardEvent fits. */
interface Key {
  key: string
  repeat: boolean
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  target: unknown
  currentTarget: unknown
}

/**
 * A key on the approval card (plan ai-ux-redesign §3.4). esc denies from anywhere in the card. ↵ allows once and
 * ⌘↵ / Ctrl+↵ allows for the conversation (only if main offers it), and only when the card itself has the focus
 * (a button inside it handles its own ↵), the allow buttons have armed, and the key isn't held down.
 */
export function approvalKey(e: Key, armed: boolean, sessionAllowed: boolean): ApprovalDecision | null {
  if (e.key === 'Escape') return 'deny'
  if (e.key !== 'Enter' || e.repeat || !armed || e.target !== e.currentTarget || e.shiftKey || e.altKey) return null
  if (!e.metaKey && !e.ctrlKey) return 'once'
  return sessionAllowed ? 'session' : null
}

/** The countdown's clock: `tick` once a second until the returned stop is called. */
export function everySecond(tick: () => void): () => void {
  const t = setInterval(tick, 1000)
  return () => clearInterval(t)
}

interface Props {
  disabled?: boolean
  approval: ApprovalView
  accountColor?: string
  onDecide: (decision: ApprovalDecision) => Promise<CardActionResult>
}

export function ApprovalCard({ approval: a, disabled, accountColor, onDecide }: Props): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const state: ApprovalState = a.state === 'pending' && now >= a.expiresAt ? 'expired' : a.state
  const live = state === 'pending'

  useEffect(() => (live ? everySecond(() => setNow(Date.now())) : undefined), [live])

  useEffect(() => {
    const t = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(t)
  }, [])

  const decide = (d: ApprovalDecision): void => {
    if (!live || busy || disabled || (d !== 'deny' && !armed)) return
    setBusy(true)
    setError(null)
    onDecide(d)
      .then((r) => !r.ok && setError(r.error), (err) => setError(ipcError(err)))
      .finally(() => setBusy(false))
  }

  const copy = (text: string, what: string): void => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(what)
        setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500)
      },
      () => setError('复制失败')
    )
  }

  const decided = a.decision === 'session' ? '已允许（本对话内一直允许此动作）' : state !== 'pending' ? STATE_NOTE[state] : ''
  const left = a.expiresAt - now
  const tone = countdownTone(left)
  const noParams = /^\{\s*\}$/.test(a.params.trim())
  const key = `${a.service}:${a.action}`

  return (
    <div
      className={`ai-approval ${state}`}
      id={`approval-${a.id}`}
      role="group"
      // Tab reaches the card, but nothing moves the focus onto it by itself: a ↵ meant for the input must never land here.
      tabIndex={0}
      aria-label={`需要你的审批：${key}`}
      aria-describedby={live ? `approval-keys-${a.id}` : undefined}
      onKeyDown={(e) => {
        const d = live ? approvalKey(e, armed, a.sessionAllowed) : null
        if (!d) return
        e.preventDefault()
        e.stopPropagation()
        decide(d)
      }}
    >
      <div className="ai-approval-head">
        <span className="ai-shield" title="由应用生成" aria-label="由应用生成">
          🛡
        </span>
        <span className="ai-tone warn">需要你的审批</span>
        {live ? (
          <span className={`ai-countdown${tone ? ` ${tone}` : ''}`} title="5 分钟内不处理视为拒绝">
            将在 {formatCountdown(left)} 后自动拒绝
          </span>
        ) : (
          <span className={`ai-proposal-state ${state}`}>{decided}</span>
        )}
      </div>

      <div className="ai-approval-where">
        {/* Approvals only come from aws_read (main refuses writes there): always a read. */}
        <span className="ai-chip ai-approval-kind">只读操作</span>
        <code className="ai-chip ai-approval-action">{key}</code>
        <span className="ai-chip" title={`账号 ${a.awsAccountId}`}>
          <span className="dot" style={{ background: accountColor }} />
          {a.accountName} · {a.awsAccountId}
        </span>
        <span className="ai-chip" title="区域">
          <span aria-hidden>🌐</span>
          {a.region}
        </span>
      </div>

      {a.why.length > 0 && (
        <div className="ai-approval-row">
          <span className="ai-approval-label">为什么需要审批</span>
          <ul className="ai-approval-why">
            {a.why.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {a.reason && (
        <div className="ai-approval-row">
          <span className="ai-approval-label">助手的理由</span>
          <p className="ai-approval-reason">{a.reason}</p>
        </div>
      )}

      <div className="ai-approval-row">
        <span className="ai-approval-label">参数</span>
        {noParams ? (
          <span className="ai-approval-noparams">此调用不带参数</span>
        ) : (
          <>
            <pre className="ai-request-params" tabIndex={0} aria-label="将发送的参数">
              {a.params}
            </pre>
            <p className="ai-approval-exact">执行的就是上面这些参数，助手改不了。</p>
          </>
        )}
      </div>

      {live && (
        <>
          {/* A read approval: allow and deny weigh the same; red is kept for strong (write) confirmations. */}
          <div className="ai-proposal-actions ai-approval-actions">
            <button type="button" className="ai-card-btn" disabled={!armed || busy || disabled} onClick={() => decide('once')}>
              允许一次<kbd aria-hidden>↵</kbd>
            </button>
            <button type="button" className="ai-card-btn" disabled={busy || disabled} onClick={() => decide('deny')}>
              拒绝<kbd aria-hidden>Esc</kbd>
            </button>
          </div>
          {a.sessionAllowed && (
            <button
              type="button"
              className="ai-link-btn ai-approval-session"
              disabled={!armed || busy || disabled}
              title={`${key} · ${a.accountName} ${a.awsAccountId} · ${a.region}\n之后同一账号、同一区域的这个动作不再询问，参数可以不同。可在 AI 设置里撤销\n焦点在卡片上时也可按 ⌘↵ / Ctrl+↵`}
              onClick={() => decide('session')}
            >
              本对话始终允许此操作
            </button>
          )}
          {/* Shown only while the card itself has the focus: that is the only place these keys work. */}
          <p className="ai-approval-keys" id={`approval-keys-${a.id}`}>
            焦点在审批卡上：<kbd>↵</kbd> 允许一次 · <kbd>Esc</kbd> 拒绝{a.sessionAllowed ? ' · ⌘↵ / Ctrl+↵ 本对话始终允许' : ''} · <kbd>Tab</kbd> 逐项查看
          </p>
        </>
      )}

      <div className="ai-dim small ai-approval-ids">
        <span>
          请求 ID {a.id}
          <button type="button" className="ai-link-btn ai-copy" aria-label="复制请求 ID" onClick={() => copy(a.id, 'id')}>
            {copied === 'id' ? '已复制' : '复制'}
          </button>
        </span>
        <span title={a.hash}>
          参数校验 {a.hash.slice(0, 19)}…
          <button type="button" className="ai-link-btn ai-copy" aria-label="复制参数校验值" onClick={() => copy(a.hash, 'hash')}>
            {copied === 'hash' ? '已复制' : '复制'}
          </button>
        </span>
      </div>

      {error && (
        <div className="ai-notice" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
