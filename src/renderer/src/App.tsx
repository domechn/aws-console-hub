import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountKind, AwsAccount, NavState, RecentResource } from '../../shared/types'
import type { SwitchSource } from '../../shared/api'
import { Palette } from './components/Palette'
import { AccountModal } from './components/AccountModal'
import { FindBar } from './components/FindBar'
import { AccountSwitcher } from './components/AccountSwitcher'
import { ResourceStrip } from './components/ResourceList'
import { TopBar } from './components/TopBar'
import { loadingView } from './loading'
import { AssistantPanel, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from './components/ai/AssistantPanel'
import { AiSettings } from './components/ai/AiSettings'
import type { AiConfigView } from '../../shared/ai'

const RECENTS_HIDDEN_KEY = 'recentsHidden'
const AI_WIDTH_KEY = 'aiPanelWidth'

const isMac = window.api.platform === 'darwin'
const MOD = isMac ? '⌘' : 'Ctrl+'
const SWITCHER_SHORTCUT = isMac ? '⌘⇧A' : 'Ctrl+Shift+A'
const modPressed = (e: KeyboardEvent): boolean => (isMac ? e.metaKey : e.ctrlKey)

/** Same rule as main/shortcuts.ts: non-Latin layouts and IMEs report the produced char, not "f". */
const shortcutKey = (e: KeyboardEvent): string => {
  const key = e.key.toLowerCase()
  if (/^[a-z0-9]$/.test(key)) return key
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code)
  return m ? (m[1] ?? m[2]).toLowerCase() : key
}

