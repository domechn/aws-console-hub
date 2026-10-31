/**
 * The generic adapter: a write no adapter knows (docs/plans/ai-approval.md). Main can't tell what it changes, so
 * the card shows the request exactly as it will be sent instead of a diff, the risk is at least high (typed
 * confirmation), tier C (classify.ts categories) is "destructive" with a red banner, and there is no snapshot, so no
 * drift check. Everything else (hash, nonce, TTL, policy checks, two-step confirm) is the engine's, as for any adapter.
 * The card states only what the app knows: no predicted effects here; the AI impact analysis (analysis.ts) looks at
 * the real state and says what it found, labelled as such.
 */
import { Type } from 'typebox'
import type { Risk } from '../../../shared/ai'
import { writeTier } from '../classify'
import { redactSecrets } from '../redact'
import { displayParams, scrub } from '../shape'
import { templateCategory } from './cfn'
import type { ChangeAdapter, Consequence } from './common'

/** Values of id / name / ARN-like params: the audit row's targets. */
function targetsOf(p: Record<string, unknown>): string[] {
  return Object.entries(p)
    .filter(([k]) => /(?:Id|Ids|Name|Names|Arn|ARN|Arns|Url|Identifier)$/.test(k))
    .flatMap(([, v]) => [v].flat())
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v).slice(0, 200))
    .slice(0, 10)
}

/**
 * A request's params as labelled rows: nested keys as「A › B」, list items numbered, strings as they are, other
 * values as JSON. `shown` is displayParams' output parsed back, so its redaction (and format-character escaping) holds.
 */
export function paramFields(shown: unknown, at = ''): { label: string; value: string }[] {
  if (shown && typeof shown === 'object' && Object.keys(shown).length) {
    return Object.entries(shown).flatMap(([k, v]) => paramFields(v, Array.isArray(shown) ? `${at} [${Number(k) + 1}]` : at ? `${at} › ${k}` : k))
  }
  return at ? [{ label: at, value: typeof shown === 'string' ? shown : (JSON.stringify(shown) ?? 'null') }] : []
}

/** Rows the card has room for; the raw JSON (always complete) holds the rest. */
const MAX_PARAM_ROWS = 299

/** The response as one bounded line for the result card and the model: no $metadata, secrets masked. */
export function responseSummary(response: unknown): string {
  const s = redactSecrets(JSON.stringify(scrub(response)) ?? '')
  if (!s || s === '{}' || s === 'null') return ''
  return s.length > 400 ? `${s.slice(0, 400)}…` : s
}

/**
 * `extra`: dangers found before (an adapter's forbidden param that sent the change here). `ownRole`: the role the app
 * signs in with.
 */
export function genericAdapter(service: string, action: string, params: Record<string, unknown>, opts: { ownRole?: string; extra?: string[] } = {}): ChangeAdapter {
  const t = writeTier(service, action, params, opts.ownRole)
  // A template is a string (key scans don't see roles in it): the change-set adapter's scanner, and no unseen URL.
  const template: string[] = []
  if (service === 'cloudformation') {
    const category = typeof params.TemplateBody === 'string' ? templateCategory(params.TemplateBody) : null
    if (category) template.push(category)
    if (params.TemplateURL !== undefined) template.push('模板在 URL 里，卡片上看不到它的内容')
  }
  const dangers = [...new Set([...(opts.extra ?? []), ...t.dangers, ...template])]
  const tier = dangers.length ? 'C' : 'B'
  const risk: Risk = tier === 'C' || t.destructive ? 'destructive' : 'high'
  const key = `${service}:${action}`
  const consequences: Consequence[] = [{ kind: 'blast-radius', text: '没有专用适配器，应用无法预知影响；请逐项核对下面的请求参数' }]
  return {
    service,
    action,
    doc: '通用请求：参数原样发送',
    // Anything: the engine has already checked it is a plain object of bounded size.
    schema: Type.Object({}, { additionalProperties: true }),
    // The engine turns DryRun on only for EC2 operations whose input has a DryRun member (others would really run);
    // otherwise the permission pre-check (iam:SimulatePrincipalPolicy) stands in.
    dryRun: false,
    iamActions: [`${service === 'apigatewayv2' ? 'apigateway' : service}:${action}`],
    generic: { tier, dangers },
    snapshot: async () => null,
    plan: (p: Record<string, unknown>) => {
      // Write cards reveal values (displayParams): the user must see what an injected instruction may have picked.
      const raw = displayParams(p, true)
      const fields = paramFields(JSON.parse(raw))
      return {
        title: `${key}（通用请求）`,
        targets: targetsOf(p),
        confirmText: key,
        risk,
        reasons: [
          ...dangers.map((d) => `需要强确认的类别：${d}（此类操作需要仔细核对）`),
          ...(t.destructive && tier === 'B' ? ['操作名属于删除 / 停止 / 撤销 / 改策略一类，风险按「破坏性」计'] : []),
          '没有专用适配器，应用无法预知影响'
        ],
        change: {
          kind: 'request' as const,
          summary: `发送通用请求 ${key}`,
          fields:
            fields.length > MAX_PARAM_ROWS
              ? [...fields.slice(0, MAX_PARAM_ROWS), { label: '…', value: `另有 ${fields.length - MAX_PARAM_ROWS} 项，见下面的原始 JSON` }]
              : fields,
          raw
        },
        consequences
      }
    },
    // A copy: the frozen params are hashed; the SDK may add fields to what it is given.
    request: (p: Record<string, unknown>) => structuredClone(p),
    verify: async (_p, _ctx, response) => responseSummary(response)
  }
}
