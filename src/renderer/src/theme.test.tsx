import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { observeTheme, resolveTheme, setThemePreference, ThemeSetting, getThemePreference, preferenceFromEvent } from './theme'

describe('theme preference', () => {
  it('accepts valid cross-window preferences and ignores invalid values', () => {
    expect(preferenceFromEvent('dark')).toBe('dark')
    expect(preferenceFromEvent('light')).toBe('light')
    expect(preferenceFromEvent('system')).toBe('system')
    expect(preferenceFromEvent(null)).toBeUndefined()
    expect(preferenceFromEvent('invalid')).toBeUndefined()
  })
  it('keeps a toast on the new theme for both cross-window event orders', () => {
    for (const order of [['storage', 'channel'], ['channel', 'storage']]) {
      const media = Object.assign(new EventTarget(), { matches: false })
      const win = Object.assign(new EventTarget(), { matchMedia: () => media, toastApi: { themePreference: 'light', systemDark: false, onSystemDark: () => () => {} } })
      const doc = { documentElement: { dataset: {} as Record<string, string> } }
      let channel!: EventTarget
      class TestChannel extends EventTarget {
        constructor(_name: string) { super(); channel = this }
        postMessage(): void {}
        close(): void {}
      }
      vi.stubGlobal('localStorage', { getItem: () => 'dark' })
      vi.stubGlobal('window', win)
      vi.stubGlobal('document', doc)
      vi.stubGlobal('BroadcastChannel', TestChannel)
      const stop = observeTheme()
      expect(doc.documentElement.dataset.theme).toBe('light')
      for (const source of order) {
        if (source === 'storage') win.dispatchEvent(Object.assign(new Event('storage'), { key: 'appTheme', newValue: 'dark' }))
        else channel.dispatchEvent(new MessageEvent('message', { data: 'dark' }))
        expect(doc.documentElement.dataset.theme).toBe('dark')
      }
      stop()
      vi.unstubAllGlobals()
    }
  })
  it('takes startup preference from main over a stale renderer cache', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'dark' })
    vi.stubGlobal('window', { api: { themePreference: 'light' } })
    expect(getThemePreference()).toBe('light')
    vi.unstubAllGlobals()
  })
  it('syncs the app and toast observers on preference and system changes', () => {
    const values = new Map<string, string>()
    const media = Object.assign(new EventTarget(), { matches: true })
    const win = Object.assign(new EventTarget(), { matchMedia: () => media })
    const doc = { documentElement: { dataset: {} as Record<string, string> } }
    const channels = new Set<TestChannel>()
    class TestChannel extends EventTarget {
      constructor(_name: string) { super(); channels.add(this) }
      postMessage(data: string): void { for (const other of channels) if (other !== this) other.dispatchEvent(new MessageEvent('message', { data })) }
      close(): void { channels.delete(this) }
    }
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    vi.stubGlobal('BroadcastChannel', TestChannel)
    const app: string[] = []
    const toast: string[] = []
    const stopApp = observeTheme((_, resolved) => app.push(resolved))
    const stopToast = observeTheme((_, resolved) => toast.push(resolved))
    expect([app.at(-1), toast.at(-1)]).toEqual(['dark', 'dark'])
    setThemePreference('light')
    expect([app.at(-1), toast.at(-1)]).toEqual(['light', 'light'])
    setThemePreference('system')
    media.matches = false
    media.dispatchEvent(new Event('change'))
    expect([app.at(-1), toast.at(-1)]).toEqual(['light', 'light'])
    stopApp()
    stopToast()
    vi.unstubAllGlobals()
  })
  it('resolves system preference and explicit light or dark choices', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
  it('uses the OS theme supplied by main while Chromium stays light for consoles', () => {
    const media = Object.assign(new EventTarget(), { matches: false })
    let notify!: (dark: boolean) => void
    const win = Object.assign(new EventTarget(), { matchMedia: () => media, api: { platform: 'darwin', systemDark: true, onSystemDark: (cb: (dark: boolean) => void) => { notify = cb; return () => {} } } })
    const doc = { documentElement: { dataset: {} as Record<string, string> } }
    vi.stubGlobal('localStorage', { getItem: () => 'system' })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    vi.stubGlobal('BroadcastChannel', class extends EventTarget { postMessage(): void {} close(): void {} })
    const stop = observeTheme()
    expect(doc.documentElement.dataset.theme).toBe('dark')
    notify(false)
    expect(doc.documentElement.dataset.theme).toBe('light')
    stop()
    vi.unstubAllGlobals()
  })
  it('uses main OS changes on Linux even when Chromium reports forced light', () => {
    const media = Object.assign(new EventTarget(), { matches: false })
    let notify!: (dark: boolean) => void
    const win = Object.assign(new EventTarget(), { matchMedia: () => media, api: { platform: 'linux', systemDark: true, onSystemDark: (cb: (dark: boolean) => void) => { notify = cb; return () => {} } } })
    const doc = { documentElement: { dataset: {} as Record<string, string> } }
    vi.stubGlobal('localStorage', { getItem: () => 'system' })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    vi.stubGlobal('BroadcastChannel', class extends EventTarget { postMessage(): void {} close(): void {} })
    const stop = observeTheme()
    expect(doc.documentElement.dataset.theme).toBe('dark')
    media.dispatchEvent(new Event('change'))
    expect(doc.documentElement.dataset.theme).toBe('dark')
    notify(false)
    expect(doc.documentElement.dataset.theme).toBe('light')
    notify(true)
    expect(doc.documentElement.dataset.theme).toBe('dark')
    stop()
    vi.unstubAllGlobals()
  })

  it('renders the setting and the native console limitation', () => {
    const html = renderToStaticMarkup(<ThemeSetting value="system" onChange={() => {}} />)
    expect(html).toContain('主题')
    expect(html).toContain('跟随系统')
    expect(html).toContain('浅色')
    expect(html).toContain('深色')
    expect(html).toContain('AWS Console 页面')
  })
})
