import { describe, expect, it } from 'vitest'
import { shortcutFor, type KeyInput } from './shortcuts'

const key = (k: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  type: 'keyDown',
  key: k,
  code,
  meta: false,
  control: false,
  shift: false,
  alt: false,
  ...mods
})

describe('shortcutFor', () => {
  it('maps ⌘ shortcuts on macOS and Ctrl elsewhere', () => {
    expect(shortcutFor(key('f', 'KeyF', { meta: true }), true)).toEqual({ kind: 'find' })
    expect(shortcutFor(key('f', 'KeyF', { control: true }), false)).toEqual({ kind: 'find' })
    expect(shortcutFor(key('f', 'KeyF', { control: true }), true)).toBeNull()
    expect(shortcutFor(key('k', 'KeyK', { meta: true }), true)).toEqual({ kind: 'palette' })
    expect(shortcutFor(key('w', 'KeyW', { meta: true }), true)).toEqual({ kind: 'close-tab' })
    expect(shortcutFor(key('j', 'KeyJ', { meta: true }), true)).toEqual({ kind: 'recents' })
    expect(shortcutFor(key('j', 'KeyJ', { control: true }), false)).toEqual({ kind: 'recents' })
    expect(shortcutFor(key('i', 'KeyI', { meta: true }), true)).toEqual({ kind: 'assistant' })
    expect(shortcutFor(key('i', 'KeyI', { control: true }), false)).toEqual({ kind: 'assistant' })
    expect(shortcutFor(key('I', 'KeyI', { meta: true, shift: true }), true)).toBeNull()
    expect(shortcutFor(key('3', 'Digit3', { meta: true }), true)).toEqual({ kind: 'account', index: 2 })
    expect(shortcutFor(key('A', 'KeyA', { meta: true, shift: true }), true)).toEqual({ kind: 'account-switcher' })
    expect(shortcutFor(key('A', 'KeyA', { control: true, shift: true }), false)).toEqual({ kind: 'account-switcher' })
    expect(shortcutFor(key('a', 'KeyA', { meta: true }), true)).toBeNull()
  })

  it('falls back to the physical key when the layout or IME hides the letter', () => {
    expect(shortcutFor(key('а', 'KeyF', { meta: true }), true)).toEqual({ kind: 'find' })
    expect(shortcutFor(key('Process', 'KeyF', { meta: true }), true)).toEqual({ kind: 'find' })
    expect(shortcutFor(key('ш', 'KeyI', { meta: true }), true)).toEqual({ kind: 'assistant' })
    expect(shortcutFor(key('F', 'KeyF', { meta: true }), true)).toEqual({ kind: 'find' })
  })

  it('switches tabs with ⌘⇧[ ] and Ctrl+Tab', () => {
    expect(shortcutFor(key('}', 'BracketRight', { meta: true, shift: true }), true)).toEqual({ kind: 'next-tab' })
    expect(shortcutFor(key('{', 'BracketLeft', { meta: true, shift: true }), true)).toEqual({ kind: 'prev-tab' })
    expect(shortcutFor(key('Tab', 'Tab', { control: true }), true)).toEqual({ kind: 'next-tab' })
    expect(shortcutFor(key('Tab', 'Tab', { control: true, shift: true }), true)).toEqual({ kind: 'prev-tab' })
  })

  it('ignores key-ups, plain keys and unrelated combos', () => {
    expect(shortcutFor({ ...key('f', 'KeyF', { meta: true }), type: 'keyUp' }, true)).toBeNull()
    expect(shortcutFor(key('f', 'KeyF'), true)).toBeNull()
    expect(shortcutFor(key('f', 'KeyF', { meta: true, alt: true }), true)).toBeNull()
    expect(shortcutFor(key('F', 'KeyF', { meta: true, shift: true }), true)).toBeNull()
    expect(shortcutFor(key('c', 'KeyC', { meta: true }), true)).toBeNull()
  })
})
