import { BrowserWindow, WebContentsView, session, shell } from 'electron'
import type { AwsAccount, FindOptions, FindResult, NavState, Rect } from '../shared/types'
import { isConsoleUrl, isSignInUrl, windowOpenAction } from './urls'
import { shortcutFor, type Shortcut } from './shortcuts'
import { runTabAction } from './tabIpc'
import type { PageTab } from './ai/page'

/** Web permissions the console actually needs (copy buttons, full-screen editors). */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

const partitionFor = (accountId: string): string => `persist:account-${accountId}`

const isMac = process.platform === 'darwin'

/** read_current_page's script runs in its own JS world: same DOM, none of the page's globals or prototypes. */
const PAGE_READ_WORLD_ID = 1001

/** How long an off-screen session refresh may take before it counts as failed. */
const REFRESH_TIMEOUT_MS = 60_000

const liveContents = (view?: WebContentsView): Electron.WebContents | undefined => {
  const wc = view?.webContents
  return wc && !wc.isDestroyed() ? wc : undefined
}

interface ViewCallbacks {
  onNavigated: (accountId: string, url: string) => void
  onNavState: (state: NavState) => void
  /** The console kicked a tab out; `returnTo` is where that tab was. */
  onSignedOut: (accountId: string, tabId: number, returnTo: string | undefined) => void
  onPalette: () => void
  /** ⌘⇧A: the top bar's account switcher. */
  onAccountSwitcher: () => void
  onSwitchAccount: (index: number) => void
  onFind: () => void
  /** ⌘J: show / hide the recents strip. */
  onToggleRecents: () => void
  /** ⌘I: show / hide the AI assistant panel. */
  onAssistant: () => void
  /** Esc pressed inside the page while the find bar is open. */
  onFindClose: () => void
  onFindResult: (result: FindResult) => void
  /** A tab view was added on top of the window's views. */
  onTabAdded: () => void
}

/**
 * Browser-like tabs per AWS account. Every tab is its own WebContentsView,
 * and all tabs of an account share one persistent session partition, so they
 * share its console login while accounts never interfere with each other.
 * A tab id is its webContents id.
 */
export class ViewManager {
  /** Tabs per account, in strip order. An opened account always has at least one. */
  private tabs = new Map<string, WebContentsView[]>()
  private activeTabs = new Map<string, WebContentsView>()
  /** Last console page per tab, so a re-login can land back on it. */
  private returnUrls = new Map<number, string>()
  private tabIds = new WeakMap<WebContentsView, number>()
  /**
   * Tabs that have committed a page. A tab without one stays hidden, since an
   * empty native view would paint blank white over the renderer's loading panel.
   */
  private painted = new WeakSet<WebContentsView>()
  private loading = new WeakSet<WebContentsView>()
  private bounds: Rect = { x: 0, y: 0, width: 800, height: 600 }
  private consoleVisible = true
  /** Whether the renderer's find bar is up (it calls find() on open, stopFind() on close). */
  private findOpen = false
  private closing = false
  activeId: string | null = null

  constructor(
    private win: BrowserWindow,
    private callbacks: ViewCallbacks
  ) {
    win.once('close', () => { this.closing = true })
    win.once('closed', () => { this.closing = true })
    // Tab shortcuts while focus is in the renderer UI. ⌘W in particular would
    // otherwise reach the default macOS menu and close the whole window.
    // ⌘K / ⌘⇧A / ⌘F / ⌘J / ⌘I / ⌘1-9 are left to the renderer, which knows its own state.
    win.webContents.on('before-input-event', (event, input) => {
      const s = shortcutFor(input, isMac)
      if (s && (s.kind === 'close-tab' || s.kind === 'next-tab' || s.kind === 'prev-tab')) {
        event.preventDefault()
        this.runShortcut(s)
      }
    })
  }

  private tabList(accountId: string): WebContentsView[] {
    return this.tabs.get(accountId) ?? []
  }

