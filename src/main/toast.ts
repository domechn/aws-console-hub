import { BrowserWindow, WebContentsView, clipboard } from 'electron'
import path from 'node:path'
import type { ToastKind } from '../shared/types'

const WIDTH = 380
const RIGHT = 8
/** Clears the 30px recents strip at the bottom of the window. */
const BOTTOM = 40
const MAX_MESSAGE = 4000

/**
 * Bottom-right toasts. The console tabs are native views painted over the
 * app's DOM, so a DOM toast would sit behind them; instead the toasts get
 * their own transparent view, kept topmost and sized to the stack the page
 * reports, so it only ever covers the toasts themselves. With no toasts it
 * is hidden and blocks nothing.
 */
export class ToastOverlay {
  private view: WebContentsView
  private height = 0
  private ready: Promise<void>

  /** `restoreFocus` hands the keyboard back to the app after a click in a toast. */
  constructor(
    private win: BrowserWindow,
    private restoreFocus: () => void
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/toast.js'),
        contextIsolation: true,
        sandbox: true
      }
    })
    this.view.setBackgroundColor('#00000000')
    const wc = this.view.webContents
    wc.on('will-navigate', (e) => e.preventDefault())
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))

    // wc.ipc only hears this view, so nothing else can resize it or write the clipboard.
    this.ready = new Promise((resolve) => wc.ipc.once('toast:ready', () => resolve()))
    wc.ipc.on('toast:size', (_e, height: unknown) => {
      if (typeof height !== 'number' || !Number.isFinite(height)) return
      this.height = Math.max(0, Math.ceil(height))
      this.layout()
    })
    wc.ipc.on('toast:copy', (_e, text: unknown) => {
      if (typeof text === 'string') clipboard.writeText(text.slice(0, MAX_MESSAGE))
      this.giveBackFocus()
    })
    wc.ipc.on('toast:dismissed', () => this.giveBackFocus())
    win.on('resize', () => this.layout())

    win.contentView.addChildView(this.view)
    this.layout()

    if (process.env['ELECTRON_RENDERER_URL']) {
      void wc.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/toast.html`)
    } else {
      void wc.loadFile(path.join(__dirname, '../renderer/toast.html'))
    }
  }

  show(kind: ToastKind, message: string): void {
    const toast = { kind, message: message.slice(0, MAX_MESSAGE) }
    void this.ready.then(() => {
      if (!this.view.webContents.isDestroyed()) this.view.webContents.send('toast:push', toast)
    })
  }

  setSystemDark(dark: boolean): void {
    if (!this.view.webContents.isDestroyed()) this.view.webContents.send('app:system-dark-changed', dark)
  }

  /** Back on top; call after adding any other child view to the window. */
  raise(): void {
    this.win.contentView.addChildView(this.view)
  }

  private giveBackFocus(): void {
    if (this.view.webContents.isFocused()) this.restoreFocus()
  }

  private layout(): void {
    if (this.win.isDestroyed()) return
    const [width, height] = this.win.getContentSize()
    const h = Math.min(this.height, Math.max(0, height - BOTTOM))
    // The width stays put even while hidden, so the page measures its stack at the real width.
    this.view.setBounds({ x: width - WIDTH - RIGHT, y: height - BOTTOM - h, width: WIDTH, height: h })
    this.view.setVisible(h > 0)
    if (h === 0) this.giveBackFocus()
  }
}
