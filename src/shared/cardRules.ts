/**
 * Card rules both processes need: form value checks (main decides, the form shows the same errors inline) and the
 * regex guard. Pure, no TypeBox, so the renderer can import it.
 */
import type { Field } from './cards'

/** Block types only main may put on a card (origin=system); render_card rejects them, the renderer ignores them elsewhere. */
export const SYSTEM_BLOCK_TYPES: readonly string[] = ['diff', 'consequences', 'risk', 'progress', 'error', 'request', 'change', 'analysis']

export const MAX_PATTERN = 100
export const MAX_TEXT_VALUE = 1000

/**
 * Why a form pattern is refused, or null. Patterns come from the model and run on every keystroke, so anything that
 * can backtrack exponentially is out: a quantified group that itself has a quantifier or an alternation
 * (`(a+)+`, `(a|aa)*`), and backreferences. Linear-ish patterns like `^[a-z0-9-]{1,63}$` are what forms need.
 */
export function patternError(p: string): string | null {
  if (p.length > MAX_PATTERN) return `正则不能超过 ${MAX_PATTERN} 个字符`
  if (/\\[1-9]|\\k</.test(p)) return '正则不能用反向引用'
  // One frame per open group: did it contain a quantifier or an alternation?
  const stack: { quant: boolean; alt: boolean }[] = [{ quant: false, alt: false }]
  const quantAt = (i: number): number => {
    const c = p[i]
    if (c === '*' || c === '+' || c === '?') return 1
    const m = c === '{' ? /^\{\d+(,\d*)?\}/.exec(p.slice(i)) : null
    return m ? m[0].length : 0
  }
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    const top = stack[stack.length - 1]
    if (c === '\\') i++
    else if (c === '[') {
      // Skip the class: quantifier characters inside it are literals.
      for (i++; i < p.length && p[i] !== ']'; i++) if (p[i] === '\\') i++
    } else if (c === '(') {
      stack.push({ quant: false, alt: false })
      // Group prefixes (?: (?= (?! (?<= (?<! (?<name> are not quantifiers.
      if (p[i + 1] === '?') {
        const named = /^\?<[A-Za-z_]\w*>/.exec(p.slice(i + 1))
        i += named ? named[0].length : p[i + 2] === '<' ? 3 : 2
      }
    } else if (c === ')') {
      const group = stack.pop()
      if (!group || stack.length === 0) return '正则括号不匹配'
      const q = quantAt(i + 1)
      if (q && (group.quant || group.alt)) return '正则不能有嵌套量词（如 (a+)+、(a|b)*）'
      stack[stack.length - 1].quant ||= group.quant || q > 0
    } else if (c === '|') top.alt = true
    else {
      const q = quantAt(i)
      if (q) {
        top.quant = true
        i += q - 1
      }
    }
  }
  if (stack.length !== 1) return '正则括号不匹配'
  try {
    new RegExp(`^(?:${p})$`, 'u')
  } catch {
    return '正则写法无效'
  }
  return null
}

/** A checked pattern, matching the whole value. */
export const fullMatch = (p: string): RegExp => new RegExp(`^(?:${p})$`, 'u')

/** What is wrong with one field's value, or null. `undefined` / '' mean "left empty". */
export function fieldError(f: Field, v: unknown): string | null {
  switch (f.type) {
    case 'text':
      if (v === undefined || v === '') return f.required ? '必填' : null
      if (typeof v !== 'string') return '需要文本'
      if (v.length > MAX_TEXT_VALUE) return `不能超过 ${MAX_TEXT_VALUE} 个字符`
      if (f.pattern && !(patternError(f.pattern) === null && fullMatch(f.pattern).test(v))) return '格式不符合要求'
      return null
    case 'number':
      if (v === undefined || v === '') return f.required ? '必填' : null
      if (typeof v !== 'number' || !Number.isFinite(v)) return '需要数字'
      if (f.min !== undefined && v < f.min) return `不能小于 ${f.min}`
      if (f.max !== undefined && v > f.max) return `不能大于 ${f.max}`
      return null
    case 'select':
      return typeof v === 'string' && f.options.some((o) => o.value === v) ? null : '请选择一个选项'
    case 'checkbox':
      return v === undefined || typeof v === 'boolean' ? null : '无效的勾选值'
  }
}

/** `{row}` in an action's url / text, filled with the clicked row's id (encoded for URLs; main re-checks the result). */
export const fillRow = (template: string, rowId: string | undefined, encode: boolean): string =>
  template.split('{row}').join(rowId === undefined ? '' : encode ? encodeURIComponent(rowId) : rowId)
