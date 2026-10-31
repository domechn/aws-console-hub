/** App shortcuts intercepted in `before-input-event`, before the page or the menu sees them. */

export type Shortcut =
  | { kind: 'palette' }
  | { kind: 'account-switcher' }
  | { kind: 'find' }
  | { kind: 'recents' }
  | { kind: 'assistant' }
  | { kind: 'close-tab' }
  | { kind: 'next-tab' }
  | { kind: 'prev-tab' }
  | { kind: 'account'; index: number }

/** The subset of Electron's `Input` this needs. */
export interface KeyInput {
  type: string
  key: string
  code: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

/**
 * The letter/digit a shortcut means. `key` follows the keyboard layout, which
 * is what users expect, but a non-Latin layout or an active IME reports the
 * produced character (or "Process") instead of "f" — then the physical key
 * is the only usable signal.
 */
function shortcutKey(input: KeyInput): string {
  const key = input.key.toLowerCase()
  if (/^[a-z0-9]$/.test(key)) return key
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(input.code)
  return m ? (m[1] ?? m[2]).toLowerCase() : key
}

export function shortcutFor(input: KeyInput, mac: boolean): Shortcut | null {
  if (input.type !== 'keyDown' || input.alt) return null
  // Ctrl+Tab is the tab switcher on every platform, ⌘ or not.
  if (input.control && input.key === 'Tab') return { kind: input.shift ? 'prev-tab' : 'next-tab' }
  if (!(mac ? input.meta : input.control)) return null
  // ⇧[ / ⇧] report "{" / "}" as the key, so match the physical bracket.
  if (input.shift && input.code === 'BracketRight') return { kind: 'next-tab' }
  if (input.shift && input.code === 'BracketLeft') return { kind: 'prev-tab' }
  const key = shortcutKey(input)
  if (input.shift) return key === 'a' ? { kind: 'account-switcher' } : null
  if (key === 'k') return { kind: 'palette' }
  if (key === 'f') return { kind: 'find' }
  if (key === 'j') return { kind: 'recents' }
  if (key === 'i') return { kind: 'assistant' }
  if (key === 'w') return { kind: 'close-tab' }
  if (/^[1-9]$/.test(key)) return { kind: 'account', index: Number(key) - 1 }
  return null
}