  /** The active tab of the active account: the one on screen. */
  private current(): WebContentsView | undefined {
    const view = this.activeId ? this.activeTabs.get(this.activeId) : undefined
    return liveContents(view) ? view : undefined
  }

  /** Whether any of the account's tabs has ever navigated. */
  hasContent(accountId: string): boolean {
    return this.tabList(accountId).some((v) => Boolean(liveContents(v)?.getURL()))
  }

  /** The page a tab (default: the account's active tab) should come back to after a re-login. */
  returnUrl(accountId: string, tabId?: number): string | undefined {
    const id = tabId ?? liveContents(this.activeTabs.get(accountId))?.id
    return id === undefined ? undefined : this.returnUrls.get(id)
  }

  /** The account's active tab, for the assistant's page context: URL and title only. */
  activePage(accountId: string): { url: string; title: string } | null {
    const wc = liveContents(this.activeTabs.get(accountId))
    return wc ? { url: wc.getURL(), title: wc.getTitle() } : null
  }

  /** The tab on screen, for read_current_page; ai/page.ts checks its account and URL before running anything. */
  onScreenTab(): PageTab | null {
    const wc = liveContents(this.current())
    if (!this.activeId || !wc) return null
    return { accountId: this.activeId, url: wc.getURL(), title: wc.getTitle(), run: (code) => wc.executeJavaScriptInIsolatedWorld(PAGE_READ_WORLD_ID, [{ code }]) }
  }

