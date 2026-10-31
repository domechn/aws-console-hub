import type { ChangeEvent } from 'react'
import type { Api, ToastApi } from '../../shared/api'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const KEY = 'appTheme'
const EVENT = 'app-theme-change'
const CHANNEL = 'app-theme'

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}

export function preferenceFromEvent(value: unknown): ThemePreference | undefined {
  return value === 'system' || value === 'light' || value === 'dark' ? value : undefined
}

export function getThemePreference(): ThemePreference {
  const source = window as Window & { api?: Api; toastApi?: ToastApi; themePreferenceOverride?: ThemePreference }
  if (source.themePreferenceOverride) return source.themePreferenceOverride
  const main = (source.api ?? source.toastApi)?.themePreference
  if (main) return main
  const value = localStorage.getItem(KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function setThemePreference(preference: ThemePreference): void {
  ;(window as Window & { themePreferenceOverride?: ThemePreference }).themePreferenceOverride = preference
  localStorage.setItem(KEY, preference)
  window.dispatchEvent(new Event(EVENT))
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage(preference)
  channel.close()
}

/** Each renderer applies the preference locally; the toast is a separate WebContentsView. */
export function observeTheme(onChange?: (preference: ThemePreference, resolved: ResolvedTheme) => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const themeWindow = window as Window & { api?: Api; toastApi?: ToastApi; themePreferenceOverride?: ThemePreference }
  const themeApi = themeWindow.api ?? themeWindow.toastApi
  let systemDark = themeApi?.systemDark ?? media.matches
  const channel = new BroadcastChannel(CHANNEL)
  const apply = (preference = getThemePreference()): void => {
    const resolved = resolveTheme(preference, systemDark)
    document.documentElement.dataset.theme = resolved
    onChange?.(preference, resolved)
  }
  const fromStorage = (event: StorageEvent): void => {
    if (event.key === KEY) {
      const preference = preferenceFromEvent(event.newValue)
      if (preference) {
        themeWindow.themePreferenceOverride = preference
        apply(preference)
      }
    }
  }
  const fromChannel = (event: MessageEvent<ThemePreference>): void => {
    const preference = preferenceFromEvent(event.data)
    if (preference) {
      themeWindow.themePreferenceOverride = preference
      apply(preference)
    }
  }
  const update = (): void => { if (!themeApi) systemDark = media.matches; apply() }
  const offSystem = themeApi?.onSystemDark((dark) => { systemDark = dark; apply() })
  apply()
  if (!offSystem) media.addEventListener('change', update)
  window.addEventListener(EVENT, update)
  window.addEventListener('storage', fromStorage)
  channel.addEventListener('message', fromChannel)
  return () => {
    channel.close()
    offSystem?.()
    if (!offSystem) media.removeEventListener('change', update)
    window.removeEventListener(EVENT, update)
    window.removeEventListener('storage', fromStorage)
  }
}

export function ThemeSetting({ value, onChange }: { value: ThemePreference; onChange: (value: ThemePreference) => void }): React.JSX.Element {
  return (
    <>
      <label>
        主题
        <select value={value} onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value as ThemePreference)}>
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </label>
      <p className="modal-hint">仅应用界面使用此主题；内嵌的 AWS Console 页面由 AWS 提供，不会跟随切换。</p>
    </>
  )
}
