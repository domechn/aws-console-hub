/**
 * Card checks in main (plan §10): building a model card from render_card input, its lifecycle state, and checking
 * a click from the renderer. Pure. The schema says shapes; this file adds what it can't: origin, references,
 * console-only URLs, safe patterns, unique ids, form values.
 */
import { Value } from 'typebox/value'
import { fieldError, fillRow, patternError, SYSTEM_BLOCK_TYPES } from '../../shared/cardRules'
import {
  CARD_ACTION_PREFIX,
  CARD_LIMITS,
  CardSchema,
  MODEL_BLOCK_SCHEMAS,
  ModelCardInput,
  type Card,
  type CardAction,
  type CardState,
  type Field,
  type FormValues,
  type ModelCard
} from '../../shared/cards'
import { isConsoleUrl } from '../../shared/consoleUrl'

type Errors = { instancePath: string; message: string }[]
const errorLines = (prefix: string, errors: Errors): string[] => errors.slice(0, 8).map((e) => `${prefix}${e.instancePath || ''}: ${e.message}`)

const dupes = (values: string[]): string[] => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))]

/** Everything wrong with a render_card input, as lines the model can act on. Empty when it is fine. */
export function modelCardProblems(input: unknown, known: (cardId: string) => boolean): string[] {
  if (JSON.stringify(input ?? null).length > CARD_LIMITS.json) return [`卡片太大（JSON 超过 ${CARD_LIMITS.json} 字符），请减少行数或文字`]
  const blocks = (input as { blocks?: unknown })?.blocks
  if (Array.isArray(blocks)) {
    // Block by block, by its own schema: precise paths, and system-only types named as such.
    const problems = blocks.flatMap((b, i) => {
      const type = (b as { type?: unknown })?.type
      if (typeof type === 'string' && SYSTEM_BLOCK_TYPES.includes(type)) return [`/blocks/${i}: "${String(type)}" 块只能由应用生成，模型卡片里不能用`]
      const schema = typeof type === 'string' ? MODEL_BLOCK_SCHEMAS[type] : undefined
      if (!schema) return [`/blocks/${i}/type: 未知的块类型 ${JSON.stringify(type)}（可用：${Object.keys(MODEL_BLOCK_SCHEMAS).join(' ')}）`]
      return errorLines(`/blocks/${i}`, Value.Errors(schema, b) as Errors)
    })
    if (problems.length) return problems
  }
  if (!Value.Check(ModelCardInput, input)) return errorLines('', Value.Errors(ModelCardInput, input) as Errors)
  return ruleProblems(input as ModelCard, known)
}

function ruleProblems(m: ModelCard, known: (cardId: string) => boolean): string[] {
  const p: string[] = []
  const actions = m.actions ?? []
  const actionIds = new Set(actions.map((a) => a.id))
  for (const id of dupes(actions.map((a) => a.id))) p.push(`/actions: id "${id}" 重复`)
  const rowRefs = new Set<string>()
  const formRefs = new Set<string>()
  const rowIds: string[] = []
  m.blocks.forEach((b, i) => {
    const at = `/blocks/${i}`
    if (b.type === 'table') {
      for (const key of dupes(b.columns.map((c) => c.key))) p.push(`${at}/columns: key "${key}" 重复`)
      b.rows.forEach((r, j) => {
        rowIds.push(r.id)
        for (const a of r.actions ?? []) {
          rowRefs.add(a)
          if (!actionIds.has(a)) p.push(`${at}/rows/${j}/actions: 引用了不存在的 action "${a}"`)
        }
      })
    } else if (b.type === 'form') {
      for (const name of dupes(b.fields.map((f) => f.name))) p.push(`${at}/fields: name "${name}" 重复`)
      formRefs.add(b.submitActionId)
      const submit = actions.find((a) => a.id === b.submitActionId)
      if (!submit) p.push(`${at}/submitActionId: 引用了不存在的 action "${b.submitActionId}"`)
      else if (submit.kind !== 'reply') p.push(`${at}/submitActionId: 表单的提交按钮必须是 kind=reply`)
      for (const f of b.fields) {
        const bad = f.type === 'text' && f.pattern ? patternError(f.pattern) : null
        if (bad) p.push(`${at}/fields/${f.name}/pattern: ${bad}`)
        if (f.type === 'number' && f.min !== undefined && f.max !== undefined && f.min > f.max) p.push(`${at}/fields/${f.name}: min 大于 max`)
      }
    } else if (b.type === 'console-link' && !isConsoleUrl(b.url)) {
      p.push(`${at}/url: 只能链接到 AWS console 页面（https://…console.aws.amazon.com/…）`)
    }
  })
  for (const id of dupes(rowIds)) p.push(`行 id "${id}" 重复（同一张卡片里的行 id 必须唯一）`)
  for (const a of actions) {
    const at = `/actions/${a.id}`
    if (a.kind === 'open-console' && !(a.url && isConsoleUrl(fillRow(a.url, 'x', true)))) p.push(`${at}/url: open-console 需要 AWS console 页面的 https 地址`)
    if (a.kind === 'copy' && !a.text) p.push(`${at}/text: copy 按钮需要 text`)
    if (`${a.url ?? ''}${a.text ?? ''}`.includes('{row}') && !rowRefs.has(a.id)) p.push(`${at}: 含 {row} 的按钮只能用作表格行按钮`)
    if (formRefs.has(a.id) && rowRefs.has(a.id)) p.push(`${at}: 不能同时是表单提交按钮和行按钮`)
  }
  if (m.supersedes && !known(m.supersedes)) p.push(`/supersedes: 这个对话里没有卡片 "${m.supersedes}"`)
  return p
}

