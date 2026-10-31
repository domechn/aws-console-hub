/**
 * Tags on any supported resource by ARN, through the Resource Groups Tagging API (IAM prefix `tag`), plan §9.3.
 * No DryRun. Tags can grant access (ABAC: IAM conditions on aws:ResourceTag), so services whose tags guard
 * identities, keys or audit are refused, and so is any ARN outside the proposal's account and region.
 */
import { Type } from 'typebox'
import { fieldDiff, isProdTagged, rowsOf, show, tagMap, type ChangeAdapter, type ChangeCtx, type Plan } from './common'

const Strict = { additionalProperties: false }
const TAG_KEY = { minLength: 1, maxLength: 128, pattern: '^(?![aA][wW][sS]:)[^\\u0000-\\u001f]+$' }
const Arn = Type.String({ pattern: '^arn:aws(-cn|-us-gov)?:[a-z0-9-]{2,40}:[a-z0-9-]*:(\\d{12})?:[^\\s]{1,1500}$', maxLength: 1600 })
const Arns = Type.Array(Arn, { minItems: 1, maxItems: 20 })

/** ARN service parts the assistant may tag. shortcut: a hand-kept list of common services; extend it when one is missing. */
const TAGGABLE = new Set([
  'ec2', 'rds', 'lambda', 's3', 'dynamodb', 'ecs', 'logs', 'sns', 'sqs', 'elasticloadbalancing', 'cloudwatch', 'elasticache', 'es',
  'kinesis', 'firehose', 'apigateway', 'states', 'events', 'ecr', 'eks', 'elasticfilesystem', 'fsx', 'backup', 'glue', 'athena'
])
/** Their tags drive access to identities, keys, secrets or audit: refused with a reason. */
const ABAC_GUARDED: Record<string, string> = {
  iam: 'IAM', sts: 'STS', kms: 'KMS', secretsmanager: 'Secrets Manager', ssm: 'SSM', organizations: 'Organizations', sso: 'SSO',
  'sso-admin': 'SSO', cloudtrail: 'CloudTrail', guardduty: 'GuardDuty', config: 'AWS Config', securityhub: 'Security Hub', 'access-analyzer': 'Access Analyzer'
}
/** Keys that commonly carry meaning beyond a label: ABAC conditions, cost allocation, this app's production detection. */
const MEANINGFUL_KEY = /^(name|env|environment|stage|owner|team|access.*)$/i

const parts = (arn: string): { service: string; region: string; account: string } => {
  const [, , service = '', region = '', account = ''] = arn.split(':')
  return { service, region, account }
}

interface TagSnapshot {
  account: string
  region: string
  /** ARN → tags, for the ARNs that passed the checks (never-tagged resources: {}). */
  tags: Record<string, Record<string, string>>
}

/** Why an ARN can't be tagged from this proposal, or null. */
function refusal(arn: string, s: { account: string; region: string }): string | null {
  const a = parts(arn)
  const guarded = ABAC_GUARDED[a.service]
  if (guarded) return `${arn}：${guarded} 资源的标签可能用于权限判断（ABAC），助手不能修改`
  if (!TAGGABLE.has(a.service)) return `${arn}：不支持给 ${a.service} 资源打标签（支持：${[...TAGGABLE].join(' ')}）`
  if (a.account && a.account !== s.account) return `${arn}：不属于当前账号 ${s.account}`
  if (a.region && a.region !== s.region) return `${arn}：在 ${a.region}，提案的 region 是 ${s.region}（请在提案里传对应的 region）`
  return null
}

async function tagSnapshot(arns: string[], ctx: ChangeCtx): Promise<TagSnapshot> {
  const account = (await ctx.call('sts', 'GetCallerIdentity', {})).Account ?? ''
  const at = { account, region: ctx.region }
  const ok = arns.filter((arn) => !refusal(arn, at))
  const tags: TagSnapshot['tags'] = Object.fromEntries(ok.map((arn) => [arn, {}]))
  if (ok.length) {
    const r = await ctx.call('tag', 'GetResources', { ResourceARNList: ok })
    for (const m of r.ResourceTagMappingList ?? []) if (tags[m.ResourceARN]) tags[m.ResourceARN] = tagMap(m.Tags)
  }
  return { ...at, tags }
}