export function App(): React.JSX.Element {
  const [accounts, setAccounts] = useState<AwsAccount[]>([])
  const [recents, setRecents] = useState<RecentResource[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [editing, setEditing] = useState<{ kind: AccountKind; account: AwsAccount | null } | null>(
    null
  )
  const [navStates, setNavStates] = useState<Record<string, NavState>>({})
  // Accounts with a login in flight (main's federation:state).
  const [federating, setFederating] = useState<ReadonlySet<string>>(new Set())
  const [findOpen, setFindOpen] = useState(false)
  // Kept across close/reopen, like a browser's find bar.
  const [findQuery, setFindQuery] = useState('')
  const [findFocus, setFindFocus] = useState(0)
  const [recentsOpen, setRecentsOpen] = useState(() => localStorage.getItem(RECENTS_HIDDEN_KEY) !== '1')
  const slotRef = useRef<HTMLDivElement>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiFocus, setAiFocus] = useState(0)
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false)
  const [aiConfig, setAiConfig] = useState<AiConfigView | null>(null)
  const [aiDataVersion, setAiDataVersion] = useState(0)
  const [aiWidth, setAiWidth] = useState(() => {
    const saved = Number(localStorage.getItem(AI_WIDTH_KEY))
    return saved >= PANEL_MIN_WIDTH && saved <= PANEL_MAX_WIDTH ? saved : 400
  })

  const toggleRecents = useCallback(() => setRecentsOpen((open) => !open), [])
  const aiOpenRef = useRef(aiOpen)
  aiOpenRef.current = aiOpen
  // Opening puts the cursor in the panel's input; closing hands the keyboard back to the console.
  const toggleAssistant = useCallback(() => {
    if (aiOpenRef.current) window.api.focusConsole()
    else setAiFocus((n) => n + 1)
    setAiOpen((open) => !open)
  }, [])
  // The palette and the switcher are both full-window overlays: one at a time.
  const togglePalette = useCallback(() => {
    setSwitcherOpen(false)
    setPaletteOpen((open) => !open)
  }, [])
  const toggleSwitcher = useCallback(() => {
    setPaletteOpen(false)
    setSwitcherOpen((open) => !open)
  }, [])

  const activeAccount = accounts.find((a) => a.id === activeId) ?? null
  const navState = activeId ? navStates[activeId] : undefined
  const activeFederating = activeId !== null && federating.has(activeId)
  const loading = loadingView(activeAccount?.name, navState, activeFederating)
  // Day-to-day jump targets vs the (rarely changing) base accounts.
  const mainAccounts = accounts.filter((a) => a.kind === 'assume')
  const baseAccounts = accounts.filter((a) => a.kind === 'base')
  const hideConsole = paletteOpen || switcherOpen || editing !== null || aiSettingsOpen

  const activate = useCallback((id: string, source: SwitchSource = 'switcher') => {
    setActiveId(id)
    setPaletteOpen(false)
    setSwitcherOpen(false)
    void window.api.openAccount(id, source)
  }, [])

  const openFind = useCallback(() => {
    setFindOpen(true)
    setFindFocus((n) => n + 1)
  }, [])

  // Keep a ref so IPC/keyboard handlers registered once always see fresh accounts.
  // Cmd+1-9 targets the jump accounts; falls back to base accounts when none exist yet.
  const switchByIndexRef = useRef<(i: number) => void>(() => {})
  useEffect(() => {
    switchByIndexRef.current = (i: number) => {
      const list = mainAccounts.length > 0 ? mainAccounts : baseAccounts
      const account = list[i]
      if (account) activate(account.id, 'hotkey')
    }
  })

  useEffect(() => {
    void window.api.listAccounts().then(setAccounts)
    void window.api.listRecents().then(setRecents)
    void window.api.ai.getConfig().then(setAiConfig)
    const unsubscribes = [
      window.api.onRecents(setRecents),
      window.api.onNavState((s) => setNavStates((prev) => ({ ...prev, [s.accountId]: s }))),
      window.api.onPaletteOpen(() => {
        setSwitcherOpen(false)
        setPaletteOpen(true)
      }),
      window.api.onSwitcherOpen(() => {
        setPaletteOpen(false)
        setSwitcherOpen(true)
      }),
      window.api.onSwitchAccount((i) => switchByIndexRef.current(i)),
      window.api.onFindOpen(openFind),
      window.api.onFindClose(() => setFindOpen(false)),
      window.api.onRecentsToggle(toggleRecents),
      window.api.onAssistantToggle(toggleAssistant),
      window.api.onEditAccount((account) => {
        setPaletteOpen(false)
        setSwitcherOpen(false)
        setEditing({ kind: account.kind, account })
      }),
      window.api.onFederationState((id, active) =>
        setFederating((prev) => {
          const next = new Set(prev)
          if (active) next.add(id)
          else next.delete(id)
          return next
        })
      )
    ]
    return () => unsubscribes.forEach((off) => off())
  }, [openFind, toggleRecents, toggleAssistant])

  // Report the console slot rect so the main process can position the WebContentsView.
  useEffect(() => {
    const el = slotRef.current
    if (!el) return
    const send = (): void => {
      const r = el.getBoundingClientRect()
      window.api.setConsoleBounds({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    window.addEventListener('resize', send)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', send)
    }
  }, [])

  // The WebContentsView paints above the renderer DOM, so hide it while overlays are open.
  useEffect(() => {
    window.api.setConsoleVisible(!hideConsole)
  }, [hideConsole])

  useEffect(() => {
    if (recentsOpen) localStorage.removeItem(RECENTS_HIDDEN_KEY)
    else localStorage.setItem(RECENTS_HIDDEN_KEY, '1')
  }, [recentsOpen])

  // A find session belongs to one page; switching accounts or tabs ends it.
  const activeTabId = navState?.activeTabId
  useEffect(() => {
    setFindOpen(false)
  }, [activeId, activeTabId])

  // Tab shortcuts (⌘W, ⌃Tab, ⌘⇧[ ]) are caught in the main process, before the default menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!modPressed(e) || e.altKey) return
      const key = shortcutKey(e)
      if (e.shiftKey) {
        if (key === 'a') {
          e.preventDefault()
          toggleSwitcher()
        }
      } else if (key === 'k') {
        e.preventDefault()
        togglePalette()
      } else if (key === 'f') {
        e.preventDefault()
        openFind()
      } else if (key === 'j') {
        e.preventDefault()
        toggleRecents()
      } else if (key === 'i') {
        e.preventDefault()
        toggleAssistant()
      } else if (/^[1-9]$/.test(key)) {
        e.preventDefault()
        switchByIndexRef.current(Number(key) - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openFind, toggleRecents, togglePalette, toggleSwitcher, toggleAssistant])

  const openRecent = useCallback((r: RecentResource) => {
    setActiveId(r.accountId)
    setPaletteOpen(false)
    void window.api.navigate(r.accountId, r.url)
  }, [])

  const openUrl = useCallback((accountId: string, url: string) => {
    setActiveId(accountId)
    setPaletteOpen(false)
    void window.api.navigate(accountId, url)
  }, [])

  const handleSave = async (input: Partial<AwsAccount>): Promise<void> => {
    let result
    try {
      result = await window.api.saveAccount(input)
    } catch (err) {
      window.api.showError(err instanceof Error ? err.message : String(err))
      return
    }
    setAccounts(result.accounts)
    setEditing(null)
    // An edit may have reset the active account's login; reopen it.
    if (!input.id) activate(result.saved.id, 'new-account')
    else if (input.id === activeId) activate(result.saved.id)
  }

  const handleDelete = async (account: AwsAccount): Promise<void> => {
    const label = account.kind === 'base' ? '基础账号' : '账号'
    if (!confirm(`确定删除${label}「${account.name}」吗？`)) return
    const result = await window.api.deleteAccount(account.id)
    if (result.error) {
      window.api.showError(result.error)
      return
    }
    setAccounts(result.accounts)
    if (activeId === account.id) setActiveId(null)
  }

  return (
    <div className="app">
      <TopBar
        account={activeAccount}
        navState={navState}
        federating={activeFederating}
        busy={loading.bar}
        onRelogin={(account) => window.api.relogin(account.id)}
        onOpenSwitcher={toggleSwitcher}
        switcherShortcut={SWITCHER_SHORTCUT}
        recentsOpen={recentsOpen}
        onToggleRecents={toggleRecents}
        recentsShortcut={`${MOD}J`}
        aiOpen={aiOpen}
        onToggleAi={toggleAssistant}
        aiShortcut={`${MOD}I`}
      />

      <main className="console-slot">
        <div className="console-column">
          {findOpen && activeAccount && (
            <FindBar
              query={findQuery}
              onQueryChange={setFindQuery}
              focusToken={findFocus}
              onClose={() => setFindOpen(false)}
            />
          )}

          {/* The reported rect is this inner box, so opening the find bar
              reflows the native view instead of being covered by it. */}
          <div className="console-view" ref={slotRef}>
            {loading.panel && (
              <div className="loading-panel" role="status">
                <span className="spinner large" />
                <p>{loading.panel}</p>
              </div>
            )}
            {!activeAccount && (
              <div className="welcome">
                <h1>AWS Console Hub</h1>
                <p>每个账号独立会话，互不干扰</p>
                <p className="kbd-hint">
                  <kbd>{SWITCHER_SHORTCUT}</kbd> 账号列表 · <kbd>{MOD}K</kbd> 快速跳转 · <kbd>{MOD}1-9</kbd> 切换账号 ·{' '}
                  <kbd>{MOD}F</kbd> 页内搜索 · <kbd>{MOD}J</kbd> 最近访问 · <kbd>{MOD}I</kbd> AI 助手
                </p>
                {baseAccounts.length === 0 ? (
                  <button
                    className="primary"
                    onClick={() => setEditing({ kind: 'base', account: null })}
                  >
                    第一步：添加基础账号
                  </button>
                ) : mainAccounts.length === 0 ? (
                  <button
                    className="primary"
                    onClick={() => setEditing({ kind: 'assume', account: null })}
                  >
                    第二步：添加要跳转的账号
                  </button>
                ) : (
                  <button className="primary" onClick={toggleSwitcher}>
                    选择账号（{SWITCHER_SHORTCUT}）
                  </button>
                )}
              </div>
            )}
          </div>

          {/* A sibling below the view, like the find bar above it: the view shrinks instead of being covered. */}
          {recentsOpen && (
            <ResourceStrip
              accounts={accounts}
              recents={recents}
              onOpen={openRecent}
              onHide={toggleRecents}
              shortcut={`${MOD}J`}
            />
          )}
        </div>

        {/* Beside the column, so the console view narrows rather than covering the panel. */}
        {aiOpen && (
          <AssistantPanel
            // A remount after "删除全部 AI 数据": no conversation, item or remembered selection survives it.
            key={aiDataVersion}
            account={activeAccount}
            config={aiConfig}
            width={aiWidth}
            onResize={(width, done) => {
              setAiWidth(width)
              if (done) localStorage.setItem(AI_WIDTH_KEY, String(width))
            }}
            onOpenSettings={() => setAiSettingsOpen(true)}
            onConfig={setAiConfig}
            onClose={toggleAssistant}
            pageKey={`${navState?.url ?? ''}\n${navState?.tabs.find((t) => t.id === navState.activeTabId)?.title ?? ''}`}
            onSetAllowWrite={async (allow) => {
              if (!activeAccount) return
              try {
                setAccounts((await window.api.saveAccount({ id: activeAccount.id, aiAllowWrite: allow })).accounts)
              } catch (err) {
                window.api.showError(err instanceof Error ? err.message : String(err))
              }
            }}
            focusToken={aiFocus}
          />
        )}
      </main>

      {switcherOpen && (
        <AccountSwitcher
          accounts={accounts}
          activeId={activeId}
          mod={MOD}
          busy={(id) => federating.has(id) || (id === activeId && Boolean(navState?.loading))}
          onClose={() => setSwitcherOpen(false)}
          onSwitch={(id) => activate(id, 'switcher')}
          onEdit={(account) => {
            setSwitcherOpen(false)
            setEditing({ kind: account.kind, account })
          }}
          onDelete={(account) => void handleDelete(account)}
          onAdd={(kind) => {
            setSwitcherOpen(false)
            setEditing({ kind, account: null })
          }}
          onRelogin={(account) => {
            setSwitcherOpen(false)
            void window.api.relogin(account.id)
          }}
        />
      )}

      {paletteOpen && (
        <Palette
          accounts={accounts}
          activeAccount={activeAccount}
          recents={recents}
          onClose={() => setPaletteOpen(false)}
          onSwitchAccount={(id) => activate(id, 'palette')}
          onOpenUrl={openUrl}
          onOpenRecent={openRecent}
        />
      )}

      {aiSettingsOpen && (
        <AiSettings
          accounts={accounts}
          onClose={(config) => {
            if (config) setAiConfig(config)
            setAiSettingsOpen(false)
            setAiFocus((n) => n + 1)
          }}
          onDataDeleted={() => setAiDataVersion((n) => n + 1)}
        />
      )}

      {editing !== null && (
        <AccountModal
          // A login can open the modal for another account while this one is up.
          key={editing.account?.id ?? editing.kind}
          kind={editing.kind}
          account={editing.account}
          baseAccounts={baseAccounts}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
