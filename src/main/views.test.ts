import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

let nextId = 1
const made: FakeView[] = []

class FakeContents extends EventEmitter {
  id = nextId++
  destroyed = false
  url = ''
  loading = false
  reloads = 0
  windowOpenHandler?: (input: { url: string; disposition: string }) => { action: string }
  session = {
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {}
  }
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} }
  isDestroyed(): boolean { return this.destroyed }
  getURL(): string { return this.url }
  getTitle(): string { return '' }
  isLoading(): boolean { return this.loading }
  setWindowOpenHandler(handler: (input: { url: string; disposition: string }) => { action: string }): void {
    this.windowOpenHandler = handler
  }
  focus(): void {}
  stopFindInPage(): void {}
  reload(): void { this.reloads++ }
  close(): void { this.destroyed = true; setImmediate(() => this.emit('destroyed')) }
  loadURL(url: string): Promise<void> { this.url = url; this.loading = true; this.emit('did-start-loading'); return Promise.resolve() }
}

class FakeView {
  webContents: FakeContents | undefined = new FakeContents()
  visible = false
  boundsSet = 0
  constructor() {
    if (failNextView) { failNextView = false; throw new Error('failed to create view') }
    made.push(this)
  }
  setBackgroundColor(): void {}
  setBounds(): void { this.boundsSet++ }
  setVisible(visible: boolean): void { this.visible = visible }
}

let failNextView = false
const clearStorageData = vi.fn(async () => {})
vi.doMock('electron', () => ({ WebContentsView: FakeView, session: { fromPartition: () => ({ clearStorageData }) } }))
const { ViewManager } = await import('./views')

function setup() {
  nextId = 1
  made.length = 0
  failNextView = false
  clearStorageData.mockClear()
  const states: Array<{ accountId: string; activeTabId: number; loading: boolean; tabs: Array<{ id: number; loading: boolean }> }> = []
  const signedOut: Array<{ accountId: string; tabId: number; returnTo: string | undefined }> = []
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), { focus: () => {} }),
    contentView: { addChildView: () => {}, removeChildView: () => {} }
  })
  const manager = new ViewManager(win as never, {
    onNavState: (state) => states.push(state),
    onNavigated: () => {},
    onSignedOut: (accountId, tabId, returnTo) => signedOut.push({ accountId, tabId, returnTo }),
    onPalette: () => {},
    onAccountSwitcher: () => {},
    onSwitchAccount: () => {},
    onFind: () => {},
    onToggleRecents: () => {},
    onAssistant: () => {},
    onFindClose: () => {},
    onFindResult: () => {},
    onTabAdded: () => {}
  })
  const account = { id: 'account' } as never
  manager.show(account)
  return { manager, account, states, signedOut, win }
}

