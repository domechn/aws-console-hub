import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
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

describe('AI panel CSS (plan ai-ux-redesign §3.18)', () => {
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
})
