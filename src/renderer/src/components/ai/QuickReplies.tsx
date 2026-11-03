import type { QuickReply } from '../../../../shared/ai'
import { IconArrowRight, IconWarn } from '../icons'

// Styling only: a reply that reads like a change (stop, reboot, delete…) is amber with a warning icon, so it isn't clicked by reflex.
const DESTRUCTIVE = /终止|删除|销毁|清空|停止|重启|修改|撤销|terminate|delete|destroy|stop|reboot|restart|revoke/i

/** 「接下来」 under the last reply. `onSend` is the composer's send: a click is the same as typing the text and sending it. */
export function QuickReplies({ options, onSend, disabled = false }: { options: QuickReply[]; onSend: (text: string) => void; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="ai-replies" role="group" aria-label="快捷回复">
      <div className="ai-replies-h" aria-hidden="true">
        接下来
      </div>
      {options.map((o) => {
        const warn = DESTRUCTIVE.test(o.label + o.text)
        return (
          // Only on a click: nothing is ever sent by itself.
          <button key={o.label} type="button" className={`ai-reply${warn ? ' warn' : ''}`} title={disabled ? "附件正在准备，请稍候" : o.text} disabled={disabled} onClick={() => onSend(o.text)}>
            {warn ? <IconWarn /> : <IconArrowRight />}
            <span>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
