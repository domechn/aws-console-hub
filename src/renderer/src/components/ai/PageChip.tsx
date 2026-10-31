import type { PageContext } from '../../../../shared/ai'

/** What the assistant will get as the current page this turn, with the conversation's off switch. */
export function PageChip({ page, on, readPage, onToggle }: { page: PageContext | null | undefined; on: boolean; readPage: boolean; onToggle: (on: boolean) => void }): React.JSX.Element | null {
  if (page === undefined) return null
  if (!on) {
    return (
      <div className="ai-page-chip off" title="本对话不把当前页面发送给模型，助手也不能读取页面内容">
        <span className="ai-page-label">本对话不发送当前页面</span>
        <button type="button" className="link-btn" onClick={() => onToggle(true)}>
          开启
        </button>
      </div>
    )
  }
  const read = readPage
    ? '助手还可以调用「读取当前页面」读取页面上的可见文字（不含输入框、密码框和隐藏内容，已脱敏，最多约 8KB），聊天里会显示这一步。'
    : '读取页面内容已在 AI 设置里关闭。'
  const tip = page
    ? `每次提问时发送给模型：\n地址（已去除令牌）${page.url}\n标题 ${page.title || '（无）'}\nregion ${page.region}\n${page.resource || page.route ? `识别为 ${page.label}` : '未识别出具体资源'}\n不发送页面内容。助手可以用工具查询这个页面相关的资源。${read}\n点 × 本对话不再发送。`
    : '当前标签页不是 AWS Console 页面，不会发送页面信息。'
  return (
    <div className={`ai-page-chip${page?.resource ? '' : ' dim'}`} title={tip}>
      <span className="ai-page-label">{page ? `当前页面：${page.label}` : '当前页面不是 AWS Console'}</span>
      <button type="button" className="ai-page-off" aria-label="本对话不发送当前页面" title="本对话不发送当前页面" onClick={() => onToggle(false)}>
        ×
      </button>
    </div>
  )
}