/** Common risk rules: meaningful keys → medium; an env=prod tag going away gets its own reason. */
function tagPlan(p: { ResourceARNList: string[] }, s: TagSnapshot, verb: string, keys: string[], afterOf: (current: Record<string, string>) => Record<string, string>): Plan {
  const many = Object.keys(s.tags).length > 1
  const rows = Object.entries(s.tags).flatMap(([arn, current]) => rowsOf(fieldDiff(current, afterOf(current)), (k) => `标签 ${k}`, many ? arn : undefined))
  const prodLost = Object.values(s.tags).some((current) => isProdTagged(current) && !isProdTagged(afterOf(current)))
  const meaningful = keys.filter((k) => MEANINGFUL_KEY.test(k))
  const reasons = ['只改标签']
  if (meaningful.length) reasons.push(`涉及 ${meaningful.join('、')}：可能影响基于标签的权限（ABAC）、成本分摊和本应用的生产识别`)
  if (prodLost) reasons.push('会去掉生产环境标签（env=prod 等）：之后的提案不再因此升一级风险')
  const refused = p.ResourceARNList.flatMap((arn) => refusal(arn, s) ?? [])
  return {
    title: `${verb} ${p.ResourceARNList.length} 个资源的标签`,
    targets: p.ResourceARNList,
    confirmText: p.ResourceARNList.length === 1 ? (p.ResourceARNList[0].split(/[:/]/).pop() ?? p.ResourceARNList[0]) : `${p.ResourceARNList.length} 个资源`,
    risk: meaningful.length || prodLost ? 'medium' : 'low',
    reasons,
    change: { kind: 'modify', rows },
    consequences: [{ kind: 'dependency', text: '依赖标签的东西会受影响：IAM / 资源策略里的标签条件、成本分摊、自动化脚本、按标签筛选的备份和扩缩容策略' }],
    blockers: refused.length ? refused : rows.length ? [] : ['没有变更'],
    tags: Object.values(s.tags)
  }
}

/** TagResources / UntagResources answer 200 even when some resources failed: that is a failure, not a success. */
function checkFailures(r: any, verb: string): any {
  const failed = Object.entries((r?.FailedResourcesMap ?? {}) as Record<string, { ErrorCode?: string; StatusCode?: number; ErrorMessage?: string }>)
  if (failed.length) {
    throw new Error(`${failed.length} 个资源${verb}标签失败（其余资源已修改）：${failed.map(([arn, f]) => `${arn}（${f.ErrorCode ?? f.StatusCode ?? '?'}${f.ErrorMessage ? `: ${f.ErrorMessage}` : ''}）`).join('；')}`.slice(0, 1000))
  }
  return r
}

const verifyTags = async (p: { ResourceARNList: string[] }, ctx: ChangeCtx): Promise<string> => {
  const s = await tagSnapshot(p.ResourceARNList, ctx)
  return Object.entries(s.tags)
    .map(([arn, t]) => `${arn.split(/[:/]/).pop()}: ${show(t)}`)
    .join('，')
}

const normalizeArns = (arns: string[]): string[] => [...new Set(arns)].sort()

type TagParams = { ResourceARNList: string[]; Tags: Record<string, string> }

export const tagResources: ChangeAdapter<TagParams, TagSnapshot> = {
  service: 'tag',
  action: 'TagResources',
  doc: 'ResourceARNList: string[]（ARN，≤20，需在提案的账号和 region）；Tags: {键: 值}（≤20，不能以 aws: 开头）。不支持 IAM / KMS / Secrets Manager 等资源',
  schema: Type.Object(
    { ResourceARNList: Arns, Tags: Type.Record(Type.String(), Type.String({ maxLength: 256, pattern: '^[^\\u0000-\\u001f]*$' }), { minProperties: 1, maxProperties: 20, propertyNames: TAG_KEY }) },
    Strict
  ),
  normalize: (p) => ({ ResourceARNList: normalizeArns(p.ResourceARNList), Tags: Object.fromEntries(Object.entries(p.Tags).sort(([a], [b]) => a.localeCompare(b))) }),
  snapshot: (p, ctx) => tagSnapshot(p.ResourceARNList, ctx),
  arns: (p) => p.ResourceARNList,
  plan: (p, s) => tagPlan(p, s, '设置', Object.keys(p.Tags), (current) => ({ ...current, ...p.Tags })),
  execute: async (p, _s, ctx) => checkFailures(await ctx.call('tag', 'TagResources', { ResourceARNList: p.ResourceARNList, Tags: p.Tags }), '设置'),
  verify: verifyTags
}

type UntagParams = { ResourceARNList: string[]; TagKeys: string[] }

export const untagResources: ChangeAdapter<UntagParams, TagSnapshot> = {
  service: 'tag',
  action: 'UntagResources',
  doc: 'ResourceARNList: string[]（ARN，≤20）；TagKeys: string[]（≤20）',
  schema: Type.Object({ ResourceARNList: Arns, TagKeys: Type.Array(Type.String(TAG_KEY), { minItems: 1, maxItems: 20 }) }, Strict),
  normalize: (p) => ({ ResourceARNList: normalizeArns(p.ResourceARNList), TagKeys: [...new Set(p.TagKeys)].sort() }),
  snapshot: (p, ctx) => tagSnapshot(p.ResourceARNList, ctx),
  arns: (p) => p.ResourceARNList,
  plan: (p, s) => tagPlan(p, s, '删除', p.TagKeys, (current) => Object.fromEntries(Object.entries(current).filter(([k]) => !p.TagKeys.includes(k)))),
  execute: async (p, _s, ctx) => checkFailures(await ctx.call('tag', 'UntagResources', { ResourceARNList: p.ResourceARNList, TagKeys: p.TagKeys }), '删除'),
  verify: verifyTags
}

export const TAGGING_ADAPTERS = [tagResources, untagResources]
