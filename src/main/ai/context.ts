/**
 * What of a conversation goes to the LLM (plan §6). Pure, and structural on pi's message shapes, so it needs no
 * pi import. Messages are only elided or dropped as whole user turns, which keeps every tool call next to its result.
 */

interface Msg {
  role: string
  content?: unknown
  toolName?: string
}

/** Rough tokens: ~3 chars each over the JSON (CJK and JSON punctuation both run denser than English prose). */
export function estimateTokens(messages: Msg[]): number {
  return Math.ceil(JSON.stringify(messages).length / 3)
}

const isElided = (m: Msg): boolean =>
  Array.isArray(m.content) && (m.content[0] as { text?: string } | undefined)?.text?.startsWith('[已省略') === true

function elide<T extends Msg>(m: T): T {
  return { ...m, content: [{ type: 'text', text: `[已省略：较早的 ${m.toolName ?? '工具'} 结果，需要时请重新查询]` }] }
}

/**
 * Back-to-back user messages become one. They happen when main stores a turn without running the model (a cancelled
 * proposal's [proposal_result]) and the user then types; some providers refuse two user messages in a row.
 */
export function mergeUserTurns<T extends Msg>(messages: T[]): T[] {
  const parts = (c: unknown): unknown[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [])
  const out: T[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (m.role === 'user' && last?.role === 'user') out[out.length - 1] = { ...last, content: [...parts(last.content), { type: 'text', text: '\n\n' }, ...parts(m.content)] }
    else out.push(m)
  }
  return out
}

/**
 * Tool results older than the last `keepTurns` user turns become placeholders; then, while over `budget` tokens,
 * the oldest remaining tool results go, then the oldest turns. System messages and the latest turn always stay.
 */
export function compactContext<T extends Msg>(messages: T[], budget: number, keepTurns = 20): T[] {
  const head = messages.filter((m) => m.role === 'system')
  const body = messages.filter((m) => m.role !== 'system')
  // Turn boundaries: indexes of user messages.
  const starts = body.flatMap((m, i) => (m.role === 'user' ? [i] : []))
  const cutoff = starts.length > keepTurns ? starts[starts.length - keepTurns] : 0
  let out = body.map((m, i) => (i < cutoff && m.role === 'toolResult' ? elide(m) : m))

  const over = (): boolean => estimateTokens([...head, ...out]) > budget
  // Not within the latest turn: the model has not answered from those results yet.
  const latest = starts.length > 0 ? starts[starts.length - 1] : 0
  for (let i = 0; i < latest && over(); i++) {
    if (out[i].role === 'toolResult' && !isElided(out[i])) out[i] = elide(out[i])
  }
  while (over()) {
    const next = out.findIndex((m, i) => i > 0 && m.role === 'user')
    if (next <= 0) break
    out = out.slice(next)
  }
  return [...head, ...out]
}
