import type { AwsAccount, NavState } from '../../../shared/types'
import { IconBack, IconChevronDown, IconClose, IconForward, IconHistory, IconKey, IconReload } from './icons'

interface Props {
  account: AwsAccount | null
  navState: NavState | undefined
  /** A login for the account is in flight (before any tab has started loading). */
  federating: boolean
  /** Logging in or the active tab loading: drives the progress bar. */
  busy: boolean
  onRelogin: (account: AwsAccount) => void
  onOpenSwitcher: () => void
  /** Label of the switcher shortcut, e.g. "⌘⇧A". */
  switcherShortcut: string
  recentsOpen: boolean
  onToggleRecents: () => void
  /** Label of the recents shortcut, e.g. "⌘J". */
  recentsShortcut: string
  aiOpen: boolean
  onToggleAi: () => void
  /** Label of the assistant shortcut, e.g. "⌘I". */
  aiShortcut: string
}

/**
 * Window header: account switcher, console navigation, the active account's tabs and actions.
 * Doubles as the window drag region, so every control opts back out of it.
 */
export function TopBar({
  account,
  navState,
  federating,
  busy,
  onRelogin,
  onOpenSwitcher,
  switcherShortcut,
  recentsOpen,
  onToggleRecents,
  recentsShortcut,
  aiOpen,
  onToggleAi,
  aiShortcut
}: Props): React.JSX.Element {
  return (
    <header className="topbar">
      <button
        className={'account-switch' + (account ? '' : ' empty')}
        title={
          (account ? `${account.name}\n${account.accountId} · ${account.role} · ${account.defaultRegion}\n` : '') +
          `切换账号（${switcherShortcut}）`
        }
        onClick={onOpenSwitcher}
      >
        {account && <span className="dot" style={{ background: account.color }} />}
        <span className="switch-name">{account ? account.name : '选择账号'}</span>
        {busy && <span className="spinner" />}
        <IconChevronDown />
      </button>

      <span className="topbar-divider" />

      <div className="topbar-nav">
        <button
          className="topbar-btn"
          title="后退"
          disabled={!navState?.canGoBack}
          onClick={() => window.api.goBack()}
        >
          <IconBack />
        </button>
        <button
          className="topbar-btn"
          title="前进"
          disabled={!navState?.canGoForward}
          onClick={() => window.api.goForward()}
        >
          <IconForward />
        </button>
        <button
          className="topbar-btn"
          title="刷新"
          disabled={!account}
          onClick={() => window.api.reloadView()}
        >
          <IconReload />
        </button>
      </div>

      {/* The strip itself stays a drag handle; only the tabs opt out. */}
      <div className="tabstrip">
        {account &&
          navState?.tabs.map((tab) => (
            <div
              key={tab.id}
              className={'tab' + (tab.id === navState.activeTabId ? ' active' : '')}
              title={`${tab.title}\n${tab.url}`}
              onClick={() => window.api.activateTab(tab.id)}
              onAuxClick={(e) => e.button === 1 && window.api.closeTab(tab.id)}
            >
              {(tab.loading || (federating && tab.id === navState.activeTabId)) && (
                <span className="spinner" />
              )}
              <span className="tab-title">{tab.title || '新标签页'}</span>
              {navState.tabs.length > 1 && (
                <button
                  className="tab-close"
                  title="关闭标签页（⌘W）"
                  onClick={(e) => {
                    e.stopPropagation()
                    window.api.closeTab(tab.id)
                  }}
                >
                  <IconClose />
                </button>
              )}
            </div>
          ))}
      </div>

      <button
        className={'topbar-btn' + (recentsOpen ? ' on' : '')}
        title={`${recentsOpen ? '隐藏' : '显示'}最近访问（${recentsShortcut}）`}
        onClick={onToggleRecents}
      >
        <IconHistory />
      </button>

      <button
        className="topbar-btn"
        title="重新登录"
        disabled={!account}
        onClick={() => account && onRelogin(account)}
      >
        <IconKey />
      </button>

      <button
        className={'topbar-btn ai-btn' + (aiOpen ? ' on' : '')}
        title={`AI 助手（${aiShortcut}）`}
        aria-pressed={aiOpen}
        onClick={onToggleAi}
      >
        ✦ AI
      </button>

      {busy && <div className="progress" role="progressbar" aria-label="加载中" />}
    </header>
  )
}
