import { useEffect, useRef, useState } from 'react'
import type { CardActionResult, ProposalState, ProposalView } from '../../../../shared/ai'
import { formatCountdown, ipcError } from '../../ai'
import { CardView } from './CardView'

/**
 * A change proposal (plan §9.2). Everything on it came from main's rules; the buttons send only the proposal id and
 * what the user typed, and main re-checks all of it. Two steps: 「确认执行」 opens the final step, whose
 * 「我确认，立即执行」 arms after a second (and, for high / destructive / production, once the resource id is typed).
 */

const STATE_NOTE: Record<Exclude<ProposalState, 'pending'>, string> = {
  executing: '正在执行…',
  succeeded: '已执行',
  failed: '执行失败',
  cancelled: '已取消',
  expired: '已过期，请让助手重新生成',
  superseded: '已作废（资源状态变了），请让助手重新生成'
}
const RISK: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险', destructive: '破坏性' }
const ARM_MS = 1000

interface Props {
  proposal: ProposalView
  accountColor?: string
  onConfirm: (typed?: string) => Promise<CardActionResult>
  onCancel: () => Promise<CardActionResult>
  onLink: (url: string) => void
}

export function ProposalCard({ proposal: p, accountColor, onConfirm, onCancel, onLink }: Props): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [step, setStep] = useState<'review' | 'final'>('review')
  const [armed, setArmed] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const typedRef = useRef<HTMLInputElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)

  const expired = p.state === 'pending' && now >= p.expiresAt
  const state: ProposalState = expired ? 'expired' : p.state
  const live = state === 'pending'

  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])

  // The final button arms a second after the step opens: a double click on 「确认执行」 can't run the change.
  // Focus goes to the input or to 「返回」, never to the execute button: a held Enter must not confirm.
  useEffect(() => {
    if (step !== 'final') return
    setArmed(false)
    const t = setTimeout(() => setArmed(true), ARM_MS)
    ;(p.confirmText ? typedRef : backRef).current?.focus()
    return () => clearTimeout(t)
  }, [step, p.confirmText])

  const typedOk = !p.confirmText || typed.trim() === p.confirmText
  // Main refuses a confirm while the impact analysis runs too; it always ends (done, failed or timed out).
  const analyzing = p.analysis?.status === 'running'
  const raised = p.card.blocks.flatMap((b) => (b.type === 'analysis' && b.raised ? [b.raised] : []))[0]
  const run = (fn: () => Promise<CardActionResult>): void => {
    setBusy(true)
    setError(null)
    fn()
      .then((r) => !r.ok && setError(r.error), (err) => setError(ipcError(err)))
      .finally(() => setBusy(false))
  }
  const confirm = (): void => {
    if (live && armed && typedOk && !busy && !analyzing) run(() => onConfirm(p.confirmText ? typed.trim() : undefined))
  }

  const danger = p.risk === 'high' || p.risk === 'destructive'
  // The card's own state stays active: this component says what state the proposal is in.
  const card = { ...p.card, state: 'active' as const, expiresAt: Number.MAX_SAFE_INTEGER }

  return (
    <div
      className={`ai-proposal ${state} risk-${p.risk}${p.tier === 'C' ? ' strong' : ''}`}
      id={`proposal-${p.id}`}
      role="group"
      tabIndex={-1}
      aria-label={`${p.tier === 'C' ? '强确认' : '变更提案'}：${p.title}`}
    >
      <div className="ai-proposal-chips">
        <span className={`ai-tone ${danger ? 'danger' : p.risk === 'medium' ? 'warn' : 'ok'}`} title={raised ? `AI 影响分析把风险从「${RISK[raised.from]}」提高到了「${RISK[raised.to]}」，原因见卡片` : undefined}>
          {RISK[p.risk]}
          {raised && ' ↑'}
        </span>
        <span className="ai-chip">会修改资源</span>
        {p.generic && <span className="ai-chip">通用请求</span>}
        <span className="ai-chip" title={`账号 ${p.awsAccountId}`}>
          <span className="dot" style={{ background: accountColor }} />
          {p.accountName} · {p.awsAccountId}
        </span>
        <span className="ai-chip">{p.region}</span>
        {p.production && <span className="ai-chip prod">生产</span>}
        <span className="ai-spacer" />
        {live ? (
          <span className="ai-countdown" title="提案 10 分钟内有效" aria-label={`剩余 ${formatCountdown(p.expiresAt - now)}`}>
            ⏱ {formatCountdown(p.expiresAt - now)}
          </span>
        ) : (
          <span className={`ai-proposal-state ${state}`}>{STATE_NOTE[state as Exclude<ProposalState, 'pending'>]}</span>
        )}
      </div>

      {/* Only what the app knows: the categories by name, no predicted effects (those come from the AI analysis, labelled). */}
      {p.tier === 'C' && (
        <div className="ai-strong-banner" role="alert">
          <strong>⚠ 强确认 · 此类操作需要仔细核对</strong>
          <ul aria-label="操作类别">
            {(p.dangers ?? []).map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
          <span>没有专用适配器，应用无法预知影响。{p.analysis ? '请结合下面的 AI 分析（可能有误）' : '请'}逐项核对将发送的参数。</span>
        </div>
      )}
      {p.generic && p.tier !== 'C' && (
        <div className="ai-generic-note" role="note">
          通用请求：没有专用适配器，应用无法预知影响。下面是将原样发送的请求，没有变更前快照，也不做漂移检查。
        </div>
      )}

      <CardView card={card} accountColor={accountColor} onLink={onLink} onAction={async () => ({ ok: false, error: '' })} />

      {p.outcome && !live && <div className="ai-proposal-outcome">{p.outcome}</div>}

      {state === 'executing' && (
        <div className="ai-progress" role="status">
          <span>正在执行，完成前请不要关闭应用…</span>
          <span className="spinner" aria-hidden />
        </div>
      )}

      {live && step === 'review' && (
        <div className="ai-proposal-actions">
          <button
            type="button"
            className={`ai-card-btn ${danger ? 'danger' : 'primary'}`}
            disabled={busy || analyzing}
            title={analyzing ? '影响分析完成后才能确认' : undefined}
            onClick={() => setStep('final')}
          >
            确认执行…
          </button>
          <button type="button" className="ai-card-btn" disabled={busy} onClick={() => run(onCancel)}>
            取消
          </button>
        </div>
      )}

      {live && step === 'final' && (
        <div className="ai-proposal-final" role="group" aria-label="最终确认">
          <p>
            将在「{p.accountName}」（{p.awsAccountId}）· {p.region} 执行：<strong>{p.title}</strong>。
            {p.tier === 'C'
              ? '这是需要强确认的操作，请确认你核对过参数。'
              : p.generic
                ? '这是通用请求，应用无法预知影响，请确认你核对过参数。'
                : p.risk === 'destructive'
                ? '这是破坏性操作，执行后无法撤销。'
                : danger
                  ? '这是高风险操作，请再看一遍上面的影响。'
                  : ''}
            {p.tier === 'C' && p.production && ' 这是生产账号：需要连同账号 id 一起输入。'}
          </p>
          {p.confirmText && (
            <label className="ai-field">
              <span>
                请输入 <code className="ai-confirm-text">{p.confirmText}</code> 以确认
              </span>
              <input
                ref={typedRef}
                value={typed}
                maxLength={300}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={typed !== '' && !typedOk}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    confirm()
                  }
                }}
              />
            </label>
          )}
          <div className="ai-proposal-actions">
            <button type="button" className={`ai-card-btn ${danger ? 'danger' : 'primary'}`} disabled={!armed || !typedOk || busy || analyzing} onClick={confirm}>
              {busy ? '正在执行…' : '我确认，立即执行'}
            </button>
            <button ref={backRef} type="button" className="ai-card-btn" disabled={busy} onClick={() => setStep('review')}>
              返回
            </button>
            <button type="button" className="ai-card-btn" disabled={busy} onClick={() => run(onCancel)}>
              取消提案
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="ai-notice" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
