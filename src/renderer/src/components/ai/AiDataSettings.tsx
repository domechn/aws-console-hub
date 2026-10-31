import { useEffect, useState } from 'react'
import { AUDIT_RETENTION_LIMITS, DELETE_AUDIT_PHRASE, type AiBudget, type AiConfig, type AiConfigView, type ConversationRetention, type MonthUsage, type SessionAllowView } from '../../../../shared/ai'
import { formatUsage, ipcError } from '../../ai'

interface Props {
  config: AiConfigView | null
  onConfig: (config: AiConfigView) => void
  onOpenAudit: () => void
  /** Every conversation is gone: the panel reloads. */
  onDataDeleted: () => void
}

const RETENTIONS: { value: string; label: string }[] = [
  { value: 'forever', label: '一直保留' },
  { value: '90', label: '90 天' },
  { value: '30', label: '30 天' },
  { value: '0', label: '不保留（重启或退出应用时删除）' }
]
const retentionValue = (r: ConversationRetention): string => (r === null ? 'forever' : String(r))
const retentionOf = (v: string): ConversationRetention => (v === 'forever' ? null : (Number(v) as 0 | 30 | 90))

const ai = window.api.ai

/**
 * Usage and budget, retention, the audit viewer, and deleting all AI data. Each field saves on its own (no provider
 * needed), so the data controls work before the assistant is set up.
 */
