import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, shell, systemPreferences } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { AccountStore } from './accounts'
import { logActivity, pageLabel, trimActivityLog } from './activity'
import { RecentsStore } from './recents'
import { ViewManager } from './views'
import { ToastOverlay } from './toast'
import { runTabAction } from './tabIpc'
import { consoleRegion, isConsoleUrl, windowOpenAction } from './urls'
import { AwsClients } from './ai/aws'
import { findAwsCli, stopAllCli } from './ai/awsCli'
import { loginIdentity } from './ai/changes/engine'
import { AiConfigStore } from './ai/config'
import { AiStore, openAiDb } from './ai/db'
import { registerAiIpc } from './ai/ipc'
import { readCurrentPage } from './ai/page'
import { redactSecrets } from './ai/redact'
import { KeyStore } from './ai/keystore'
import { createConfiguredModels } from './ai/providers'
import { AiService } from './ai/service'
import { REGIONS } from '../shared/catalog'
import { shouldRefresh } from './refresh'
import {
  NeedsCommandError,
  assumeRole,
  callerIdentity,
  clearCredentialCache,
  consoleHome,
  consoleSessionSeconds,
  getAccountCredentials,
  getLoginUrl,
  getSigninToken
} from './federation'
import { runCredentialCommand, runKeyCommand } from './credentialCommand'
import { testConnection } from './connectionTest'
import { readThemePreference, saveThemePreference, backgroundForPreference, readSystemDark, resolvedSystemDark } from './theme'
import { needsDisplayName, resolveDisplayName } from './resolver'
import type { ActivityEvent } from './activity'
import type { RecentResource } from '../shared/types'
import type { AwsAccount, FindOptions, Rect } from '../shared/types'

