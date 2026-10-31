import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

export type ThemePreference = 'system' | 'light' | 'dark'

export function resolvedSystemDark(platform: NodeJS.Platform, nativeDark: boolean, macStyle?: string): boolean {
  return platform === 'darwin' && macStyle !== undefined ? macStyle === 'Dark' : nativeDark
}

/** Read the OS setting independently of Electron's app-wide forced light theme. */
const pendingSystemReads = new Map<NodeJS.Platform, ((dark: boolean) => void)[]>()
export function readSystemDark(platform: NodeJS.Platform, onResult: (dark: boolean) => void): void {
  const command = platform === 'win32'
    ? ['reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme']]
    : platform === 'linux' ? ['gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']] : null
  if (!command) return
  const pending = pendingSystemReads.get(platform)
  if (pending) return void pending.push(onResult)
  pendingSystemReads.set(platform, [onResult])
  execFile(command[0] as string, command[1] as string[], { timeout: 2000 }, (error, stdout) => {
    const listeners = pendingSystemReads.get(platform) ?? []
    pendingSystemReads.delete(platform)
    if (error) return
    let dark: boolean | undefined
    if (platform === 'win32') {
      const value = stdout.match(/AppsUseLightTheme\s+REG_DWORD\s+(0x[01])/i)?.[1]
      if (value) dark = value === '0x0'
    } else if (stdout.includes('prefer-dark')) dark = true
    else if (stdout.includes('prefer-light') || stdout.includes('default')) dark = false
    if (dark !== undefined) for (const listener of listeners) listener(dark)
  })
}

export function themeBackground(dark: boolean): string {
  return dark ? '#15191e' : '#ffffff'
}

export function backgroundForPreference(preference: ThemePreference, systemDark: boolean): string {
  return themeBackground(preference === 'dark' || (preference === 'system' && systemDark))
}

export function readThemePreference(userData: string): ThemePreference {
  try {
    const value = fs.readFileSync(path.join(userData, 'theme-preference'), 'utf8')
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function saveThemePreference(userData: string, preference: ThemePreference): void {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(path.join(userData, 'theme-preference'), preference)
}
