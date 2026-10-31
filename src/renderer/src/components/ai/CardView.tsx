import { useId, useState } from 'react'
import type { CardActionResult } from '../../../../shared/ai'
import type { Block, Card, CardAction, CardState, Field, FormValues } from '../../../../shared/cards'
import { fieldError, fillRow, SYSTEM_BLOCK_TYPES } from '../../../../shared/cardRules'
import { ipcError } from '../../ai'
import { Markdown, safeHref } from './Markdown'

/**
 * A card (plan §10). Everything in it came from the model through main's checks, and is still shown as plain text
 * (React escapes it); only markdown blocks are parsed, by the restricted renderer. Buttons send ids to main, which
 * decides; copy is done here.
 */

const PAGE = 20
/** Longer than an instance id: such cells may wrap instead of widening the table. */
const LONG_CELL = 24
const STATE_NOTE: Record<Exclude<CardState, 'active'>, string> = {
  resolved: '已处理',
  expired: '已过期，请让助手重新生成',
  superseded: '已被新卡片替代'
}

interface Props {
  card: Card
  /** reply / open-console, through main. */
  onAction: (actionId: string, rowId?: string, values?: FormValues) => Promise<CardActionResult>
  onLink: (url: string) => void
  /** The account's color, on cards main made (origin=system). */
  accountColor?: string
}

/** What the blocks need from the card. */
interface Ctx {
  live: boolean
  actions: Map<string, CardAction>
  run: (a: CardAction, rowId?: string, values?: FormValues) => void
  copy: (text: string, key: string) => void
  copied: string | null
  onLink: (url: string) => void
}

export function CardSkeleton(): React.JSX.Element {
  return (
    <div className="ai-card skeleton" role="status" aria-label="正在生成卡片">
      <div className="ai-sk w40" />
      <div className="ai-sk" />
      <div className="ai-sk w70" />
    </div>
  )
}

export function CardView({ card, onAction, onLink, accountColor }: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  // Main enforces expiry; this only greys a card that ran out while on screen.
  const state: CardState = card.state === 'active' && Date.now() > card.expiresAt ? 'expired' : card.state
  const actions = card.actions ?? []
  const used = new Set(card.blocks.flatMap((b) => (b.type === 'table' ? b.rows.flatMap((r) => r.actions ?? []) : b.type === 'form' ? [b.submitActionId] : [])))
  const footer = actions.filter((a) => !used.has(a.id))

  const copy = (text: string, key: string): void => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(key)
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
      },
      () => setError('复制失败')
    )
  }
  const run = (a: CardAction, rowId?: string, values?: FormValues): void => {
    if (a.kind === 'copy') return copy(fillRow(a.text ?? '', rowId, false), `${a.id}:${rowId ?? ''}`)
    setBusy(true)
    setError(null)
    onAction(a.id, rowId, values)
      .then((r) => !r.ok && setError(r.error), (err) => setError(ipcError(err)))
      .finally(() => setBusy(false))
  }
  const ctx: Ctx = { live: state === 'active' && !busy, actions: new Map(actions.map((a) => [a.id, a])), run, copy, copied, onLink }
  const system = card.origin === 'system'

  return (
    <section
      className={`ai-card ${state}${system ? ' system' : ''}`}
      aria-label={card.title ? `卡片：${card.title}` : '卡片'}
      style={system && accountColor ? { borderLeftColor: accountColor } : undefined}
    >
      {(card.title || system || state !== 'active') && (
        <header className="ai-card-head">
          {system && (
            <span className="ai-lock" title="由应用生成" aria-label="由应用生成">
              🔒
            </span>
          )}
          <span className="ai-card-title">{card.title}</span>
          {state !== 'active' && <span className="ai-card-state">{STATE_NOTE[state]}</span>}
        </header>
      )}
      {card.blocks.map((b, i) =>
        // System-only blocks never render on a model card (main rejects them anyway).
        SYSTEM_BLOCK_TYPES.includes(b.type) && !system ? null : <BlockView key={i} block={b} ctx={ctx} />
      )}
      {footer.length > 0 && (
        <div className="ai-card-actions">
          {footer.map((a) => (
            <ActionButton key={a.id} action={a} ctx={ctx} />
          ))}
        </div>
      )}
      {error && (
        <div className="ai-notice" role="alert">
          {error}
        </div>
      )}
    </section>
  )
}