/** resources/ sits next to the app in dev and inside resourcesPath when packaged. */
function resourcePath(name: string): string | null {
  const candidates = [
    path.join(__dirname, '../../resources', name),
    path.join(process.resourcesPath, name)
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

function loadAppIcon(): Electron.NativeImage | undefined {
  const file = resourcePath('icon.png')
  if (!file) return undefined
  const image = nativeImage.createFromPath(file)
  return image.isEmpty() ? undefined : image
}

// Capture the native value while Electron still follows the OS. Chromium is forced light for console pages below.
let systemDark = nativeTheme.shouldUseDarkColors
function createWindow(): void {
  systemDark = resolvedSystemDark(process.platform, systemDark, process.platform === 'darwin' ? systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') : undefined)
  let preference = readThemePreference(app.getPath('userData'))
  // The console pages keep their pre-P3 light color scheme. The renderer paints app chrome separately.
  nativeTheme.themeSource = 'light'
  ipcMain.on('app:system-dark', (event) => { event.returnValue = systemDark })
  ipcMain.on('app:theme-preference', (event) => { event.returnValue = preference })

  const icon = loadAppIcon()
  // On macOS the dock icon comes from the bundle when packaged, but in dev it
  // has to be set explicitly or you get the stock Electron logo.
  if (icon && process.platform === 'darwin') app.dock?.setIcon(icon)

  const win = new BrowserWindow({
    icon,
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 640,
    title: 'AWS Console Hub',
    titleBarStyle: 'hiddenInset',
    // Centered in the 52px renderer header.
    trafficLightPosition: { x: 18, y: 20 },
    backgroundColor: backgroundForPreference(preference, systemDark),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js')
    }
  })
  const paintBackground = (): void => {
    const color = backgroundForPreference(preference, systemDark)
    win.setBackgroundColor(color)
    win.contentView.setBackgroundColor(color)
  }
  let views: ViewManager
  paintBackground()
  const updateSystemDark = (dark: boolean): void => {
    if (win.isDestroyed()) return
    if (systemDark === dark) return
    systemDark = dark
    paintBackground()
    win.webContents.send('app:system-dark-changed', dark)
    toasts.setSystemDark(dark)
  }
  const systemNotification = process.platform === 'darwin'
    ? systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', () => {
      updateSystemDark(systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark')
    }) : null
  const refreshSystem = (): void => {
    if (process.platform === 'darwin') updateSystemDark(systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark')
    else readSystemDark(process.platform, updateSystemDark)
  }
  refreshSystem()
  win.on('focus', refreshSystem)
  win.on('show', refreshSystem)
  win.on('closed', () => {
    ipcMain.removeAllListeners('app:system-dark')
    ipcMain.removeAllListeners('app:theme-preference')
    ipcMain.removeAllListeners('app:theme')
    if (systemNotification !== null) systemPreferences.unsubscribeNotification(systemNotification)
  })
  ipcMain.on('app:theme', (event, choice: unknown, resolved: unknown) => {
    if (event.sender !== win.webContents || (choice !== 'system' && choice !== 'light' && choice !== 'dark') || (resolved !== 'light' && resolved !== 'dark')) return
    if (choice !== preference) {
      try { saveThemePreference(app.getPath('userData'), choice) }
      catch { console.error('Unable to save theme preference') }
    }
    // Keep Chromium light for every embedded console WebContentsView.
    // The renderer's data-theme selects the app colors.
    preference = choice
    if (choice === 'system') refreshSystem()
    paintBackground()
  })
  win.setMenuBarVisibility(false)
  // The shell only ever shows its own page: a dropped file or link must not
  // replace it with content that would still get window.api.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const send = (channel: string, ...args: unknown[]): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const accounts = new AccountStore()
  const recents = new RecentsStore((items) => send('recents:updated', items))
  app.on('before-quit', () => recents.flush())
  app.on('before-quit', stopAllCli)
  trimActivityLog()

  /**
   * Resolve opaque resource ids (EC2's i-0abc…) into Name tags, off the
   * navigation path. Credentials are warm here — the user just opened this
   * account through the app. At most one attempt per resource per hour.
   */
  const enrichAttempts = new Map<string, number>()
  const enrichDisplayName = async (item: RecentResource): Promise<void> => {
    if (!needsDisplayName(item)) return
    const attempted = enrichAttempts.get(item.key) ?? 0
    if (Date.now() - attempted < 3600_000) return
    enrichAttempts.set(item.key, Date.now())

    const account = accounts.get(item.accountId)
    if (!account) return
    try {
      const via = account.kind === 'assume' ? accounts.get(account.viaId ?? '') : undefined
      const creds = await getAccountCredentials(account, via)
      const name = await resolveDisplayName(creds, item)
      if (name) recents.setDisplayName(item.key, name)
    } catch {
      // Missing permission or deleted resource — the id stays, which is fine.
    }
  }

  /**
   * When each account's console session lapses. Console sessions are short —
   * an hour for assume-accounts, because role chaining caps the credentials
   * behind them — so the app has to notice and log back in instead of leaving
   * the user on an AWS sign-in page.
   */
  const sessionExpiry = new Map<string, number>()
  /** Treat a session that is about to lapse as already gone. */
  const SESSION_GRACE_MS = 60_000
  /** Last automatic re-login, so a federation that keeps failing can't loop. */
  const autoLoginAt = new Map<string, number>()
  const AUTO_LOGIN_COOLDOWN_MS = 30_000

  /** Last time the user opened or navigated in each account, for background refresh. */
  const lastUsedAt = new Map<string, number>()
  const refreshAttemptAt = new Map<string, number>()
  const touch = (accountId: string): void => {
    lastUsedAt.set(accountId, Date.now())
  }

  const sessionAlive = (accountId: string): boolean => {
    const expiresAt = sessionExpiry.get(accountId)
    return expiresAt !== undefined && expiresAt - SESSION_GRACE_MS > Date.now()
  }

  // Created before any tab, and raised above each new one.
  const toasts = new ToastOverlay(win, () => views.focus())
  const tabAction = (action: () => void | Promise<void>): Promise<void> =>
    runTabAction(action, (err) => {
      console.error('Tab action failed:', err instanceof Error ? err.name : 'Error', redactSecrets(err instanceof Error ? err.message : String(err)))
      toasts.show('error', '标签页操作失败，请重试')
    })

  views = new ViewManager(win, {
    onNavigated: (accountId, url) => {
      touch(accountId)
      const item = recents.record(accountId, url)
      logActivity(
        item && !item.isPage
          ? {
              type: 'resource',
              accountId,
              service: item.service,
              region: item.region,
              resourceType: item.resourceType,
              name: item.name
            }
          : { type: 'page', accountId, page: pageLabel(url) }
      )
      if (item) void enrichDisplayName(item)
    },
    onNavState: (state) => send('nav:state', state),
    onSignedOut: (accountId, tabId, returnTo) => {
      const account = accounts.get(accountId)
      if (!account) return
      sessionExpiry.delete(accountId)
      // A retry that lands on the sign-in page again means federation itself is
      // broken (expired login, revoked role). Leave the page up and let the
      // user read it rather than reloading forever.
      if (Date.now() - (autoLoginAt.get(accountId) ?? 0) < AUTO_LOGIN_COOLDOWN_MS) return
      autoLoginAt.set(accountId, Date.now())
      void federateInto(account, returnTo, tabId)
    },
    onPalette: () => {
      send('palette:open')
      win.webContents.focus()
    },
    onAccountSwitcher: () => {
      send('switcher:open')
      win.webContents.focus()
    },
    onSwitchAccount: (index) => send('ui:switch-account', index),
    onFind: () => {
      send('find:open')
      // The find input lives in the renderer, so focus has to leave the view.
      win.webContents.focus()
    },
    // Focus stays in the console: the strip has nothing to type into.
    onToggleRecents: () => send('recents:toggle'),
    onAssistant: () => {
      send('assistant:toggle')
      // The panel's input lives in the renderer.
      win.webContents.focus()
    },
    onFindClose: () => send('find:close'),
    onFindResult: (result) => send('find:result', result),
    onTabAdded: () => toasts.raise()
  })

  /** What a login is actually for; when it changes, the old one must go. */
  // Shared with the AI change engine: a proposal made under one login is void under another.
  const identity = (a: AwsAccount | undefined): string | undefined => a && loginIdentity(a)

  /** Drop everything tied to an account's login: view, cookies, credentials, timers. */
  const forgetSession = async (id: string): Promise<void> => {
    sessionExpiry.delete(id)
    autoLoginAt.delete(id)
    lastUsedAt.delete(id)
    refreshAttemptAt.delete(id)
    clearCredentialCache(id)
    awsClients.forget(id)
    await views.removeAccount(id)
  }

  ipcMain.handle('accounts:list', () => accounts.list())
  ipcMain.handle('accounts:save', async (_e, input: Partial<AwsAccount>) => {
    const before = identity(input.id ? accounts.get(input.id) : undefined)
    const saved = accounts.save(input)
    if (before && before !== identity(saved)) await forgetSession(saved.id)
    return { accounts: accounts.list(), saved }
  })
  ipcMain.handle('accounts:delete', async (_e, id: string) => {
    const dependents = accounts.dependents(id)
    if (dependents.length > 0) {
      return {
        accounts: accounts.list(),
        error: `有 ${dependents.length} 个账号通过它登录（${dependents
          .map((d) => d.name)
          .slice(0, 3)
          .join('、')}${dependents.length > 3 ? '…' : ''}），请先删除或改配这些账号`
      }
    }
    accounts.remove(id)
    ai.clearAccount(id)
    await forgetSession(id)
    return { accounts: accounts.list() }
  })
  // Every step of a login on the modal's unsaved values, validated like accounts:save. Nothing
  // touches the credential cache, and only step details (expiries, ARNs, errors) go back.
  ipcMain.handle('accounts:test-connection', async (e, input: Partial<AwsAccount> | undefined, runId: unknown) => {
    if (!Number.isSafeInteger(runId)) throw new Error('invalid run id')
    const account = accounts.draft(input ?? {})
    const via = account.kind === 'assume' ? accounts.get(account.viaId ?? '') : undefined
    return testConnection(
      account,
      via,
      {
        runCommand: (base) =>
          runCredentialCommand(base.command ?? '', {
            accountId: base.accountId,
            role: base.role,
            region: base.defaultRegion
          }),
        assumeRole,
        callerIdentity,
        signinToken: (target, creds) => getSigninToken(creds, consoleSessionSeconds(target, creds))
      },
      (steps) => {
        if (!e.sender.isDestroyed()) e.sender.send('accounts:test-progress', runId, steps)
      }
    )
  })

  /** In-flight federation per account, and where (which page, which tab) it should land. */
  const federating = new Map<string, Promise<void>>()
  const federationTarget = new Map<string, { url: string; tabId?: number }>()

  /**
   * Mint a fresh console session and land a tab (default: the account's
   * active one) on `destination` — the tab's last console page when there is
   * one, so a re-login does not dump the user on the console home. A request
   * while one is in flight only retargets it, so the credential command runs once. The view is
   * never brought forward here: callers that want it shown have done so
   * already, and a late login must not steal the screen from another account.
   */
  const federateInto = (account: AwsAccount, destination?: string, tabId?: number): Promise<void> => {
    const home = consoleHome(account.defaultRegion)
    federationTarget.set(account.id, { url: destination ?? home, tabId })
    const running = federating.get(account.id)
    if (running) return running

    const started = identity(account)
    send('federation:state', account.id, true)
    let landed: Promise<void> = Promise.resolve()
    const run = (async () => {
      try {
        const via = account.kind === 'assume' ? accounts.get(account.viaId ?? '') : undefined
        const session = await getLoginUrl(account, via, () => federationTarget.get(account.id)?.url ?? home)
        // Deleted or re-pointed meanwhile: this login belongs to nothing now.
        if (identity(accounts.get(account.id)) !== started) return
        sessionExpiry.set(account.id, session.expiresAt)
        // Other tabs bounced to sign-in by the same expiry follow once this
        // login has set the new cookies.
        landed = views
          .navigate(account, session.url, false, federationTarget.get(account.id)?.tabId)
          .then(() => views.restoreSignedOut(account.id))
      } catch (err) {
        sessionExpiry.delete(account.id)
        // A missing command is a to-do, not a failure: the edit window opens with it.
        toasts.show(err instanceof NeedsCommandError ? 'info' : 'error', err instanceof Error ? err.message : String(err))
        if (err instanceof NeedsCommandError) send('account:edit', err.account)
      }
    })().finally(() => {
      federating.delete(account.id)
      federationTarget.delete(account.id)
      // Held until the login page has loaded so the UI hands over to nav loading
      // without a blank gap; a newer login for the account keeps it on.
      void landed.then(() => {
        if (!federating.has(account.id)) send('federation:state', account.id, false)
      })
    })
    federating.set(account.id, run)
    return run
  }

  /**
   * Renew sessions shortly before they lapse, for accounts in recent use (see
   * refresh.ts for the AWS limits). The login runs off-screen in the same
   * partition, so visible tabs keep their pages. A failure is silent: the old
   * session runs out and the sign-out handler takes over, as before.
   */
  const refreshing = new Set<string>()
  const refreshSession = async (account: AwsAccount): Promise<void> => {
    refreshing.add(account.id)
    const started = identity(account)
    try {
      const via = account.kind === 'assume' ? accounts.get(account.viaId ?? '') : undefined
      const session = await getLoginUrl(account, via, () => consoleHome(account.defaultRegion))
      if (identity(accounts.get(account.id)) !== started) return
      if (await views.refreshSession(account.id, session.url)) {
        sessionExpiry.set(account.id, session.expiresAt)
        views.restoreSignedOut(account.id)
      }
    } catch {
      // Retried after REFRESH_RETRY_MS while the account stays in use.
    } finally {
      refreshing.delete(account.id)
    }
  }
  // Polling rather than per-account timers, so a sleep/wake is caught up too.
  const refreshTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, expiresAt] of sessionExpiry) {
      const account = accounts.get(id)
      if (!account || federating.has(id) || refreshing.has(id) || !views.hasContent(id)) continue
      const state = { expiresAt, lastUsedAt: lastUsedAt.get(id), lastAttemptAt: refreshAttemptAt.get(id) }
      if (!shouldRefresh(now, state)) continue
      refreshAttemptAt.set(id, now)
      void refreshSession(account)
    }
  }, 60_000)
  win.on('closed', () => clearInterval(refreshTimer))

  ipcMain.handle('accounts:open', (_e, id: string, source?: string) => tabAction(async () => {
    const account = accounts.get(id)
    if (!account) return
    logActivity({ type: 'switch', accountId: id, source: source ?? 'unknown' })
    touch(id)
    views.show(account)
    // Switching to a stale tab is the moment to renew: the alternative is
    // handing the user a page that is about to bounce to the sign-in screen.
    if (views.hasContent(account.id) && sessionAlive(account.id)) return
    await federateInto(account, views.returnUrl(account.id))
  }))
  ipcMain.handle('accounts:relogin', (_e, id: string) => tabAction(async () => {
    const account = accounts.get(id)
    if (!account) return
    logActivity({ type: 'relogin', accountId: id })
    clearCredentialCache(account.id)
    autoLoginAt.delete(account.id)
    views.show(account)
    // Back to the page the active tab was on, not the console home.
    await federateInto(account, views.returnUrl(account.id))
  }))
  const navigateConsole = async (accountId: string, url: string): Promise<void> => {
    const account = accounts.get(accountId)
    // Recents and palette links are always console pages; anything else is not ours to load.
    if (!account || !isConsoleUrl(url)) return
    touch(accountId)
    // Without a live session the console would just redirect to sign-in, so
    // reach the page through federation instead.
    if (sessionAlive(accountId)) void views.navigate(account, url)
    else {
      views.show(account)
      await federateInto(account, url)
    }
  }
  ipcMain.handle('console:navigate', (_e, accountId: string, url: string) => tabAction(() => navigateConsole(accountId, url)))

  // AI assistant. LLM keys, AWS credentials and raw tool results all stay in this process; changes run only after
  // the user confirms them in the panel (ai/changes/engine.ts).
  // Cached and refreshed near expiry by federation.ts; Bedrock (account mode) asks it per LLM request.
  const accountCredentials = (accountId: string) => {
    const account = accounts.get(accountId)
    if (!account) throw new Error('账号已删除')
    const via = account.kind === 'assume' ? accounts.get(account.viaId ?? '') : undefined
    return getAccountCredentials(account, via)
  }
  const aiConfig = new AiConfigStore(path.join(app.getPath('userData'), 'ai-config.json'))
  const awsClients = new AwsClients(async (accountId) => {
    try {
      return await accountCredentials(accountId)
    } catch (err) {
      // Same toast as a failed login; the tool also reports it to the model. A command's stderr may echo credentials.
      toasts.show('error', redactSecrets(err instanceof Error ? err.message : String(err)))
      throw err
    }
  }, () => aiConfig.get().awsCliPath)
  let aiDb
  try {
    aiDb = openAiDb()
  } catch (err) {
    // Left untouched (e.g. written by a newer version); this run keeps chats in memory only.
    aiDb = openAiDb(':memory:')
    toasts.show('error', `AI 对话库无法打开，本次对话不会保存：${err instanceof Error ? err.message : String(err)}`)
  }
  const ai = new AiService({
    store: new AiStore(aiDb),
    config: aiConfig,
    keys: new KeyStore(),
    models: createConfiguredModels(),
    account: (id) => accounts.get(id),
    aws: (accountId, ...call) => awsClients.call(accountId, ...call),
    awsCli: (accountId, service, action, params, region) => awsClients.callCli(accountId, service, action, params, region),
    awsSupports: (service, action) => awsClients.supports(service, action),
    awsInputMembers: (service, action) => awsClients.inputMembers(service, action),
    awsCliAvailable: () => findAwsCli(aiConfig.get().awsCliPath),
    // No toast here: a failed Bedrock request already reports the error (explained) in the panel and a toast.
    credentials: async (accountId) => accountCredentials(accountId),
    regionFor: (id) => {
      const region = consoleRegion(views.returnUrl(id) ?? '')
      return region && REGIONS.some((r) => r.id === region) ? region : (accounts.get(id)?.defaultRegion ?? 'us-east-1')
    },
    activePage: (id) => views.activePage(id),
    recents: () => recents.list(),
    readPage: (id) => readCurrentPage(views.onScreenTab(), id),
    emit: (e) => send('ai:event', e),
    openConsole: navigateConsole,
    toast: (message) => toasts.show('error', message),
    runKeyCommand
  })
  // Retention (AI 设置 → 数据与隐私): at start, daily, and at quit, where "不保留" clears the conversations.
  const maintainAi = (boundary: boolean): void => {
    try {
      ai.maintain(boundary)
    } catch (err) {
      console.error('AI retention failed:', err instanceof Error ? err.message : err)
    }
  }
  maintainAi(true)
  setInterval(() => maintainAi(false), 24 * 3600_000).unref()
  app.on('will-quit', () => maintainAi(true))
  // Links in replies: console pages through the same path as console:navigate; other web links by the tab policy.
  registerAiIpc(win, ai, (accountId, url) => {
    void tabAction(async () => {
      if (isConsoleUrl(url)) return navigateConsole(accountId, url)
      const action = windowOpenAction(url)
      if (action === 'tab' && views.openTab(accountId, url, true)) return
      if (action === 'tab' || action === 'external') await shell.openExternal(url)
    })
  })
  ipcMain.on('console:bounds', (_e, rect: Rect) => void tabAction(() => views.setBounds(rect)))
  ipcMain.on('console:visible', (_e, visible: boolean) => void tabAction(() => views.setConsoleVisible(visible)))
  ipcMain.on('console:focus', () => void tabAction(() => views.focus()))
  ipcMain.on('console:back', () => void tabAction(() => {
    logActivity({ type: 'back', accountId: views.activeId })
    views.goBack()
  }))
  ipcMain.on('console:forward', () => void tabAction(() => {
    logActivity({ type: 'forward', accountId: views.activeId })
    views.goForward()
  }))
  ipcMain.on('console:reload', () => void tabAction(() => {
    logActivity({ type: 'reload', accountId: views.activeId })
    views.reload()
  }))
  ipcMain.on('console:find', (_e, text: string, options: FindOptions) => void tabAction(() => views.find(text, options)))
  ipcMain.on('console:find-stop', () => void tabAction(() => views.stopFind()))
  ipcMain.on('tabs:activate', (_e, tabId: unknown) => void tabAction(() => {
    if (Number.isInteger(tabId)) views.activateTab(tabId as number)
  }))
  ipcMain.on('tabs:close', (_e, tabId: unknown) => void tabAction(() => {
    if (Number.isInteger(tabId)) views.closeTab(tabId as number)
  }))
  ipcMain.handle('recents:list', () => recents.list())
  ipcMain.handle('recents:pin', (_e, key: string, pinned: boolean) => {
    logActivity({ type: 'pin', key, pinned })
    recents.setPinned(key, pinned)
  })
  ipcMain.handle('recents:delete', (_e, key: string) => recents.remove(key))
  // Renderer-side actions the main process can't see: what was typed into ⌘K
  // and what (if anything) was picked.
  ipcMain.on('activity:log', (_e, event: ActivityEvent) => logActivity(event))
  ipcMain.on('toast:show', (_e, message: unknown) => {
    if (typeof message === 'string' && message) toasts.show('error', message)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// package.json's productName is what the OS shows, but it also renames the
// default userData directory: the packaged app would move userData to
// "AWS Console Hub" and orphan the accounts, recents and login sessions
// created while running from source. Pin the path to the package name.
app.setPath('userData', path.join(app.getPath('appData'), 'aws-console-hub'))

// Some auth flows reject non-browser user agents. Setting the fallback covers
// every webContents, including popups, which do not inherit a per-view override.
app.userAgentFallback = app.userAgentFallback
  .replace(/ aws-console-hub\/[^ ]+/i, '')
  .replace(/ Electron\/[^ ]+/, '')

// Session partitions are exclusive: a second instance fighting over the same
// LevelDB LOCK files floods the log with IndexedDB errors and can corrupt
// state. Hand over to the running instance instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  app.whenReady().then(createWindow)
}

// Single-window app: quitting when the window closes keeps IPC wiring simple.
app.on('window-all-closed', () => app.quit())