/** The card for a render_card call. Throws one message listing every problem: it is the tool result the model fixes the card from. */
export function buildModelCard(input: unknown, o: { id: string; now: number; known: (cardId: string) => boolean }): Card {
  const problems = modelCardProblems(input, o.known)
  if (problems.length) throw new Error(`卡片无效，请修正后重新调用 render_card：\n${problems.map((l) => `- ${l}`).join('\n')}`)
  const m = input as ModelCard
  // The lock marks main's own cards; a model title wearing one (or bidi / zero-width tricks) would pass for one.
  const title = m.title?.replace(/[\u{1F510}-\u{1F513}]|\p{Cf}/gu, '').trim()
  // Picked field by field: a model-supplied id, origin or state never makes it in.
  const card: Card = {
    v: 1,
    id: o.id,
    origin: 'model',
    ...(title && { title }),
    blocks: m.blocks,
    ...(m.actions?.length && { actions: m.actions }),
    createdAt: o.now,
    expiresAt: o.now + CARD_LIMITS.ttlMs,
    ...(m.supersedes && { supersedes: m.supersedes }),
    state: 'active'
  }
  if (!Value.Check(CardSchema, card)) throw new Error('卡片无效')
  return card
}

/** Resolved beats superseded beats expired. */
export function cardState(card: Card, now: number, resolved: boolean, superseded: boolean): CardState {
  return resolved ? 'resolved' : superseded ? 'superseded' : now > card.expiresAt ? 'expired' : 'active'
}

const STATE_ERRORS: Record<Exclude<CardState, 'active'>, string> = {
  resolved: '这张卡片已经处理过了',
  expired: '卡片已过期，请让助手重新生成',
  superseded: '这张卡片已被新卡片替代'
}

function formValues(fields: Field[], values: FormValues): FormValues {
  const names = new Set(fields.map((f) => f.name))
  for (const k of Object.keys(values)) if (!names.has(k)) throw new Error(`表单里没有字段 ${k}`)
  const out: FormValues = {}
  for (const f of fields) {
    const v = values[f.name]
    const error = fieldError(f, v)
    if (error) throw new Error(`${f.label}：${error}`)
    if (v !== undefined && v !== '') out[f.name] = v
    else if (f.type === 'checkbox') out[f.name] = false
  }
  return out
}

export type CheckedAction = { action: CardAction; url: string } | { action: CardAction; url?: undefined; values?: FormValues }

/**
 * A click from the renderer, against the card main stored (with its current state). Throws a user-facing message.
 * Copy actions never come here: the renderer copies by itself.
 */
export function checkCardAction(card: Card, actionId: string, rowId: string | undefined, values: FormValues | undefined): CheckedAction {
  if (card.state !== 'active') throw new Error(STATE_ERRORS[card.state])
  const action = card.actions?.find((a) => a.id === actionId)
  if (!action || action.kind === 'copy') throw new Error('卡片上没有这个按钮')
  const rows = card.blocks.flatMap((b) => (b.type === 'table' ? b.rows : []))
  if (rowId !== undefined) {
    if (!rows.some((r) => r.id === rowId && r.actions?.includes(actionId))) throw new Error('这一行没有这个按钮')
  } else if (rows.some((r) => r.actions?.includes(actionId))) throw new Error('这个按钮属于表格的某一行')
  const form = card.blocks.find((b) => b.type === 'form' && b.submitActionId === actionId)
  const checked = form?.type === 'form' ? formValues(form.fields, values ?? {}) : undefined
  if (!form && values && Object.keys(values).length) throw new Error('这个按钮不带表单值')
  if (action.kind === 'open-console') {
    const url = fillRow(action.url ?? '', rowId, true)
    if (!isConsoleUrl(url)) throw new Error('链接不是 AWS console 页面')
    return { action, url }
  }
  return { action, ...(checked && { values: checked }) }
}

export interface CardActionMessage {
  cardId: string
  action: string
  label: string
  row?: string
  values?: FormValues
}

/** The user turn a reply action becomes (§10.3); main writes it, the renderer only sent ids and values. */
export const cardActionText = (m: CardActionMessage): string => CARD_ACTION_PREFIX + JSON.stringify(m)

export function parseCardAction(text: string): CardActionMessage | null {
  if (!text.startsWith(CARD_ACTION_PREFIX)) return null
  try {
    const m = JSON.parse(text.slice(CARD_ACTION_PREFIX.length)) as CardActionMessage
    return typeof m?.cardId === 'string' && typeof m.action === 'string' ? m : null
  } catch {
    return null
  }
}

/** How the panel shows that turn: 「停止…」 · i-0abc · name=web-1 */
export function cardActionLabel(m: CardActionMessage): string {
  const values = Object.entries(m.values ?? {}).map(([k, v]) => `${k}=${String(v)}`)
  return [`「${m.label || m.action}」`, m.row, values.join(', ')].filter(Boolean).join(' · ')
}
