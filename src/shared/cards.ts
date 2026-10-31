/**
 * Interactive card schema (plan §10.2), version 2 (v1 cards are still valid). Defined once with TypeBox: the render_card tool's parameters
 * are ModelCardInput, and main re-checks every card against CardSchema. The renderer only `import type`s from
 * here, so no validator code is bundled there. Rules a schema can't say (references, URLs, origin, patterns) are
 * in main/ai/cards.ts.
 */
import { Type, type Static } from 'typebox'

export const CARD_LIMITS = {
  blocks: 20,
  actions: 6,
  rows: 100,
  columns: 12,
  kv: 30,
  badges: 20,
  fields: 20,
  options: 50,
  markdown: 4000,
  title: 120,
  label: 100,
  cell: 500,
  value: 1000,
  url: 2000,
  pattern: 100,
  /** The whole card as JSON. */
  json: 60_000,
  /** Cards expire 30 minutes after they are shown (§10.3). */
  ttlMs: 30 * 60_000
} as const

const L = CARD_LIMITS
const Str = (maxLength: number, description?: string) => Type.String({ maxLength, ...(description && { description }) })
const Label = Str(L.label)
/** Ids the model picks for actions; also what comes back over IPC. */
export const ACTION_ID_RE = '^[A-Za-z0-9_-]{1,32}$'
const ActionId = Type.String({ pattern: ACTION_ID_RE })
/** A row id is usually the resource id (i-0abc, bucket name, ARN): printable ASCII, no spaces. */
export const ROW_ID_RE = '^[\\x21-\\x7e]{1,256}$'
export const FIELD_NAME_RE = '^[A-Za-z][A-Za-z0-9_]{0,31}$'
const FieldName = Type.String({ pattern: FIELD_NAME_RE })
const lit = <T extends string>(...values: T[]) => Type.Enum(values)

// ---- blocks the model may use ----

const MarkdownBlock = Type.Object({ type: Type.Literal('markdown'), text: Str(L.markdown, '受限 markdown：链接只有 console 页面可点，不显示图片和 HTML') })
const KvBlock = Type.Object({
  type: Type.Literal('kv'),
  items: Type.Array(Type.Object({ label: Label, value: Str(L.value), copy: Type.Optional(Type.Boolean()) }), { minItems: 1, maxItems: L.kv })
})
const TableBlock = Type.Object({
  type: Type.Literal('table'),
  columns: Type.Array(Type.Object({ key: Type.String({ pattern: '^[A-Za-z0-9_-]{1,40}$' }), label: Label, align: Type.Optional(lit('left', 'right')) }), {
    minItems: 1,
    maxItems: L.columns
  }),
  rows: Type.Array(
    Type.Object({
      id: Type.String({ pattern: ROW_ID_RE, description: '行 id，一般是资源 id；open-console 的 url 里的 {row} 会替换成它' }),
      cells: Type.Record(Type.String(), Str(L.cell)),
      actions: Type.Optional(Type.Array(ActionId, { maxItems: L.actions, description: '这一行可用的按钮，引用 actions[].id' }))
    }),
    { maxItems: L.rows }
  ),
  sort: Type.Optional(Type.Boolean())
})
const BadgesBlock = Type.Object({
  type: Type.Literal('badges'),
  items: Type.Array(Type.Object({ text: Str(60), tone: lit('neutral', 'ok', 'warn', 'danger') }), { minItems: 1, maxItems: L.badges })
})

const TextField = Type.Object({
  type: Type.Literal('text'),
  name: FieldName,
  label: Label,
  placeholder: Type.Optional(Str(L.label)),
  pattern: Type.Optional(Str(L.pattern, 'JavaScript 正则，整串匹配；不能有嵌套量词')),
  required: Type.Optional(Type.Boolean())
})
const NumberField = Type.Object({
  type: Type.Literal('number'),
  name: FieldName,
  label: Label,
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number()),
  required: Type.Optional(Type.Boolean())
})
const SelectField = Type.Object({
  type: Type.Literal('select'),
  name: FieldName,
  label: Label,
  options: Type.Array(Type.Object({ value: Str(200), label: Label }), { minItems: 1, maxItems: L.options })
})
const CheckboxField = Type.Object({ type: Type.Literal('checkbox'), name: FieldName, label: Label })
export const FieldSchema = Type.Union([TextField, NumberField, SelectField, CheckboxField])

const FormBlock = Type.Object({
  type: Type.Literal('form'),
  fields: Type.Array(FieldSchema, { minItems: 1, maxItems: L.fields }),
  submitActionId: Type.String({ pattern: ACTION_ID_RE, description: '提交按钮，引用一个 kind=reply 的 action' })
})
const ConsoleLinkBlock = Type.Object({ type: Type.Literal('console-link'), label: Label, url: Str(L.url, '必须是 https://…console.aws.amazon.com/… 页面') })

