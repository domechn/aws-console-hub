import { useState } from 'react'
import type { ChatItem } from '../../../../shared/ai'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/** One line, cut with an ellipsis; click (or ↵) for the full label and summary. */
export function ToolRow({ item }: { item: ToolItem }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Its approval card follows right below and says everything: one quiet line, nothing to expand.
  if (item.status === 'waiting') {
    return (
      <div className="ai-tool waiting quiet" role="status" title={item.label}>
        <span aria-hidden>⏸</span> 等待审批
      </div>
    )
  }
  const icon = item.status === 'running' ? <span className="spinner" /> : item.status === 'ok' ? '✓' : '✗'
  const label = item.status === 'running' ? `正在${item.label}…` : item.label
  return (
    <div className={`ai-tool ${item.status}`}>
      <button type="button" className="ai-tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ai-tool-icon" aria-label={item.status === 'ok' ? '成功' : item.status === 'error' ? '失败' : '进行中'}>
          {icon}
        </span>
        <span className="ai-tool-text">
          {label}
          {item.summary && <span className="ai-tool-summary"> · {item.summary}</span>}
        </span>
        <span className="ai-tool-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && <ToolDetail item={item} label={label} />}
    </div>
  )
}

/** The expanded row. run_script: the calls it made and its code, read-only (plain text, as the model wrote it). */
export function ToolDetail({ item, label }: { item: ToolItem; label: string }): React.JSX.Element {
  return (
    <div className="ai-tool-detail">
      {label}
      {item.summary && `\n${item.summary}`}
      {item.calls && item.calls.length > 0 && `\n调用：${item.calls.join('、')}`}
      {item.code !== undefined && (
        <pre className="ai-tool-code" aria-label="脚本代码（只读）">
          {item.code}
        </pre>
      )}
    </div>
  )
}
