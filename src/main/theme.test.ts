import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readThemePreference, saveThemePreference, themeBackground, backgroundForPreference, resolvedSystemDark } from './theme'

describe('native theme background', () => {
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
