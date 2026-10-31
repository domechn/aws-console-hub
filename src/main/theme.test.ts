import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const command = vi.hoisted(() => ({ calls: [] as ((error: Error | null, stdout: string) => void)[] }))
vi.mock('node:child_process', () => ({
  execFile: (_bin: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string) => void) => { command.calls.push(callback) }
}))
import { readThemePreference, saveThemePreference, themeBackground, backgroundForPreference, resolvedSystemDark, readSystemDark } from './theme'

describe('native theme background', () => {
  it('coalesces concurrent OS reads and permits a fresh read on later focus', () => {
    command.calls.length = 0
    const values: boolean[] = []
    readSystemDark('linux', (dark) => values.push(dark))
    readSystemDark('linux', (dark) => values.push(dark))
    expect(command.calls).toHaveLength(1)
    command.calls[0](null, "'prefer-dark'")
    expect(values).toEqual([true, true])
    readSystemDark('linux', (dark) => values.push(dark))
    expect(command.calls).toHaveLength(2)
    command.calls[1](null, "'default'")
    expect(values).toEqual([true, true, false])
  })
  it('reads the OS value before a forced Chromium preference on first and recreated windows', () => {
    expect(resolvedSystemDark('darwin', true, 'Dark')).toBe(true)
    expect(resolvedSystemDark('darwin', false, 'Light')).toBe(false)
    expect(resolvedSystemDark('linux', true)).toBe(true)
    expect(resolvedSystemDark('win32', false)).toBe(false)
  })
  it('matches the resolved dark and light shell colours', () => {
    expect(themeBackground(true)).toBe('#15191e')
    expect(themeBackground(false)).toBe('#ffffff')
  })
  it('paints dark chrome for dark or a dark system while console pages stay light', () => {
    expect(backgroundForPreference('dark', false)).toBe('#15191e')
    expect(backgroundForPreference('system', true)).toBe('#15191e')
    expect(backgroundForPreference('light', true)).toBe('#ffffff')
  })
  it('uses system on first launch and reads the saved choice before window creation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-test-'))
    try {
      expect(readThemePreference(dir)).toBe('system')
      saveThemePreference(dir, 'dark')
      expect(readThemePreference(dir)).toBe('dark')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