  private createTab(accountId: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        // The whole point of this app: one isolated cookie jar per account.
        partition: partitionFor(accountId)
      }
    })
    view.setBackgroundColor('#ffffff')
    const wc = view.webContents
    const tabId = wc.id
    this.tabIds.set(view, tabId)
    wc.once('destroyed', () => this.onTabDestroyed(accountId, view, tabId))
    // Electron grants every permission by default; tabs and popups share this session.
    wc.session.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(ALLOWED_PERMISSIONS.has(permission))
    )
    wc.session.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))

    this.applyWindowPolicy(wc, accountId)

    const emitNav = (url: string): void => {
      if (isConsoleUrl(url)) this.returnUrls.set(tabId, url)
      this.callbacks.onNavigated(accountId, url)
      this.emitNavState(accountId)
    }
    wc.on('did-navigate', (_e, url) => {
      if (!this.painted.has(view)) {
        this.painted.add(view)
        if (this.current() === view) this.display()
      }
      emitNav(url)
      if (isSignInUrl(url)) this.callbacks.onSignedOut(accountId, tabId, this.returnUrls.get(tabId))
    })
    // Hash routes, pushState and replaceState: how SPA consoles move between resources.
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) emitNav(url)
    })
    wc.on('did-start-loading', () => this.emitNavState(accountId))
    wc.on('did-stop-loading', () => {
      this.loading.delete(view)
      this.emitNavState(accountId)
    })
    wc.on('render-process-gone', () => this.emitNavState(accountId))
    wc.on('page-title-updated', () => this.emitNavState(accountId))

    wc.on('found-in-page', (_e, result) => {
      if (this.current() !== view) return
      this.callbacks.onFindResult({
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches
      })
    })

    // Keep app shortcuts working while focus is inside the console page.
    wc.on('before-input-event', (event, input) => {
      // Not swallowed: the page may have its own dialog to dismiss.
      if (this.findOpen && input.type === 'keyDown' && input.key === 'Escape') this.callbacks.onFindClose()
      const s = shortcutFor(input, isMac)
      if (!s) return
      event.preventDefault()
      this.runShortcut(s)
    })

    this.win.contentView.addChildView(view)
    view.setBounds(this.bounds)
    view.setVisible(false)
    this.tabs.set(accountId, [...(this.tabs.get(accountId) ?? []), view])
    this.callbacks.onTabAdded()
    return view
  }

  private runShortcut(s: Shortcut): void {
    switch (s.kind) {
      case 'palette':
        return this.callbacks.onPalette()
      case 'account-switcher':
        return this.callbacks.onAccountSwitcher()
      case 'find':
        return this.callbacks.onFind()
      case 'recents':
        return this.callbacks.onToggleRecents()
      case 'assistant':
        return this.callbacks.onAssistant()
      case 'account':
        return this.callbacks.onSwitchAccount(s.index)
      case 'close-tab': {
        const view = this.current()
        const id = liveContents(view)?.id
        if (id !== undefined) this.closeTab(id)
        return
      }
      case 'next-tab':
        return this.cycleTab(1)
      case 'prev-tab':
        return this.cycleTab(-1)
    }
  }

  /**
   * No popup windows for pages: a `target="_blank"` link or `window.open(url)`
   * to an Amazon / AWS page becomes a new tab in the same account (same
   * session), anything else on the web goes to the system browser. Only
   * URL-less opens — the auth-flow shape — still become a real window, and
   * that window inherits the same policy.
   */
  private applyWindowPolicy(wc: Electron.WebContents, accountId: string): void {
    wc.setWindowOpenHandler(({ url, disposition }) => {
      const action = windowOpenAction(url)
      if (action === 'popup') {
        return {
          action: 'allow',
          // A real titled window, sized for a login prompt. The popup inherits
          // the opener's session partition, so it stays on the right account.
          overrideBrowserWindowOptions: {
            width: 560,
            height: 760,
            autoHideMenuBar: true,
            backgroundColor: '#ffffff'
          }
        }
      }
      if (action === 'tab') {
        // Deferred: creating a view from inside the handler runs while
        // Chromium is still resolving the open it just asked us about.
        setImmediate(() => void runTabAction(
          () => { this.openTab(accountId, url, disposition !== 'background-tab') },
          () => console.error('Deferred tab open failed')
        ))
      } else if (action === 'external') {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    wc.on('did-create-window', (child) => {
      child.setMenuBarVisibility(false)
      this.applyWindowPolicy(child.webContents, accountId)
    })
  }

  /** False when the account has no tabs yet (or any more): nothing to share a session with. */
  openTab(accountId: string, url: string, activate: boolean): boolean {
    // The account was removed while the open was pending.
    if (!this.tabs.has(accountId)) return false
    const view = this.createTab(accountId)
    if (activate || !liveContents(this.activeTabs.get(accountId))) this.setActiveTab(accountId, view)
    else this.emitNavState(accountId)
    void liveContents(view)?.loadURL(url).catch(() => {})
    return true
  }

  /** The account's active tab, creating its first tab on demand. */
  private ensure(accountId: string): WebContentsView {
    const existing = this.activeTabs.get(accountId)
    if (liveContents(existing)) return existing!
    const view = this.createTab(accountId)
    this.activeTabs.set(accountId, view)
    return view
  }

  /** Put exactly the on-screen tab up (nothing while renderer overlays are open). */
  private display(): void {
    const current = this.current()
    for (const list of this.tabs.values()) {
      for (const view of list) {
        view.setVisible(this.consoleVisible && view === current && this.painted.has(view))
      }
    }
    if (this.consoleVisible) liveContents(current)?.focus()
  }

  /** Keyboard to where it belongs: the on-screen tab, or the app UI while it is hidden. */
  focus(): void {
    const current = this.current()
    if (this.consoleVisible && current && this.painted.has(current)) liveContents(current)?.focus()
    else this.win.webContents.focus()
  }

  /** A tab left on the sign-in page by an expiry goes back to its page; the session may be fresh by now. */
  private restoreTab(view: WebContentsView): void {
    const wc = liveContents(view)
    if (!wc) return
    const back = this.returnUrls.get(wc.id)
    if (back && isSignInUrl(wc.getURL())) void wc.loadURL(back).catch(() => {})
  }

  private setActiveTab(accountId: string, view: WebContentsView): void {
    const previous = this.activeTabs.get(accountId)
    // Highlights would otherwise linger on a page nobody is looking at.
    if (previous && previous !== view) liveContents(previous)?.stopFindInPage('clearSelection')
    if (!liveContents(view)) return
    this.activeTabs.set(accountId, view)
    // Lazy: if the session is still dead this bounces to sign-in again, and
    // the sign-out handler logs in and returns here.
    this.restoreTab(view)
    if (accountId === this.activeId) this.display()
    this.emitNavState(accountId)
  }

  private findTab(tabId: number): { accountId: string; list: WebContentsView[]; index: number } | null {
    for (const [accountId, list] of this.tabs) {
      const index = list.findIndex((v) => liveContents(v)?.id === tabId)
      if (index >= 0) return { accountId, list, index }
    }
    return null
  }

  activateTab(tabId: number): void {
    const found = this.findTab(tabId)
    if (found) this.setActiveTab(found.accountId, found.list[found.index])
  }

  /** Close a tab. An account's last tab stays: it is where its logins land. */
  closeTab(tabId: number): void {
    const found = this.findTab(tabId)
    if (!found || found.list.filter((view) => liveContents(view)).length === 1) return
    const { accountId, list, index } = found
    const [view] = list.splice(index, 1)
    this.returnUrls.delete(tabId)
    if (this.activeTabs.get(accountId) === view) {
      const next = list.slice(index).find((v) => liveContents(v)) ?? list.slice(0, index).reverse().find((v) => liveContents(v))
      if (next) this.setActiveTab(accountId, next)
    } else {
      this.emitNavState(accountId)
    }
    this.destroy(view)
  }

  private onTabDestroyed(accountId: string, view: WebContentsView, tabId: number): void {
    const list = this.tabs.get(accountId)
    if (!list) return
    const index = list.indexOf(view)
    if (index < 0) return
    const back = this.returnUrls.get(tabId)
    list.splice(index, 1)
    this.returnUrls.delete(tabId)
    if (this.closing || this.win.isDestroyed()) return
    try {
      this.win.contentView.removeChildView(view)
      let neighbourIndex = index
      for (const stale of [...list]) {
        if (liveContents(stale)) continue
        const staleIndex = list.indexOf(stale)
        if (staleIndex < neighbourIndex) neighbourIndex--
        list.splice(staleIndex, 1)
        const staleId = this.tabIds.get(stale)
        if (staleId !== undefined) this.returnUrls.delete(staleId)
        this.win.contentView.removeChildView(stale)
      }
      let next = list[Math.min(neighbourIndex, list.length - 1)]
      if (!next) {
        next = this.createTab(accountId)
        if (back && isConsoleUrl(back)) {
          this.returnUrls.set(this.tabIds.get(next)!, back)
          this.loading.add(next)
        }
      }
      if (this.activeTabs.get(accountId) === view || !liveContents(this.activeTabs.get(accountId))) this.setActiveTab(accountId, next)
      else this.emitNavState(accountId)
      if (this.loading.has(next) && back) {
        void liveContents(next)?.loadURL(back).catch(() => {
          this.loading.delete(next)
          this.emitNavState(accountId)
        })
      }
    } catch {
      console.error('Tab recreation failed')
    }
  }

  private cycleTab(delta: number): void {
    const current = this.current()
    if (!this.activeId || !current) return
    const list = this.tabList(this.activeId).filter((view) => liveContents(view))
    if (list.length < 2) return
    const next = list[(list.indexOf(current) + delta + list.length) % list.length]
    this.setActiveTab(this.activeId, next)
  }

  private destroy(view: WebContentsView): void {
    this.win.contentView.removeChildView(view)
    liveContents(view)?.close()
  }

  private emitNavState(accountId: string): void {
    const view = this.activeTabs.get(accountId)
    const wc = liveContents(view)
    if (!view || !wc) return
    this.callbacks.onNavState({
      accountId,
      url: wc.getURL(),
      hasPage: this.painted.has(view),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading() || this.loading.has(view),
      activeTabId: wc.id,
      tabs: this.tabList(accountId).flatMap((v) => {
        const tab = liveContents(v)
        return tab ? [{ id: tab.id, title: tab.getTitle(), url: tab.getURL(), loading: tab.isLoading() || this.loading.has(v) }] : []
      })
    })
  }

  /**
   * Show an account's active tab. Navigation (including first-time login) is
   * driven by the caller — federation is async and owned by the main
   * process, not the view layer.
   */
  show(account: AwsAccount): void {
    this.ensure(account.id)
    if (this.activeId !== account.id) liveContents(this.current())?.stopFindInPage('clearSelection')
    this.activeId = account.id
    this.display()
    this.emitNavState(account.id)
  }

  /**
   * Load `url` in one of the account's tabs (default: its active tab; also if
   * `tabId` has been closed meanwhile). `activate` is false for a silent
   * re-login, which must not yank a background account into the foreground.
   * Resolves once the page has loaded or failed.
   */
  navigate(account: AwsAccount, url: string, activate = true, tabId?: number): Promise<void> {
    const target = tabId === undefined ? null : this.findTab(tabId)
    const view =
      target && target.accountId === account.id ? target.list[target.index] : this.ensure(account.id)
    if (activate) this.show(account)
    return liveContents(view)?.loadURL(url).catch(() => {}) ?? Promise.resolve()
  }

  /** After a fresh login, send every tab of the account that sits on the sign-in page back to its page. */
  restoreSignedOut(accountId: string): void {
    for (const view of this.tabList(accountId)) this.restoreTab(view)
  }

  /**
   * Run a federation login off-screen in the account's partition. The new
   * session cookies land in the jar every tab shares, while the tabs
   * themselves stay on their pages. Resolves true once the login reached a
   * console page.
   *
   * Unverified assumption: an already open console page picks up the renewed
   * cookies on its next credential fetch. Pages that cache credentials past
   * the old expiry can still bounce to sign-in, which the sign-out handler
   * then repairs with a return to the same page.
   */
  async refreshSession(accountId: string, loginUrl: string): Promise<boolean> {
    const view = new WebContentsView({
      webPreferences: { partition: partitionFor(accountId), backgroundThrottling: false }
    })
    const wc = view.webContents
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        wc.loadURL(loginUrl),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), REFRESH_TIMEOUT_MS)
        })
      ])
    } catch {
      // A console that redirects again mid-load aborts the load; where it ended up decides.
    } finally {
      clearTimeout(timer)
    }
    const ok = !wc.isDestroyed() && isConsoleUrl(wc.getURL())
    if (!wc.isDestroyed()) wc.close()
    return ok
  }

  /** Drop the account's tabs and its on-disk login state (cookies, storage). */
  async removeAccount(id: string): Promise<void> {
    const list = this.tabList(id)
    this.tabs.delete(id)
    this.activeTabs.delete(id)
    if (this.activeId === id) this.activeId = null
    for (const view of list) {
      const tabId = this.tabIds.get(view)
      if (tabId !== undefined) this.returnUrls.delete(tabId)
      this.destroy(view)
    }
    await session.fromPartition(partitionFor(id)).clearStorageData()
  }

  setBounds(bounds: Rect): void {
    this.bounds = bounds
    for (const list of this.tabs.values()) for (const view of list) view.setBounds(bounds)
  }

  /** Hide the console so renderer overlays (palette/modals) are visible. */
  setConsoleVisible(visible: boolean): void {
    this.consoleVisible = visible
    this.display()
  }

  goBack(): void {
    liveContents(this.current())?.navigationHistory.goBack()
  }

  goForward(): void {
    liveContents(this.current())?.navigationHistory.goForward()
  }

  reload(): void {
    liveContents(this.current())?.reload()
  }

  /** In-page find on the on-screen tab; empty text clears the highlights. */
  find(text: string, options: FindOptions): void {
    this.findOpen = true
    const wc = liveContents(this.current())
    if (!wc) return
    if (text) wc.findInPage(text, options)
    else wc.stopFindInPage('clearSelection')
  }

  stopFind(): void {
    this.findOpen = false
    liveContents(this.current())?.stopFindInPage('clearSelection')
  }
}