export function AiDataSettings({ config, onConfig, onOpenAudit, onDataDeleted }: Props): React.JSX.Element {
  const [month, setMonth] = useState<MonthUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [auditDays, setAuditDays] = useState('')
  const [tokens, setTokens] = useState('')
  const [usd, setUsd] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [withAudit, setWithAudit] = useState(false)
  const [typed, setTyped] = useState('')
  const [deleted, setDeleted] = useState<string | null>(null)

  const [allows, setAllows] = useState<SessionAllowView[]>([])
  const refreshAllows = async (): Promise<void> => setAllows(await ai.sessionAllows())

  useEffect(() => void ai.usage().then(setMonth), [config])
  useEffect(() => void refreshAllows(), [])
  useEffect(() => {
    if (!config) return
    setAuditDays(String(config.auditRetentionDays))
    setTokens(config.budget.monthlyTokens ? String(config.budget.monthlyTokens / 1e6) : '')
    setUsd(config.budget.monthlyUsd ? String(config.budget.monthlyUsd) : '')
  }, [config])

  const save = async (input: Partial<AiConfig>): Promise<void> => {
    setError(null)
    try {
      onConfig(await ai.saveConfig(input))
    } catch (err) {
      setError(ipcError(err))
    }
  }
  const budget = (patch: Partial<AiBudget>): Promise<void> => save({ budget: { ...(config?.budget ?? { monthlyTokens: null, monthlyUsd: null, block: false }), ...patch } })
  const positive = (v: string, scale = 1): number | null => (v.trim() && Number(v) > 0 ? Number(v) * scale : null)

  const deleteAll = async (): Promise<void> => {
    setError(null)
    try {
      await ai.deleteAllData(withAudit, withAudit ? typed.trim() : undefined)
      setDeleting(false)
      setTyped('')
      setDeleted(withAudit ? '已删除全部对话、用量记录和审计记录。' : '已删除全部对话和用量记录，审计记录保留。')
      onDataDeleted()
      setMonth(await ai.usage())
    } catch (err) {
      setError(ipcError(err))
    }
  }

  if (!config) return <></>
  return (
    <>
      <h3 className="modal-section">用量与预算</h3>
      <div className="modal-hint" aria-live="polite">
        本月（所有对话，含已删除的）：{month && (month.totals.input || month.totals.output) ? formatUsage(month.totals) : '还没有用量'}
        {month?.budget && <div className={`ai-budget-note${month.blocked ? ' blocked' : ''}`}>{month.budget}</div>}
      </div>
      <div className="modal-row">
        <label>
          月度 token 上限（百万，输入 + 输出）
          <input inputMode="decimal" value={tokens} placeholder="不限" onChange={(e) => setTokens(e.target.value)} onBlur={() => void budget({ monthlyTokens: positive(tokens, 1e6) })} />
        </label>
        <label>
          月度费用上限（美元，估算）
          <input inputMode="decimal" value={usd} placeholder="不限" onChange={(e) => setUsd(e.target.value)} onBlur={() => void budget({ monthlyUsd: positive(usd) })} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={config.budget.block} onChange={(e) => void budget({ block: e.target.checked })} />
        超出后暂停新的提问（不勾选时只提醒）
      </label>
      <div className="modal-hint">按模型目录价估算，「价格未知」的模型不计入费用上限；用到 80% 时开始提醒。</div>

      <h3 className="modal-section">本对话已允许的动作</h3>
      <div className="modal-hint">
        审批卡片上点过「本对话内一直允许此动作」的查询（按服务、操作和 region，不限参数）。只在内存里：删除对话或重启应用后失效。敏感读取和危险操作永远不能一直允许。
      </div>
      {allows.length === 0 ? (
        <div className="modal-hint">没有。</div>
      ) : (
        <ul className="ai-allow-list">
          {allows.map((a) => (
            <li key={`${a.conversationId}|${a.key}`}>
              <code>{a.key}</code>
              <span className="ai-dim small">「{a.conversationTitle || '未命名对话'}」</span>
              <button
                type="button"
                className="ai-text-btn"
                aria-label={`撤销 ${a.key}`}
                onClick={() => ai.revokeAllow(a.accountId, a.conversationId, a.key).then(refreshAllows, (err) => setError(ipcError(err)))}
              >
                撤销
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="modal-section">数据与隐私</h3>
      <div className="modal-row">
        <label>
          对话保留
          <select value={retentionValue(config.conversationRetention)} onChange={(e) => void save({ conversationRetention: retentionOf(e.target.value) })}>
            {RETENTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          审计记录保留（天）
          <input
            type="number"
            min={AUDIT_RETENTION_LIMITS.min}
            max={AUDIT_RETENTION_LIMITS.max}
            value={auditDays}
            onChange={(e) => setAuditDays(e.target.value)}
            onBlur={() => void save({ auditRetentionDays: Number(auditDays) })}
          />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={config.readPage} onChange={(e) => void save({ readPage: e.target.checked })} />
        允许助手读取当前页面内容
      </label>
      <div className="modal-hint">
        每次提问都会附上当前标签页的地址（去掉令牌类参数）、标题和识别出的资源，可在面板输入框上方的页面标签点 × 按对话关闭。勾选后，助手还能读取当前
        Console 页面上的可见文字（不含输入框、密码框和隐藏内容，脱敏后最多约 8KB，只发给模型、不保存原文）；不勾选则助手没有这个工具。
      </div>
      <label className="check">
        <input type="checkbox" checked={config.quickReplies} onChange={(e) => void save({ quickReplies: e.target.checked })} />
        回复后显示快捷回复
      </label>
      <div className="modal-hint">
        助手提问或给出选项时，在回复下面显示最多 4 个快捷回复，点一下等于输入并发送这段文字（不会自动发送）。快捷回复不能批准或确认任何操作，审批和变更只能在各自的卡片上点。
      </div>
      <label className="check">
        <input type="checkbox" checked={config.impactAnalysis} onChange={(e) => void save({ impactAnalysis: e.target.checked })} />
        写操作前自动做 AI 影响分析
      </label>
      <div className="modal-hint">
        没有专用适配器的写操作（通用请求、强确认），应用不知道它会改变什么。勾选后，确认前会用同一个模型做一次独立的只读分析（最多 8 次查询、90 秒，token 计入本月用量）：读取相关资源的当前状态，标出事实和依据、推断和不确定的地方；分析只会提高风险、不会降低，也不能批准任何操作。不勾选则卡片只显示请求本身。
      </div>
      <div className="modal-hint">
        对话和审计都只存在本机 ai.sqlite 里（写入前去掉凭证和 key）。超过保留期的在启动时和每天清理一次，未到期的不会删除。
      </div>
      <div className="modal-row-actions">
        <button type="button" onClick={onOpenAudit}>
          AI 审计…
        </button>
        <button type="button" className="danger" onClick={() => (setDeleting(!deleting), setDeleted(null))} aria-expanded={deleting}>
          删除全部 AI 数据…
        </button>
      </div>
      {deleting && (
        <div className="ai-delete-panel" role="group" aria-label="删除全部 AI 数据">
          <p>删除所有账号的全部 AI 对话和用量记录（不可恢复）。正在进行的回答会停止，待确认的提案作废。API key 和设置不受影响。</p>
          <label className="check">
            <input type="checkbox" checked={withAudit} onChange={(e) => setWithAudit(e.target.checked)} />
            同时删除审计记录（AI 提出和执行过的变更记录）
          </label>
          {withAudit && (
            <label>
              <span>
                请输入 <code>{DELETE_AUDIT_PHRASE}</code> 以确认
              </span>
              <input value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
            </label>
          )}
          <div className="modal-row-actions">
            <button type="button" className="danger" disabled={withAudit && typed.trim() !== DELETE_AUDIT_PHRASE} onClick={() => void deleteAll()}>
              删除
            </button>
            <button type="button" onClick={() => setDeleting(false)}>
              取消
            </button>
          </div>
        </div>
      )}
      {deleted && (
        <div className="modal-hint" role="status">
          {deleted}
        </div>
      )}
      {error && (
        <div className="federate-preview test-steps" role="alert">
          <div className="test-step fail">{error}</div>
        </div>
      )}
    </>
  )
}