// A tuple, so Static keeps each member (an array type would collapse the union).
const MODEL_BLOCKS: [typeof MarkdownBlock, typeof KvBlock, typeof TableBlock, typeof BadgesBlock, typeof FormBlock, typeof ConsoleLinkBlock] = [
  MarkdownBlock,
  KvBlock,
  TableBlock,
  BadgesBlock,
  FormBlock,
  ConsoleLinkBlock
]
/** By type, so an invalid block gets its own errors rather than "matches no union member". */
export const MODEL_BLOCK_SCHEMAS: Record<string, (typeof MODEL_BLOCKS)[number]> = Object.fromEntries(MODEL_BLOCKS.map((s) => [s.properties.type.const, s]))

// ---- blocks only main produces (origin=system; M3 confirmation, progress and error cards) ----

const DiffBlock = Type.Object({
  type: Type.Literal('diff'),
  lines: Type.Array(Type.Object({ path: Str(300), op: lit('add', 'remove', 'change'), before: Type.Optional(Type.Unknown()), after: Type.Optional(Type.Unknown()) }), {
    maxItems: 200
  })
})
const ConsequencesBlock = Type.Object({
  type: Type.Literal('consequences'),
  items: Type.Array(
    Type.Object({
      kind: lit('downtime', 'irreversible', 'cost', 'dependency', 'blast-radius', 'data'),
      text: Str(L.cell),
      monthlyUsd: Type.Optional(Type.Number())
    }),
    { maxItems: 30 }
  )
})
const RiskBlock = Type.Object({ type: Type.Literal('risk'), level: lit('low', 'medium', 'high', 'destructive'), reasons: Type.Array(Str(300), { maxItems: 20 }) })
const ProgressBlock = Type.Object({
  type: Type.Literal('progress'),
  label: Str(200),
  done: Type.Optional(Type.Integer({ minimum: 0 })),
  total: Type.Optional(Type.Integer({ minimum: 0 }))
})
const ErrorBlock = Type.Object({ type: Type.Literal('error'), message: Str(L.value), detail: Type.Optional(Str(L.markdown)) })

/** A generic change: the request exactly as it will be sent, instead of a diff (there is no snapshot to diff against). */
const RequestBlock = Type.Object({ type: Type.Literal('request'), action: Str(150), region: Str(40), params: Str(L.json) })

/**
 * Card v2: the readable change preview that replaces `diff` (main/ai/changes/common.ts `Change`). A headline, then by
 * kind: labelled fields (create, request), changed items only (modify), state chips (state), what goes and what stays
 * (delete). Values are display strings main formatted; the renderer shows them in full.
 */
const ChangeBlock = Type.Object({
  type: Type.Literal('change'),
  kind: lit('create', 'modify', 'state', 'delete', 'request'),
  summary: Str(300),
  fields: Type.Optional(Type.Array(Type.Object({ label: Str(200), value: Str(L.json), note: Type.Optional(Str(300)) }), { maxItems: 300 })),
  rows: Type.Optional(Type.Array(Type.Object({ target: Type.Optional(Str(300)), item: Str(300), before: Str(L.value), after: Str(L.value) }), { maxItems: 200 })),
  /** The rows' column heads, when not 当前 / 改为 (a drift: 提案时 / 确认时). */
  heads: Type.Optional(Type.Object({ before: Str(20), after: Str(20) })),
  states: Type.Optional(Type.Array(Type.Object({ name: Str(300), from: Str(100), to: Str(100) }), { maxItems: 50 })),
  removed: Type.Optional(Type.Array(Type.Object({ name: Str(300), detail: Type.Optional(Str(300)) }), { maxItems: 100 })),
  kept: Type.Optional(Type.Array(Str(300), { maxItems: 100 })),
  raw: Type.Optional(Str(L.json))
})

const RiskLevel = lit('low', 'medium', 'high', 'destructive')

/**
 * Card v3: the impact analyst's output (main/ai/analysis.ts), validated before it is stored. Also the parameters of
 * the analyst's submit tool, so the descriptions are written for it. Plain text everywhere; rendered escaped.
 */
