import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8') + readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const AI_START = '/* ---------- AI assistant ---------- */'

/** One {selector, declaration} per line of a rule body, comments dropped. */
function declarations(source: string): string[] {
  return source
    .replace(/\/\*[^]*?\*\//g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes(':') && l.endsWith(';'))
}

// sRGB relative luminance and WCAG contrast.
const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const token = (name: string): string => css.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))![1]
const lightTokens = Object.fromEntries([...css.slice(css.indexOf(':root {'), css.indexOf('html,')).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
const darkBlock = css.match(/\[data-theme=['"]?dark['"]?\]\s*\{([^}]+)\}/)?.[1] ?? ''
const darkTokens = Object.fromEntries([...darkBlock.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
const darkToken = (name: string): string => darkTokens[name] as string

describe('AI panel CSS (plan ai-ux-redesign §3.18)', () => {
  it('defines every light colour token in dark mode and keeps text, states, and focus readable', () => {
    expect(Object.keys(darkTokens).sort()).toEqual(Object.keys(lightTokens).sort())
    for (const bg of ['bg', 'bg-sunken', 'bg-raised', 'bg-hover', 'bg-active']) {
      for (const text of ['text', 'text-dim']) expect(contrast(darkToken(text), darkToken(bg)), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
    for (const [fg, bg] of [['on-accent', 'accent'], ['warn-ink', 'warn-bg'], ['danger', 'danger-bg'], ['ok', 'ok-bg'], ['focus', 'bg'], ['focus', 'bg-raised'], ['pin', 'bg']]) {
      expect(contrast(darkToken(fg), darkToken(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light;/)
    expect(darkBlock).toMatch(/color-scheme:\s*dark;/)
  })

  it('uses tokens for all app chrome and toast colours, including focus rings', () => {
    const chrome = declarations(css.slice(css.indexOf('html,'), css.indexOf(AI_START)))
      .filter((d) => !d.startsWith('mask-image'))
      .filter((d) => /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|(^|[\s:(,])(white|black)([\s;,)]|$)/i.test(d))
    expect(chrome).toEqual([])
    const toast = readFileSync(new URL('./toast.css', import.meta.url), 'utf8')
    expect(declarations(toast).filter((d) => /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i.test(d))).toEqual([])
    expect(css).toMatch(/html :is\(button, input, select, textarea, \[tabindex\]\):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/)
  })
  it('uses only tokens: no hard-coded colour in the AI section', () => {
    expect(css).toContain(AI_START)
    const colours = declarations(css.slice(css.indexOf(AI_START)))
      // A mask's #000 is opacity, not a colour.
      .filter((d) => !d.startsWith('mask-image'))
      .filter((d) => /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|(^|[\s:(,])(white|black)([\s;,)]|$)/i.test(d))
    expect(colours).toEqual([])
  })

  it('the aliases exist, and secondary text reads at 4.5:1 or more where it sits', () => {
    for (const name of ['warn', 'warn-ink', 'warn-bg', 'warn-border', 'danger-bg', 'ok-bg', 'on-accent', 'rule', 'focus', 'popover-shadow', 'mono']) {
      expect(css).toMatch(new RegExp(`--${name}: `))
    }
    for (const bg of ['bg', 'bg-sunken', 'bg-hover']) expect(contrast(token('text-dim'), token(bg))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('warn-ink'), token('warn-bg'))).toBeGreaterThanOrEqual(4.5)
    // The send button: white on the accent, clearly enabled.
    expect(contrast(token('on-accent'), token('accent'))).toBeGreaterThanOrEqual(4.5)
  })

  it('the input grows from one line to eight, then scrolls', () => {
    const rule = css.slice(css.indexOf('.ai-composer textarea {'))
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/field-sizing: content;[^]*min-height: calc\(1lh \+ 12px\);[^]*max-height: calc\(8lh \+ 12px\);/)
  })

  it('shows rejected rows above three rows of scrollable chips and stacks them at 320px', () => {
    expect(css).toMatch(/\.ai-attachment-chips \{[^}]*max-height: 190px;[^}]*overflow-y: auto;/)
    expect(css).toMatch(/\.ai-attachment-chips \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
    expect(css).toMatch(/\.ai-attachment-chip\.file \{[^}]*grid-column: 1 \/ -1;/)
    expect(css).toMatch(/\.ai-attachment-chip\.file \.ai-file-icon \{[^}]*width: 48px;/)
    expect(css).toMatch(/\.ai-attachment-chip\.file \.ai-attachment-name \{[^}]*min-width: 8ch;/)
    expect(css).toMatch(/\.ai-attachment-chip img \{[^}]*border: 1px solid var\(--border-strong\);/)
    expect(css).toMatch(/@container ai-composer \(max-width: 359px\) \{[^}]*\.ai-attachment-chips \{ grid-template-columns: minmax\(0, 1fr\)/)
    expect(css).toMatch(/\.ai-lightbox \{[^}]*position: fixed;/)
    expect(css).toMatch(/\.ai-lightbox button:focus-visible \{ outline: 2px solid var\(--focus\)/)
    expect(css).toMatch(/\.ai-attachment-privacy \{[^}]*text-wrap: balance;/)
    expect(css).toMatch(/\.ai-msg-image-frame \{[^}]*width: 96px;[^}]*height: 96px;/)
    expect(css).toMatch(/\.ai-msg-image-frame img \{[^}]*object-fit: cover;[^}]*object-position: top center;/)
    expect(css).toMatch(/\.ai-lightbox-stage img \{[^}]*object-fit: contain;/)
    expect(lightTokens.backdrop).toBe('rgba(0, 0, 0, 0.72)')
    expect(darkTokens.backdrop).toBe('rgba(0, 0, 0, 0.72)')
  })

  it('shows composer textarea focus on the rounded container without an inner outline', () => {
    expect(css).toMatch(/\.ai-composer:focus-within\s*\{[^}]*border-color:\s*var\(--accent\);[^}]*box-shadow:\s*0 0 0 [23]px color-mix\(in srgb, var\(--accent\) \d+%, transparent\);/)
    expect(css).toMatch(/html \.ai-panel \.ai-composer textarea:focus-visible\s*\{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/)
    expect(css).toMatch(/\.ai-composer button:focus-visible,[^}]*outline:\s*2px solid var\(--accent\)/)
  })

  it('change table values wrap and long labels cannot squeeze them out', () => {
    expect(css).toMatch(/\.ai-change-table td,\n\.ai-change-table th \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/)
    expect(css).toMatch(/\.ai-change \.ai-kv \{[^}]*grid-template-columns: minmax\(0, 1fr\);/)
  })

  it('only model tables switch to a list at 340px; usage stays reachable', () => {
    expect(css).toMatch(/@container ai-panel \(max-width: 340px\) \{\n  \.ai-model-table-scroll \{\n    display: none;/)
    expect(css).not.toMatch(/@container ai-panel \(max-width: 340px\) \{\n  \.ai-table-scroll \{\n    display: none;/)
    expect(css).not.toMatch(/@container ai-panel \(max-width: 340px\) \{\n  \.ai-cost-chip \{\n    display: none;/)
  })

  it('the model footer gives both usage lines room to wrap', () => {
    expect(css).toMatch(/\.ai-pop-ft \{[^}]*flex-wrap: wrap;/)
    expect(css).toMatch(/\.ai-pop-ft > span:not\(\.ai-spacer\) \{[^}]*flex: 1 0 100%;/)
  })

  it('fits ordinary markdown tables at 320, 400 and 640px and contains wide tables at narrow widths', () => {
    const table = css.match(/\.md table \{([^}]+)\}/)?.[1] ?? ''
    const cell = css.match(/\.md th,\s*\.md td \{([^}]+)\}/)?.[1] ?? ''
    const code = css.match(/\.md :not\(pre\) > code \{([^}]+)\}/)?.[1] ?? ''
    expect(table).toMatch(/width: 100%;/)
    expect(table).toMatch(/table-layout: fixed;/)
    expect(table).not.toMatch(/display: block|overflow-x/)
    expect(cell).toMatch(/white-space: normal;/)
    expect(cell).toMatch(/overflow-wrap: anywhere;/)
    expect(code).toMatch(/white-space: pre-wrap;/)
    expect(code).toMatch(/overflow-wrap: anywhere;/)
    expect(css).toMatch(/\.md tr:nth-child\(even\) \{[^}]*color-mix\(in srgb, var\(--bg-hover\) \d+%, var\(--bg\)\)/)
    expect(css).toMatch(/@container ai-panel \(max-width: 420px\) \{[^]*?\.md-table:has\(tr > :nth-child\(4\)\) table \{[^}]*min-width: 560px;/)
    expect(css).toMatch(/\.md-table \{[^}]*overflow-x: auto;[^}]*padding-right: 1px;/)
    expect(css).not.toMatch(/\.md-table:has\(tr > :nth-child\(4\)\) \{[^}]*box-shadow:/)
  })

  it('does not reserve space for a hidden user action bar or an empty assistant item', () => {
    expect(css).toMatch(/\.ai-user-turn \{[^}]*position: relative;/)
    expect(css).toMatch(/\.ai-message-actions\.user \{[^}]*position: absolute;/)
    expect(css).toMatch(/\.ai-assistant-turn:empty \{[^}]*display: none;/)
  })

  it('keeps the hidden user bar out of hit testing and clears the first message top edge', () => {
    expect(css).toMatch(/\.ai-message-actions\.user \{[^}]*opacity: 0;[^}]*pointer-events: none;/)
    expect(css).toMatch(/\.ai-user-turn:hover \.ai-message-actions,[^}]*\.ai-user-turn:focus-within \.ai-message-actions \{[^}]*opacity: 1;[^}]*pointer-events: auto;/)
    expect(css).toMatch(/\.ai-messages > \.ai-user-turn:first-child \{[^}]*margin-top: 24px;/)
  })

  it('reserves the user action bar height only for later turns with actions', () => {
    // Measure getBoundingClientRect() for adjacent assistant actions, user turn and user bar
    // in a 400px .ai-messages container: the 10px gap needs 16px more for the 24px bar.
    expect(css).toMatch(/\.ai-messages \{[^}]*gap: 10px;/)
    expect(css).toMatch(/\.ai-messages > \.ai-user-turn:not\(:first-child\):has\(> \.ai-message-actions\.user\) \{[^}]*margin-top: 16px;/)
    expect(css).toMatch(/\.ai-message-actions\.user \{[^}]*position: absolute;/)
    expect(css).toMatch(/\.ai-user-turn:hover \.ai-message-actions,[^}]*\.ai-user-turn:focus-within \.ai-message-actions \{[^}]*opacity: 1;/)
  })

  it('truncates only the model identifier while preserving usage and cost', () => {
    expect(css).toMatch(/\.ai-message-meta \{[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*white-space: nowrap;/)
    expect(css).toMatch(/\.ai-message-model \{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/)
    expect(css).toMatch(/\.ai-message-usage \{[^}]*flex-shrink: 0;/)
  })
})