function ActionButton({ action: a, rowId, ctx }: { action: CardAction; rowId?: string; ctx: Ctx }): React.JSX.Element {
  const key = `${a.id}:${rowId ?? ''}`
  const label = a.kind === 'copy' && ctx.copied === key ? '已复制' : a.label
  return (
    <button
      type="button"
      className={`ai-card-btn ${a.style ?? 'default'}`}
      // Copying changes nothing, so it works on a handled card too.
      disabled={a.kind !== 'copy' && !ctx.live}
      aria-label={rowId ? `${a.label}：${rowId}` : undefined}
      title={a.kind === 'open-console' ? '在 Console 中打开' : undefined}
      onClick={() => ctx.run(a, rowId)}
    >
      {label}
      {a.kind === 'open-console' && ' ↗'}
    </button>
  )
}

/** Long text cut to `max` characters with 展开 / 收起. */
function Truncated({ text, max }: { text: string; max: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (text.length <= max) return <>{text}</>
  return (
    <>
      {open ? text : `${text.slice(0, max)}…`}{' '}
      <button type="button" className="ai-link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '收起' : '展开'}
      </button>
    </>
  )
}

function BlockView({ block: b, ctx }: { block: Block; ctx: Ctx }): React.JSX.Element | null {
  switch (b.type) {
    case 'markdown':
      return <ClampedMarkdown text={b.text} onLink={ctx.onLink} />
    case 'kv':
      return (
        <dl className="ai-kv">
          {b.items.map((it, i) => (
            <div key={i} className="ai-kv-row">
              <dt>{it.label}</dt>
              <dd>
                <Truncated text={it.value} max={200} />
                {it.copy && (
                  <button type="button" className="ai-link-btn" aria-label={`复制${it.label}`} onClick={() => ctx.copy(it.value, `kv:${i}`)}>
                    {ctx.copied === `kv:${i}` ? '已复制' : '复制'}
                  </button>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )
    case 'table':
      return <TableView block={b} ctx={ctx} />
    case 'badges':
      return (
        <div className="ai-badges">
          {b.items.map((it, i) => (
            <span key={i} className={`ai-tone ${it.tone}`}>
              {it.text}
            </span>
          ))}
        </div>
      )
    case 'form':
      return <FormView block={b} ctx={ctx} />
    case 'console-link': {
      const url = safeHref(b.url, true)
      if (!url) return <span>{b.label}</span>
      return (
        <a
          className="ai-console-link"
          href={url}
          title={url}
          onClick={(e) => {
            e.preventDefault()
            ctx.onLink(url)
          }}
        >
          {b.label} ↗
        </a>
      )
    }
    case 'change':
      return <ChangeView block={b} />
    case 'analysis':
      return <AnalysisView block={b} />
    case 'diff':
      // Card v1 (stored history): the older line-by-line view.
      return (
        <ul className="ai-diff" aria-label="变更">
          {b.lines.map((l, i) => (
            <li key={i} className={l.op}>
              <span aria-hidden>{l.op === 'add' ? '+' : l.op === 'remove' ? '−' : '~'}</span> <code>{l.path}</code>{' '}
              {l.op !== 'add' && <span className="before">{shortJson(l.before)}</span>}
              {l.op === 'change' && ' → '}
              {l.op !== 'remove' && <span className="after">{shortJson(l.after)}</span>}
            </li>
          ))}
        </ul>
      )
    case 'request':
      // Shown in full, never clipped: this is exactly what will be sent.
      return (
        <div className="ai-request" aria-label="将发送的请求">
          <div className="ai-request-head">
            <code>{b.action}</code> · {b.region}
          </div>
          <pre className="ai-request-params" tabIndex={0} aria-label="请求参数">
            {b.params}
          </pre>
        </div>
      )
    case 'consequences':
      return (
        <ul className="ai-consequences" aria-label="影响">
          {b.items.map((c, i) => (
            <li key={i} className={c.kind}>
              <span className="ai-consequence-kind">{CONSEQUENCE[c.kind]}</span> {c.text}
            </li>
          ))}
        </ul>
      )
    case 'risk':
      return (
        <div className={`ai-risk ${b.level}`}>
          <span className="ai-tone">风险：{RISK[b.level]}</span>
          {b.reasons.length > 0 && (
            <ul>
              {b.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )
    case 'progress':
      return (
        <div className="ai-progress">
          <span>{b.label}</span>
          {b.total ? <progress value={b.done ?? 0} max={b.total} aria-label={b.label} /> : <span className="spinner" aria-hidden />}
        </div>
      )
    case 'error':
      return (
        <div className="ai-card-error" role="alert">
          <div>{b.message}</div>
          {b.detail && (
            <div className="ai-dim small">
              <Truncated text={b.detail} max={300} />
            </div>
          )}
        </div>
      )
  }
}

type ChangeBlock = Extract<Block, { type: 'change' }>

/** The readable change preview: a headline, then what to check for this kind of change. Plain text throughout. */
function ChangeView({ block: b }: { block: ChangeBlock }): React.JSX.Element {
  const heads = b.heads ?? { before: '当前', after: '改为' }
  return (
    <div className={`ai-change ${b.kind}`} aria-label="变更内容">
      <p className="ai-change-summary">{b.summary}</p>
      {b.kind === 'request' && !b.fields?.length && (
        <dl className="ai-kv">
          <div className="ai-kv-row">
            <dt>参数</dt>
            <dd className="ai-dim">无参数</dd>
          </div>
        </dl>
      )}
      {b.fields && b.fields.length > 0 && (
        <dl className="ai-kv">
          {b.fields.map((f, i) => (
            <div key={i} className="ai-kv-row">
              <dt>{f.label}</dt>
              <dd>
                <Truncated text={f.value} max={200} />
                {f.note && <div className="ai-dim small">{f.note}</div>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {b.rows && b.rows.length > 0 && (
        <div className="ai-table-scroll">
          <table className="ai-table ai-change-table">
            <thead>
              <tr>
                <th scope="col">项目</th>
                <th scope="col">{heads.before}</th>
                <th scope="col">{heads.after}</th>
              </tr>
            </thead>
            <tbody>
              {b.rows.flatMap((r, i) => [
                ...(r.target !== undefined && r.target !== b.rows?.[i - 1]?.target
                  ? [
                      <tr key={`t${i}`} className="ai-change-target">
                        <th scope="rowgroup" colSpan={3}>
                          {r.target}
                        </th>
                      </tr>
                    ]
                  : []),
                <tr key={i}>
                  <th scope="row">{r.item}</th>
                  <td className="before">
                    <Truncated text={r.before} max={120} />
                  </td>
                  <td className="after">
                    <Truncated text={r.after} max={120} />
                  </td>
                </tr>
              ])}
            </tbody>
          </table>
        </div>
      )}
      {b.states && b.states.length > 0 && (
        <ul className="ai-change-states">
          {b.states.map((s, i) => (
            <li key={i}>
              <span className="ai-change-name">{s.name}</span>
              <span className="ai-chip">{s.from}</span>
              <span aria-label="变为">→</span>
              <span className="ai-chip ai-change-new">{s.to}</span>
            </li>
          ))}
        </ul>
      )}
      {b.removed && b.removed.length > 0 && (
        <>
          <div className="ai-change-warning" role="note">
            ⚠ 下面的资源会被删除，删除后无法恢复
          </div>
          <ul className="ai-change-removed">
            {b.removed.map((r, i) => (
              <li key={i}>
                {r.name}
                {r.detail && <span className="ai-dim"> · {r.detail}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {b.kept && b.kept.length > 0 && (
        <div className="ai-change-kept">
          <span className="ai-dim">会保留：</span>
          <ul>
            {b.kept.map((k, i) => (
              <li key={i}>{k}</li>
            ))}
          </ul>
        </div>
      )}
      {b.raw !== undefined && (
        <details className="ai-change-raw">
          <summary>原始 JSON（实际发送的内容）</summary>
          <pre className="ai-request-params" tabIndex={0} aria-label="请求参数">
            {b.raw}
          </pre>
        </details>
      )}
    </div>
  )
}

type AnalysisBlock = Extract<Block, { type: 'analysis' }>

const EXPOSURE: Record<string, string> = { none: '没有', known: '已知', unknown: '未知' }
const REVERSIBILITY: Record<string, string> = { reversible: '可撤销', partly: '部分可撤销', irreversible: '不可撤销', unknown: '未知' }
const CONFIDENCE: Record<string, string> = { low: '低', medium: '中', high: '高' }

/** The AI impact analysis (analysis.ts): advisory and labelled so; facts with their evidence, inferences as such. Plain text. */
function AnalysisView({ block: b }: { block: AnalysisBlock }): React.JSX.Element {
  if (b.status === 'running') {
    return (
      <div className="ai-analysis running" role="status" aria-live="polite">
        <span>正在分析影响…（用到的查询：{b.calls}）</span>
        <div className="ai-sk w70" />
        <div className="ai-sk w40" />
      </div>
    )
  }
  if (b.status === 'failed' || !b.result) {
    return (
      <div className="ai-analysis failed" role="note">
        未能完成影响分析：{b.error ?? '未知原因'}，请自行核对参数
      </div>
    )
  }
  const r = b.result
  const facts = r.impact.filter((i) => i.kind === 'fact')
  const inferences = r.impact.filter((i) => i.kind === 'inference')
  return (
    <section className="ai-analysis done" aria-label="AI 影响分析">
      <header className="ai-analysis-head">
        <strong>AI 分析（可能有误，请核对）</strong>
        <span className="ai-chip">可信度：{CONFIDENCE[r.confidence]}</span>
        <span className="ai-chip">查询 {b.calls} 次</span>
      </header>
      <p className="ai-analysis-summary">{r.summary}</p>
      {b.raised && (
        <div className="ai-analysis-raised" role="note">
          风险已由「{RISK[b.raised.from]}」提高到「{RISK[b.raised.to]}」：{r.risk.reasons.join('；') || '分析建议'}
        </div>
      )}
      {r.changes.length > 0 && (
        <div className="ai-table-scroll">
          <table className="ai-table ai-change-table">
            <thead>
              <tr>
                <th scope="col">会改变什么</th>
                <th scope="col">当前</th>
                <th scope="col">执行后</th>
              </tr>
            </thead>
            <tbody>
              {r.changes.map((c, i) => (
                <tr key={i}>
                  <th scope="row">{c.label}</th>
                  <td className="before">
                    <Truncated text={c.before} max={120} />
                  </td>
                  <td className="after">
                    <Truncated text={c.after} max={120} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {facts.length > 0 && (
        <details className="ai-analysis-facts" open>
          <summary>事实（{facts.length} 条，展开看依据）</summary>
          <ul>
            {facts.map((f, i) => (
              <li key={i}>
                <span className="ai-tone ok">事实</span> {f.text}
                {f.evidence && (
                  <details className="ai-analysis-evidence">
                    <summary>依据：{f.evidence.source}</summary>
                    <code>{f.evidence.excerpt}</code>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {inferences.length > 0 && (
        <ul className="ai-analysis-inferences" aria-label="推断">
          {inferences.map((f, i) => (
            <li key={i}>
              <span className="ai-tone warn">推断</span> {f.text}
            </li>
          ))}
        </ul>
      )}
      <dl className="ai-kv">
        <div className="ai-kv-row">
          <dt>影响对象</dt>
          <dd>
            {EXPOSURE[r.exposure.level]}
            {r.exposure.who.length > 0 && `：${r.exposure.who.join('、')}`}
          </dd>
        </div>
        <div className="ai-kv-row">
          <dt>可撤销性</dt>
          <dd>
            {REVERSIBILITY[r.reversibility.level]}
            {r.reversibility.how && `：${r.reversibility.how}`}
          </dd>
        </div>
        <div className="ai-kv-row">
          <dt>建议风险</dt>
          <dd>
            {RISK[r.risk.level]}
            {!b.raised && r.risk.reasons.length > 0 && `：${r.risk.reasons.join('；')}`}
            <div className="ai-dim small">分析只会提高提案的风险，不会降低</div>
          </dd>
        </div>
      </dl>
      {r.uncertainties.length > 0 && (
        <div className="ai-analysis-uncertain">
          <span className="ai-dim">不确定的地方：</span>
          <ul>
            {r.uncertainties.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

const CONSEQUENCE: Record<string, string> = { downtime: '停机', irreversible: '不可恢复', cost: '费用', dependency: '依赖', 'blast-radius': '影响范围', data: '数据' }
const RISK: Record<string, string> = { low: '低', medium: '中', high: '高', destructive: '破坏性' }

function shortJson(v: unknown): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? '∅')
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

function ClampedMarkdown({ text, onLink }: { text: string; onLink: (url: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const long = text.length > 800 || text.split('\n').length > 16
  return (
    <div>
      <div className={long && !open ? 'ai-clamp' : undefined}>
        <Markdown text={text} onLink={onLink} consoleOnly />
      </div>
      {long && (
        <button type="button" className="ai-link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}

type TableBlock = Extract<Block, { type: 'table' }>

const compareCells = (a: string, b: string): number => {
  const x = Number(a.replace(/[$,%\s]/g, ''))
  const y = Number(b.replace(/[$,%\s]/g, ''))
  return a.trim() && b.trim() && Number.isFinite(x) && Number.isFinite(y) ? x - y : a.localeCompare(b, 'zh-CN', { numeric: true })
}

/** Rows as tab-separated text (tabs and newlines inside cells become spaces). */
export function tableTsv(b: TableBlock): string {
  const clean = (s: string): string => s.replace(/[\t\r\n]+/g, ' ')
  return [b.columns.map((c) => clean(c.label)), ...b.rows.map((r) => b.columns.map((c) => clean(r.cells[c.key] ?? '')))].map((l) => l.join('\t')).join('\n')
}

function TableView({ block: b, ctx }: { block: TableBlock; ctx: Ctx }): React.JSX.Element {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const [page, setPage] = useState(0)
  const rows = sort ? [...b.rows].sort((x, y) => sort.dir * compareCells(x.cells[sort.key] ?? '', y.cells[sort.key] ?? '')) : b.rows
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const at = Math.min(page, pages - 1)
  const shown = rows.slice(at * PAGE, (at + 1) * PAGE)
  const withActions = b.rows.some((r) => r.actions?.length)
  const sortable = b.sort !== false
  const toggle = (key: string): void => setSort((s) => (s?.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null))

  return (
    <div className="ai-table-block">
      <div className="ai-table-scroll">
        <table className="ai-table">
          <thead>
            <tr>
              {b.columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  style={{ textAlign: c.align ?? 'left' }}
                  aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                >
                  {sortable ? (
                    <button type="button" className="ai-sort" onClick={() => toggle(c.key)}>
                      {c.label}
                      <span aria-hidden>{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
              {withActions && (
                <th scope="col" className="ai-row-actions">
                  操作
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                {b.columns.map((c) => (
                  <td key={c.key} className={(r.cells[c.key]?.length ?? 0) > LONG_CELL ? 'ai-cell-long' : undefined} style={{ textAlign: c.align ?? 'left' }} title={r.cells[c.key]}>
                    {r.cells[c.key] ?? ''}
                  </td>
                ))}
                {withActions && (
                  <td className="ai-row-actions">
                    <span className="ai-row-actions-inner">
                      {(r.actions ?? []).flatMap((id) => {
                        const a = ctx.actions.get(id)
                        return a ? [<ActionButton key={id} action={a} rowId={r.id} ctx={ctx} />] : []
                      })}
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ai-table-foot">
        <span>{b.rows.length} 行</span>
        {pages > 1 && (
          <span className="ai-pager">
            <button type="button" className="ai-link-btn" disabled={at === 0} aria-label="上一页" onClick={() => setPage(at - 1)}>
              ‹
            </button>
            {at + 1} / {pages}
            <button type="button" className="ai-link-btn" disabled={at >= pages - 1} aria-label="下一页" onClick={() => setPage(at + 1)}>
              ›
            </button>
          </span>
        )}
        <span className="ai-spacer" />
        <button type="button" className="ai-link-btn" onClick={() => ctx.copy(tableTsv(b), 'tsv')}>
          {ctx.copied === 'tsv' ? '已复制' : '复制为 TSV'}
        </button>
      </div>
    </div>
  )
}

type FormBlock = Extract<Block, { type: 'form' }>

const initial = (f: Field): string | boolean => (f.type === 'checkbox' ? false : f.type === 'select' ? (f.options[0]?.value ?? '') : '')
/** Inputs hold strings; numbers go to main as numbers, empty as "not given". */
const parsed = (f: Field, raw: string | boolean | undefined): unknown => (f.type === 'number' && raw !== '' ? Number(raw) : raw)

function FormView({ block: b, ctx }: { block: FormBlock; ctx: Ctx }): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(b.fields.map((f) => [f.name, initial(f)])))
  const [submitted, setSubmitted] = useState(false)
  const uid = useId()
  const action = ctx.actions.get(b.submitActionId)
  const errors = Object.fromEntries(b.fields.map((f) => [f.name, fieldError(f, parsed(f, values[f.name]))]))
  const valid = Object.values(errors).every((e) => !e)
  const set = (name: string, v: string | boolean): void => setValues((prev) => ({ ...prev, [name]: v }))

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    setSubmitted(true)
    if (!valid || !ctx.live || !action) return
    const out: FormValues = {}
    for (const f of b.fields) {
      const v = parsed(f, values[f.name])
      if (v !== '' && v !== undefined) out[f.name] = v as string | number | boolean
    }
    ctx.run(action, undefined, out)
  }

  return (
    <form className="ai-form" onSubmit={submit} noValidate>
      <fieldset disabled={!ctx.live}>
        {b.fields.map((f) => {
          const id = `${uid}-${f.name}`
          const v = values[f.name]
          const error = errors[f.name] && (submitted || (v !== '' && v !== false)) ? errors[f.name] : null
          const common = { id, 'aria-invalid': Boolean(error), 'aria-describedby': error ? `${id}-err` : undefined }
          if (f.type === 'checkbox') {
            return (
              <label key={f.name} className="ai-field check">
                <input type="checkbox" checked={v === true} onChange={(e) => set(f.name, e.target.checked)} {...common} /> {f.label}
              </label>
            )
          }
          return (
            <div key={f.name} className="ai-field">
              <label htmlFor={id}>
                {f.label}
                {(f.type === 'text' || f.type === 'number') && f.required && <span aria-label="必填"> *</span>}
              </label>
              {f.type === 'select' ? (
                <select value={String(v)} onChange={(e) => set(f.name, e.target.value)} {...common}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.type === 'number' ? 'number' : 'text'}
                  value={String(v)}
                  placeholder={f.type === 'text' ? f.placeholder : undefined}
                  min={f.type === 'number' ? f.min : undefined}
                  max={f.type === 'number' ? f.max : undefined}
                  step={f.type === 'number' ? 'any' : undefined}
                  maxLength={1000}
                  required={f.required}
                  onChange={(e) => set(f.name, e.target.value)}
                  {...common}
                />
              )}
              {error && (
                <span className="ai-field-error" id={`${id}-err`}>
                  {error}
                </span>
              )}
            </div>
          )
        })}
        {action && (
          <button type="submit" className={`ai-card-btn ${action.style ?? 'primary'}`} disabled={!ctx.live}>
            {action.label}
          </button>
        )}
      </fieldset>
    </form>
  )
}