export const AnalysisResultSchema = Type.Object({
  summary: Str(200, '一句话结论（≤200 字）'),
  changes: Type.Array(Type.Object({ label: Str(200), before: Str(500, '当前（来自读到的状态；读不到写「未知」）'), after: Str(500, '执行后（来自请求参数）') }), {
    maxItems: 12,
    description: '具体会改变什么；策略等 JSON 文档写语义对比：新增 / 移除的主体、操作、条件'
  }),
  impact: Type.Array(
    Type.Object({
      kind: lit('fact', 'inference'),
      text: Str(500),
      evidence: Type.Optional(Type.Object({ source: Str(100, '调用名，如 s3:GetBucketPolicy、request、param_facts、compare_documents'), excerpt: Str(300, '结果里的关键字段或摘录') }))
    }),
    { maxItems: 12, description: 'fact 必须带 evidence 且来自本次实际读到的数据；其余是 inference' }
  ),
  exposure: Type.Object({ level: lit('none', 'known', 'unknown'), who: Type.Array(Str(200), { maxItems: 12, description: '受影响的主体 / 资源；不知道就留空并用 unknown' }) }),
  reversibility: Type.Object({ level: lit('reversible', 'partly', 'irreversible', 'unknown'), how: Str(300, '怎么撤销，或为什么不能') }),
  risk: Type.Object({ level: RiskLevel, reasons: Type.Array(Str(300), { maxItems: 6 }) }),
  uncertainties: Type.Array(Str(300), { maxItems: 8, description: '没读到、被拒绝、不完整、无法判断的地方' }),
  confidence: lit('low', 'medium', 'high')
})

/** running: the skeleton (confirm waits). failed: why, and the user checks the params alone. `raised`: the app's risk went up. */
const AnalysisBlock = Type.Object({
  type: Type.Literal('analysis'),
  status: lit('running', 'done', 'failed'),
  /** AWS calls the analysis made so far. */
  calls: Type.Integer({ minimum: 0 }),
  error: Type.Optional(Str(300)),
  result: Type.Optional(AnalysisResultSchema),
  raised: Type.Optional(Type.Object({ from: RiskLevel, to: RiskLevel }))
})

export const BlockSchema = Type.Union([...MODEL_BLOCKS, DiffBlock, ConsequencesBlock, RiskBlock, ProgressBlock, ErrorBlock, RequestBlock, ChangeBlock, AnalysisBlock])

export const ActionSchema = Type.Object({
  id: ActionId,
  label: Str(40),
  style: Type.Optional(lit('primary', 'default', 'danger')),
  kind: lit('reply', 'open-console', 'copy'),
  url: Type.Optional(Str(L.url, 'open-console：console 页面，可含 {row}')),
  text: Type.Optional(Str(L.value, 'copy：要复制的文字，可含 {row}'))
})

/** What the model passes to render_card. A model-supplied id / origin / state is not part of it and is ignored. */
export const ModelCardInput = Type.Object({
  title: Type.Optional(Str(L.title)),
  blocks: Type.Array(Type.Union(MODEL_BLOCKS), { minItems: 1, maxItems: L.blocks }),
  actions: Type.Optional(Type.Array(ActionSchema, { maxItems: L.actions })),
  supersedes: Type.Optional(Type.String({ maxLength: 64, description: '要替换的旧卡片 cardId（可选）；旧卡片会标为已替代' }))
})

export const CardStateSchema = lit('active', 'resolved', 'expired', 'superseded')

export const CardSchema = Type.Object({
  /** 2 adds the `change` block (proposal and result cards), 3 the `analysis` block; stored v1 / v2 cards still render. */
  v: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
  /** Assigned by main. */
  id: Type.String({ pattern: '^c-[0-9a-f]{12}$' }),
  origin: lit('model', 'system'),
  title: Type.Optional(Str(L.title)),
  blocks: Type.Array(BlockSchema, { minItems: 1, maxItems: L.blocks }),
  actions: Type.Optional(Type.Array(ActionSchema, { maxItems: L.actions })),
  createdAt: Type.Number(),
  expiresAt: Type.Number(),
  supersedes: Type.Optional(Type.String({ maxLength: 64 })),
  /** As of when the snapshot was sent; stored snapshots say active and history recomputes it. */
  state: CardStateSchema
})

export type Card = Static<typeof CardSchema>
export type CardState = Static<typeof CardStateSchema>
export type Block = Static<typeof BlockSchema>
export type Field = Static<typeof FieldSchema>
export type CardAction = Static<typeof ActionSchema>
export type ModelCard = Static<typeof ModelCardInput>
export type AnalysisResult = Static<typeof AnalysisResultSchema>
export type AnalysisBlockData = Static<typeof AnalysisBlock>
export type FormValues = Record<string, string | number | boolean>

/** User turn a reply action injects (§10.3). Built by main from validated parts; typed messages may not start with it. */
export const CARD_ACTION_PREFIX = '[card_action] '
/** User turn main writes with a proposal's outcome (plan §9.1 change_result). Typed messages may not start with it either. */
export const PROPOSAL_RESULT_PREFIX = '[proposal_result] '
