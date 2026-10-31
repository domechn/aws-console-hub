/**
 * Small generic readers for JSON documents in requests and AWS responses (docs/plans/ai-approval.md, 影响分析): what an
 * IAM-style policy says statement by statement, and how two documents differ. Pure. Their output goes to the impact
 * analyst as facts it may cite; they state what a document says, never what will happen.
 */
import { POLICY_KEY } from './classify'
import { fieldDiff, type DiffLine } from './changes/common'

export interface StatementFacts {
  sid?: string
  effect: string
  /** `AWS:arn:…`, `Service:…`, `*`… */
  principals: string[]
  /** Principal `*` or `{ AWS: "*" }`: any principal. */
  anyPrincipal: boolean
  /** 12-digit account ids in the principals other than the caller's own. */
  otherAccounts: string[]
  notPrincipal: boolean
  actions: string[]
  wildcardActions: string[]
  notAction: boolean
  resources: string[]
  /** `StringEquals aws:SourceVpce`… */
  conditions: string[]
}

export interface PolicyFacts {
  statements: StatementFacts[]
  /** One line per notable fact, citable as is. */
  notes: string[]
}

const list = (v: unknown): string[] => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))))

const principalsOf = (p: unknown): string[] =>
  p && typeof p === 'object' && !Array.isArray(p) ? Object.entries(p).flatMap(([kind, v]) => list(v).map((x) => `${kind}:${x}`)) : list(p)

/** A policy document (an object, or the JSON string AWS and the APIs carry), or null when it isn't one. */
export function parsePolicy(doc: unknown): Record<string, unknown> | null {
  let v = doc
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) && 'Statement' in v ? (v as Record<string, unknown>) : null
}

export function policyFacts(doc: unknown, ownAccount?: string): PolicyFacts | null {
  const p = parsePolicy(doc)
  if (!p) return null
  const raw = Array.isArray(p.Statement) ? p.Statement : [p.Statement]
  const statements = raw
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
    .slice(0, 50)
    .map((s): StatementFacts => {
      const principals = principalsOf(s.Principal ?? s.NotPrincipal)
      const actions = list(s.Action ?? s.NotAction)
      const cond = s.Condition && typeof s.Condition === 'object' ? (s.Condition as Record<string, unknown>) : {}
      return {
        ...(typeof s.Sid === 'string' && { sid: s.Sid }),
        effect: String(s.Effect ?? '?'),
        principals,
        anyPrincipal: principals.some((x) => /^(?:AWS:)?\*$/.test(x)),
        otherAccounts: [...new Set(principals.flatMap((x) => [...x.matchAll(/(?<!\d)(\d{12})(?!\d)/g)].map((m) => m[1])))].filter((id) => id !== ownAccount),
        notPrincipal: s.NotPrincipal !== undefined,
        actions,
        wildcardActions: actions.filter((a) => a.includes('*')),
        notAction: s.NotAction !== undefined,
        resources: list(s.Resource ?? s.NotResource),
        conditions: Object.entries(cond).flatMap(([op, v]) => (v && typeof v === 'object' ? Object.keys(v).map((k) => `${op} ${k}`) : [op]))
      }
    })
  const notes = statements.flatMap((s, i) => {
    const at = `语句 ${i + 1}${s.sid ? `（${s.sid}）` : ''}，${s.effect}`
    const where = s.conditions.length ? `，带 Condition：${s.conditions.join('、')}` : '，没有 Condition'
    return [
      ...(s.anyPrincipal ? [`${at}：Principal 是 *（任何主体）${where}`] : []),
      ...(s.otherAccounts.length ? [`${at}：主体里有其他账号 ${s.otherAccounts.join('、')}${where}`] : []),
      ...(s.notPrincipal ? [`${at}：用的是 NotPrincipal（列出的主体以外的全部主体）`] : []),
      ...(s.wildcardActions.length ? [`${at}：Action 含通配符 ${s.wildcardActions.join('、')}`] : []),
      ...(s.notAction ? [`${at}：用的是 NotAction（列出的操作以外的全部操作）`] : [])
    ]
  })
  return { statements, notes }
}

const setOf = (f: PolicyFacts | null, pick: (s: StatementFacts) => string[]): Set<string> => new Set((f?.statements ?? []).flatMap((s) => pick(s).map((x) => `${s.effect} · ${x}`)))
const delta = (a: Set<string>, b: Set<string>) => ({ added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)) })

/** Semantic comparison of two policies: principals, actions, resources and conditions added / removed, per effect. */
export function comparePolicies(before: PolicyFacts | null, after: PolicyFacts | null) {
  const of = (pick: (s: StatementFacts) => string[]) => delta(setOf(before, pick), setOf(after, pick))
  return {
    statements: { before: before?.statements.length ?? 0, after: after?.statements.length ?? 0 },
    principals: of((s) => s.principals),
    actions: of((s) => s.actions),
    resources: of((s) => s.resources),
    conditions: of((s) => s.conditions),
    notesBefore: before?.notes ?? [],
    notesAfter: after?.notes ?? []
  }
}

const asJson = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/** Two documents (objects or JSON strings; `before` absent: nothing yet): a field diff, and the policy comparison when both or either is a policy. */
export function compareDocuments(before: unknown, after: unknown, ownAccount?: string): { policy?: ReturnType<typeof comparePolicies>; diff: DiffLine[]; more?: number } {
  const obj = (v: unknown): Record<string, unknown> => {
    const j = asJson(v)
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : j === undefined || j === null ? {} : { value: j }
  }
  const lines = fieldDiff(obj(before), obj(after))
  const pb = policyFacts(before, ownAccount)
  const pa = policyFacts(after, ownAccount)
  return { ...((pb || pa) && { policy: comparePolicies(pb, pa) }), diff: lines.slice(0, 100), ...(lines.length > 100 && { more: lines.length - 100 }) }
}

/** Policy documents anywhere in a request's params (policy-like keys, or any value that parses as one), with their facts. */
export function paramDocs(params: unknown, ownAccount?: string): { path: string; facts: PolicyFacts }[] {
  const out: { path: string; facts: PolicyFacts }[] = []
  const walk = (v: unknown, path: string, key: string, depth: number): void => {
    if (depth > 8 || out.length >= 10) return
    const looksLike = POLICY_KEY.test(key) || (typeof v === 'string' && /^\s*\{[\s\S]*"Statement"/.test(v))
    const facts = looksLike ? policyFacts(v, ownAccount) : null
    if (facts) return void out.push({ path: path || key, facts })
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, Array.isArray(v) ? key : k, depth + 1)
  }
  walk(params, '', '', 0)
  return out
}