describe('ViewManager destroyed tabs', () => {
  it('tolerates a missing webContents in tab lookup, activation, cycling, and nav state', () => {
    const { manager, states, win } = setup()
    const first = made[0]
    expect(manager.openTab('account', 'https://console.aws.amazon.com/', true)).toBe(true)
    const second = made[1]
    first.webContents = undefined
    expect(() => {
      win.webContents.emit('before-input-event', { preventDefault: () => {} }, {
        type: 'keyDown', key: 'Tab', code: 'Tab', control: true, meta: false, shift: false, alt: false
      })
      manager.activateTab(second.webContents!.id)
      manager.closeTab(999)
      manager.goBack()
      manager.focus()
      manager.hasContent('account')
      manager.setConsoleVisible(true)
      manager.closeTab(second.webContents!.id)
    }).not.toThrow()
    expect(states.at(-1)?.tabs.map((tab) => tab.id)).toEqual([second.webContents!.id])
  })

  it('removes a destroyed active tab and activates its neighbour', () => {
    const { manager, states } = setup()
    const first = made[0]
    manager.openTab('account', 'https://console.aws.amazon.com/', true)
    const second = made[1]
    const firstId = first.webContents!.id
    const contents = second.webContents!
    contents.destroyed = true
    second.webContents = undefined
    contents.emit('destroyed')
    expect(states.at(-1)?.activeTabId).toBe(firstId)
    expect(states.at(-1)?.tabs.map((tab) => tab.id)).toEqual([firstId])
  })

  it('replaces the final destroyed tab, loads its saved Console URL, and ignores stale ids', async () => {
    const { manager, states } = setup()
    const first = made[0]
    const oldId = first.webContents!.id
    first.webContents!.emit('did-navigate', {}, 'https://console.aws.amazon.com/')
    expect(manager.returnUrl('account', oldId)).toBe('https://console.aws.amazon.com/')
    first.webContents!.close()
    first.webContents = undefined
    // close() reports destruction on a later turn, after webContents is gone.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(made).toHaveLength(2)
    expect(states.at(-1)?.tabs.map((tab) => tab.id)).toEqual([made[1].webContents!.id])
    expect(made[1].webContents!.url).toBe('https://console.aws.amazon.com/')
    expect(states.at(-1)?.loading).toBe(true)
    expect(manager.returnUrl('account', oldId)).toBeUndefined()
    expect(() => { manager.closeTab(oldId); manager.activateTab(oldId) }).not.toThrow()
    expect(states.at(-1)?.activeTabId).toBe(made[1].webContents!.id)
  })

  it('keeps the saved return URL when the replacement redirects straight to sign-in', async () => {
    const { manager, signedOut } = setup()
    const first = made[0].webContents!
    first.emit('did-navigate', {}, 'https://console.aws.amazon.com/ec2/home')
    first.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const next = made[1].webContents!
    next.emit('did-navigate', {}, 'https://signin.aws.amazon.com/signin')
    expect(signedOut).toEqual([{
      accountId: 'account',
      tabId: next.id,
      returnTo: 'https://console.aws.amazon.com/ec2/home'
    }])
    expect(manager.returnUrl('account')).toBe('https://console.aws.amazon.com/ec2/home')
  })

  it('treats an active view with missing webContents as no current page', () => {
    const { manager } = setup()
    made[0].webContents = undefined
    expect(manager.onScreenTab()).toBeNull()
    expect(manager.activePage('account')).toBeNull()
    expect(() => { manager.reload(); manager.goForward(); manager.stopFind() }).not.toThrow()
  })

  it('closes an active tab across a stale neighbour', () => {
    const { manager, states } = setup()
    manager.openTab('account', 'https://console.aws.amazon.com/', false)
    manager.openTab('account', 'https://console.aws.amazon.com/', false)
    const lastId = made[2].webContents!.id
    made[1].webContents = undefined
    manager.closeTab(made[0].webContents!.id)
    expect(states.at(-1)?.activeTabId).toBe(lastId)
  })

  it('keeps a tab after its renderer crashes so it can reload', () => {
    const { manager, states } = setup()
    const wc = made[0].webContents!
    const before = states.length
    wc.emit('render-process-gone')
    expect(states).toHaveLength(before + 1)
    expect(states.at(-1)?.loading).toBe(false)
    manager.reload()
    expect(states.at(-1)?.tabs.map((tab) => tab.id)).toEqual([wc.id])
    expect(wc.reloads).toBe(1)
    expect(wc.listenerCount('render-process-gone')).toBeGreaterThan(0)
  })

  it('ignores a destroyed event delivered after closeTab removed the view', async () => {
    const { manager, states } = setup()
    manager.openTab('account', 'https://console.aws.amazon.com/', true)
    const closing = made[1].webContents!
    manager.closeTab(closing.id)
    const before = states.length
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(states).toHaveLength(before)
    expect(made).toHaveLength(2)
    expect(states.at(-1)?.tabs.map((tab) => tab.id)).toEqual([made[0].webContents!.id])
  })

  it('chooses the next live neighbour after stale views are pruned', () => {
    const { manager, states } = setup()
    for (let i = 0; i < 4; i++) manager.openTab('account', 'https://console.aws.amazon.com/', true)
    made[0].webContents = undefined
    const lost = made[2].webContents!
    manager.activateTab(lost.id)
    lost.destroyed = true
    lost.emit('destroyed')
    expect(states.at(-1)?.activeTabId).toBe(made[3].webContents!.id)
  })

  it('hides and resizes an attached view even after its contents died', () => {
    const { manager } = setup()
    made[0].visible = true
    made[0].webContents = undefined
    manager.setConsoleVisible(false)
    manager.setBounds({ x: 1, y: 2, width: 3, height: 4 })
    expect(made[0].visible).toBe(false)
    expect(made[0].boundsSet).toBe(2)
  })

  it('does not throw or repeatedly recreate when replacement construction fails', () => {
    const { manager } = setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    failNextView = true
    const wc = made[0].webContents!
    wc.destroyed = true
    expect(() => wc.emit('destroyed')).not.toThrow()
    expect(made).toHaveLength(1)
    manager.show({ id: 'account' } as never)
    expect(made).toHaveLength(2)
    expect(log).toHaveBeenCalledWith('Tab recreation failed')
    log.mockRestore()
  })

  it('contains a deferred window-open failure inside the tab wrapper', async () => {
    setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    failNextView = true
    expect(made[0].webContents!.windowOpenHandler!({
      url: 'https://console.aws.amazon.com/',
      disposition: 'foreground-tab'
    })).toEqual({ action: 'deny' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(made).toHaveLength(1)
    expect(log).toHaveBeenCalledWith('Deferred tab open failed')
    log.mockRestore()
  })

  it('does not recreate a tab while the window is closing', async () => {
    const { win } = setup()
    win.emit('close')
    made[0].webContents!.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(made).toHaveLength(1)
  })

  it('removes account tabs without recreating them after asynchronous destruction', async () => {
    const { manager } = setup()
    manager.openTab('account', 'https://console.aws.amazon.com/', true)
    await manager.removeAccount('account')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(made).toHaveLength(2)
    expect(clearStorageData).toHaveBeenCalledOnce()
  })

  it('replaces a destroyed tab of a background account without changing the visible account', () => {
    const { manager, states } = setup()
    manager.show({ id: 'background' } as never)
    manager.show({ id: 'account' } as never)
    const background = made[1].webContents!
    background.destroyed = true
    background.emit('destroyed')
    expect(manager.activeId).toBe('account')
    expect(states.at(-1)?.accountId).toBe('background')
    expect(states.at(-1)?.activeTabId).toBe(made[2].webContents!.id)
  })
})
