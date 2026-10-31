import type { QuickReply } from '../../../../shared/ai'

// Styling only: a chip that reads like a destructive answer is outlined amber so it isn't clicked by reflex.
const DESTRUCTIVE = /终止|删除|销毁|清空|terminate|delete/i

/** The chips under the last reply. `onSend` is the composer's send: a click is the same as typing the text and sending it. */
export function QuickReplies({ options, onSend }: { options: QuickReply[]; onSend: (text: string) => void }): React.JSX.Element {
  return (
    <div className="ai-replies" role="group" aria-label="快捷回复">
      {options.map((o) => (
        // Only on a click: nothing is ever sent by itself.
        <button key={o.label} type="button" className={`ai-reply-chip${DESTRUCTIVE.test(o.label + o.text) ? ' warn' : ''}`} title={o.text} onClick={() => onSend(o.text)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
