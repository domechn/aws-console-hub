import { useEffect, useState } from 'react'
import { RISK_LABEL, RISK_LEVELS, type AuditFilter, type AuditView, type Risk } from '../../../../shared/ai'
import type { AwsAccount } from '../../../../shared/types'
import { ipcError } from '../../ai'

interface Props {
  accounts: AwsAccount[]
  onBack: () => void
}

export const AUDIT_TYPE_LABEL: Record<string, string> = {
  proposal_created: '提出',
  proposal_confirmed: '确认',
  proposal_executed: '已执行',
  proposal_failed: '执行失败',
  proposal_drift: '漂移未执行',
  proposal_cancelled: '取消',
  proposal_expired: '过期',
  proposal_tampered: '校验失败',
  proposal_analysis: 'AI 影响分析',
  confirm_rejected: '确认被拒',
  proposal_refused: '提案被拒',
  forbidden_attempt: '禁止的尝试',
  approval_requested: '请求审批',
  approval_allowed: '审批允许',
  approval_denied: '审批拒绝',
  approval_expired: '审批超时',
  approval_aborted: '审批中止',
  approval_auto: '已允许（本对话）',
  approval_auto_denied: '自动拒绝（刚拒绝过）',
  approval_rate_limited: '审批限流',
  approval_revoked: '撤销允许',
  approval_tampered: '审批校验失败',
  tool_call: '工具调用',
  tool_refused: '工具被拒',
  model_request_stalled: '模型请求停滞',
  model_request_retried: '模型请求重试',
  ai_data_deleted: '删除 AI 数据'
}

const DAYS = [7, 30, 90, 180, 365]
const ai = window.api.ai

/** The audit log, read-only: main sends summaries (no params, results or keys); this only filters and copies them. */
export function AiAudit({ accounts, onBack }: Props): React.JSX.Element {
  const [filter, setFilter] = useState<AuditFilter>({ days: 30, scope: 'changes' })
  const [rows, setRows] = useState<AuditView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const names = new Map(accounts.map((a) => [a.id, `${a.name}（${a.accountId}）`]))

  useEffect(() => {
    let current = true
    setRows(null)
    setError(null)
    ai.auditList(filter).then(
      (r) => current && setRows(r),
      (err) => current && setError(ipcError(err))
    )
    return () => {
      current = false
    }
  }, [filter])

  const set = (patch: Partial<AuditFilter>): void => setFilter((f) => ({ ...f, ...patch }))
  const copy = (): void => {
    void navigator.clipboard.writeText(JSON.stringify(rows ?? [], null, 2)).then(
      () => (setCopied(true), setTimeout(() => setCopied(false), 1500)),
      () => setError('复制失败')
    )
  }

  return (
    <>
      <h2>AI 审计</h2>
      <div className="ai-audit-filters">
        <label>
          账号
          <select value={filter.accountId ?? ''} onChange={(e) => set({ accountId: e.target.value || undefined })}>
            <option value="">全部账号</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          时间
          <select value={filter.days} onChange={(e) => set({ days: Number(e.target.value) })}>
            {DAYS.map((d) => (
              <option key={d} value={d}>
                过去 {d} 天
              </option>
            ))}
          </select>
        </label>
        <label>
          风险
          <select value={filter.risk ?? ''} onChange={(e) => set({ risk: (e.target.value || undefined) as Risk | undefined })}>
            <option value="">全部</option>
            {RISK_LEVELS.map((r) => (
              <option key={r} value={r}>
                {RISK_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label>
          范围
          <select value={filter.scope} onChange={(e) => set({ scope: e.target.value as 'changes' | 'all' })}>
            <option value="changes">变更与策略</option>
            <option value="all">全部（含工具调用）</option>
          </select>
        </label>
      </div>

      <div className="ai-audit-list" role="region" aria-label="审计记录" aria-busy={rows === null} tabIndex={0}>
        {rows === null ? (
          <div className="modal-hint">正在读取…</div>
        ) : rows.length === 0 ? (
          <div className="modal-hint">这段时间没有记录。</div>
        ) : (
          <table className="ai-table ai-audit-table">
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">事件</th>
                <th scope="col">操作 / 目标</th>
                <th scope="col">详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.type}>
                  <td className="mono" title={new Date(r.t).toISOString()}>
                    {new Date(r.t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td>
                    <div>{AUDIT_TYPE_LABEL[r.type] ?? r.type}</div>
                    {r.risk && <span className={`ai-tone ${r.risk === 'high' || r.risk === 'destructive' ? 'danger' : r.risk === 'medium' ? 'warn' : 'ok'}`}>{RISK_LABEL[r.risk]}</span>}
                  </td>
                  <td>
                    {(r.service || r.action) && <code>{`${r.service ?? '?'}:${r.action ?? '?'}`}</code>}
                    {r.targets?.length ? <div className="ai-dim small">{r.targets.slice(0, 3).join(', ')}{r.targets.length > 3 ? ' …' : ''}</div> : null}
                    <div className="ai-dim small">{r.accountId ? (names.get(r.accountId) ?? r.accountId) : ''}</div>
                  </td>
                  <td>
                    {r.detail}
                    {r.requestId && <div className="ai-dim small mono">{r.requestId}</div>}
                    {r.proposalId && <div className="ai-dim small mono">{r.proposalId}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {error && (
        <div className="federate-preview test-steps" role="alert">
          <div className="test-step fail">{error}</div>
        </div>
      )}
      <div className="modal-actions">
        <span className="modal-hint">{rows ? `${rows.length} 条（最多显示 500 条，最新的在前）` : ''}</span>
        <button type="button" disabled={!rows?.length} onClick={copy}>
          {copied ? '已复制' : '复制为 JSON'}
        </button>
        <button type="button" className="primary" onClick={onBack}>
          返回设置
        </button>
      </div>
    </>
  )
}
