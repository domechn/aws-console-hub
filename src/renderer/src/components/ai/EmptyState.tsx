import type { ConversationSummary, PageContext } from '../../../../shared/ai'
import type { AwsAccount } from '../../../../shared/types'
import { IconArrowRight, IconForward, IconHistory, IconPage } from '../icons'
import { relativeTime } from '../ResourceList'

type Templates = (name: string) => string[]

/** Questions per resource the console URL names (main/parser.ts: service + resourceType). */
const BY_RESOURCE: Record<string, Templates> = {
  'ec2/Instance': (n) => [`${n} 过去 24 小时的 CPU 和网络怎么样？`, `${n} 的安全组开放了哪些端口？`, `${n} 挂了哪些 EBS 卷，最近有快照吗？`],
  's3/Bucket': (n) => [`${n} 有多大、有多少对象？`, `${n} 能被公开访问吗？桶策略允许了谁？`, `${n} 开了版本控制、加密和生命周期规则吗？`],
  'lambda/Function': (n) => [`${n} 最近一小时有报错吗？`, `${n} 最近的调用次数、平均耗时和限流情况怎么样？`, `${n} 的运行时、内存、超时和触发器是什么？`],
  'rds/Database': (n) => [`${n} 过去 24 小时的 CPU、连接数和剩余存储怎么样？`, `${n} 的自动备份和最近的快照是什么情况？`, `${n} 是 Multi-AZ 吗？引擎版本和实例类型是什么？`],
  'sqs/Queue': (n) => [`${n} 现在积压了多少消息？有死信队列吗？`, `${n} 的可见性超时和消息保留时间是多少？`, `${n} 最近一小时收发了多少消息？`]
}

/**
 * Suggested questions for the page the user has open (plan ai-ux-redesign §3.8): three per known resource type, a
 * generic three for any other resource or service page, none off the console or on its home page. Pure: only names
 * already on the page go in, nothing is asked of the model.
 */
export function pageSuggestions(page: PageContext | null | undefined): string[] {
  const r = page?.resource
  if (r) return BY_RESOURCE[`${r.service}/${r.resourceType}`]?.(r.name) ?? [`介绍一下 ${r.serviceLabel} ${r.name} 的配置`, `${r.name} 最近有报错或告警吗？`, `${r.name} 有哪些标签？`]
  const s = page?.route?.serviceLabel
  return s ? [`列出当前 region 的 ${s} 资源`, `${s} 最近有报错或告警吗？`, `${s} 里有哪些资源没有 owner 标签？`] : []
}

/** Always offered; the cost one says what it costs (Cost Explorer bills each request). */
const COMMON: { text: string; tag?: string }[] = [
  { text: '最近一小时哪些 Lambda 函数报错了？' },
  { text: '列出没有 owner 标签的 S3 存储桶' },
  { text: '本月成本前五的服务是哪些？', tag: '每次约 $0.01' }
]

interface Props {
  account: AwsAccount
  page: PageContext | null | undefined
  /** Other conversations of the account, newest first. */
  recent: ConversationSummary[]
  /** Fills the input with the question; never sends it. */
  onPick: (text: string) => void
  onOpen: (conversationId: string) => void
  onAllowWrite: () => void
}

/** A conversation with nothing in it yet (mock 02). */
export function EmptyState({ account, page, recent, onPick, onOpen, onAllowWrite }: Props): React.JSX.Element {
  const forPage = pageSuggestions(page)
  const item = (text: string, tag?: string): React.JSX.Element => (
    <button key={text} type="button" className="ai-sugg-i" onClick={() => onPick(text)}>
      <IconArrowRight />
      <span className="ai-sugg-t">{text}</span>
      {tag && <span className="ai-sugg-tag">{tag}</span>}
    </button>
  )
  return (
    <div className="ai-start">
      <div className="ai-start-who">
        <div className="ai-start-name">
          <span className="dot" style={{ background: account.color }} />
          {account.name}
        </div>
        <div className="ai-dim">{account.accountId} · 只在这个账号里查询</div>
      </div>
      {forPage.length > 0 && page && (
        <div className="ai-sugg" role="group" aria-label="基于当前页面的问题">
          <div className="ai-sugg-h">
            <IconPage />
            基于当前页面 · {page.label}
          </div>
          {forPage.map((t) => item(t))}
        </div>
      )}
      <div className="ai-sugg" role="group" aria-label="常用问题">
        <div className="ai-sugg-h">
          <IconHistory />
          常用
        </div>
        {COMMON.map((c) => item(c.text, c.tag))}
      </div>
      {recent.length > 0 && (
        <div className="ai-sugg" role="group" aria-label="最近的对话">
          <div className="ai-sugg-h">
            <IconHistory />
            最近的对话 · 这个账号
          </div>
          {recent.slice(0, 2).map((c) => (
            <button key={c.id} type="button" className="ai-sugg-i ai-sugg-conv" onClick={() => onOpen(c.id)}>
              <IconForward />
              <span className="ai-sugg-t">{c.title || '未命名对话'}</span>
              <span className="ai-sugg-tag">{relativeTime(c.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="ai-start-cap">
        {account.aiAllowWrite ? (
          <p>
            <b>可提议变更</b>：助手可以提出变更，每一项都要你在卡片上确认后才会执行。
          </p>
        ) : (
          <p>
            <b>只读</b>：助手只能查询，不会修改资源。不在默认放行范围内的查询会先问你。
            <br />
            <button type="button" className="link-btn ai-start-link" onClick={onAllowWrite}>
              允许提出变更…
            </button>
          </p>
        )}
      </div>
    </div>
  )
}
