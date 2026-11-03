import { useState } from 'react'
import type { ChatItem } from '../../../../shared/ai'
import { IconCheck, IconChevronDown, IconClose, IconForward, IconPause } from '../icons'

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>
export type NonToolItem = Exclude<ChatItem, ToolItem>

/** Items with each run of consecutive tool calls folded into one array. An approval card breaks the run: it stands alone. */
export function groupTools(items: ChatItem[]): (NonToolItem | ToolItem[])[] {
  const out: (NonToolItem | ToolItem[])[] = []
  for (const it of items) {
    const last = out[out.length - 1]
    if (it.kind !== 'tool') out.push(it)
    else if (Array.isArray(last)) last.push(it)
    else out.push([it])
  }
  return out
}

const STATUS_TEXT: Record<ToolItem['status'], string> = { running: '进行中', waiting: '等待审批', ok: '成功', error: '失败' }
const duration = (ms: number): string => `${(ms / 1000).toFixed(1)} 秒`

function StatusIcon({ status }: { status: ToolItem['status'] }): React.JSX.Element {
  return (
    <span className={`ai-act-icon ${status}`} role="img" aria-label={STATUS_TEXT[status]}>
      {status === 'running' ? <span className="spinner" /> : status === 'waiting' ? <IconPause /> : status === 'ok' ? <IconCheck /> : <IconClose />}
    </span>
  )
}

/**
 * One line per run of tool calls: 「✓ N 步 · 名称…」. What must not hide behind the fold is on that line: a failed
 * step, the step waiting for approval (and the group opens by itself while it waits), the step running now.
 */
export function ActivityGroup({ tools }: { tools: ToolItem[] }): React.JSX.Element | null {
  const [open, setOpen] = useState<boolean | null>(null)
  if (tools.length === 0) return null
  const waiting = tools.findIndex((t) => t.status === 'waiting')
  const running = tools.findIndex((t) => t.status === 'running')
  const failed = tools.filter((t) => t.status === 'error').length
  const expanded = open ?? (waiting >= 0 || running >= 0)
  const status: ToolItem['status'] = waiting >= 0 ? 'waiting' : running >= 0 ? 'running' : failed === tools.length ? 'error' : 'ok'
  const names = [...new Set(tools.map((t) => t.label))].join('、')
  const total = tools.every((t) => t.ms !== undefined && t.status !== 'running' && t.status !== 'waiting')
    ? duration(tools.reduce((sum, t) => sum + (t.ms ?? 0), 0))
    : null

  return (
    <div className="ai-act">
      <button type="button" className="ai-act-row" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <StatusIcon status={status} />
        <span className="ai-act-text">
          {running >= 0 && waiting < 0 ? (
            <>
              正在{tools[running].label}… · 第 {running + 1} 步
            </>
          ) : (
            <>
              <b>{tools.length} 步</b>
              {waiting >= 0 && <span className="ai-act-wait"> · 等待你审批第 {waiting + 1} 步</span>}
            </>
          )}
          {failed > 0 && <span className="ai-act-fail"> · {failed} 步失败</span>}
          {waiting < 0 && running < 0 && <> · {names}</>}
        </span>
        {total && <span className="ai-act-duration">{total}</span>}
        <span className="ai-act-caret" aria-hidden>
          {expanded ? <IconChevronDown /> : <IconForward />}
        </span>
      </button>
      {expanded && (
        <ol className="ai-steps">
          {tools.map((t) => (
            <Step key={t.id} item={t} />
          ))}
        </ol>
      )}
    </div>
  )
}

/** A step: status, label, summary. run_script also opens to the calls it made and its code, read-only (plain text, as the model wrote it). */
export function Step({ item }: { item: ToolItem }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const label = item.status === 'running' ? `正在${item.label}…` : item.label
  const more = item.code !== undefined || (item.calls?.length ?? 0) > 0
  const text = (
    <>
      <StatusIcon status={item.status} />
      <span className="ai-step-text">
        {label}
        {item.summary && <span className="ai-step-summary"> · {item.summary}</span>}
        {item.status === 'waiting' && <span className="ai-step-summary"> · 等待你在下面的<span className="ai-keep-word">卡片</span>上审批</span>}
      </span>
      {item.ms !== undefined && <span className="ai-act-duration">{duration(item.ms)}</span>}
    </>
  )
  return (
    <li className={`ai-step ${item.status}`}>
      {more ? (
        <button type="button" className="ai-step-row" aria-expanded={open} onClick={() => setOpen(!open)}>
          {text}
          <span className="ai-act-caret" aria-hidden>
            {open ? <IconChevronDown /> : <IconForward />}
          </span>
        </button>
      ) : (
        <div className="ai-step-row">{text}</div>
      )}
      {more && open && <StepDetail item={item} />}
    </li>
  )
}

export function StepDetail({ item }: { item: ToolItem }): React.JSX.Element {
  return (
    <div className="ai-step-detail">
      {item.calls && item.calls.length > 0 && (
        <div className="ai-calls" role="group" aria-label="调用">
          {item.calls.map((c) => (
            <code key={c} className="ai-call">
              {c}
            </code>
          ))}
        </div>
      )}
      {item.code !== undefined && (
        <pre className="ai-tool-code" tabIndex={0} aria-label="脚本代码（只读）">
          {item.code}
        </pre>
      )}
    </div>
  )
}
