/**
 * CloudFormation through a change set (plan §9.3): proposing creates the change set (a plan; it changes no resource),
 * the card shows its Changes, confirming executes it, and a cancelled, expired or drifted proposal deletes it.
 * Only updates of existing stacks; no capabilities (so no IAM resources), no service role, inline templates only.
 * A model-written template is scanned before the change set exists (no transforms / macros, roles, UserData, inline
 * policies), and change sets that touch IAM, custom resources, security services or resource policies are refused.
 */
import { Type } from 'typebox'
import { NONE, sleep, type ChangeAdapter, type ChangeCtx, type ChangeRow, type Plan } from './common'

const Strict = { additionalProperties: false }

type CfnParams = {
  StackName: string
  TemplateBody?: string
  UsePreviousTemplate?: boolean
  Parameters?: { ParameterKey: string; ParameterValue?: string; UsePreviousValue?: boolean }[]
  /** Set by main: ai-<proposal id>. */
  ChangeSetName?: string
}

interface Change {
  action: string
  logicalId: string
  physicalId: string
  type: string
  replacement: string
}

interface CfnSnapshot {
  status: string
  executionStatus: string
  statusReason: string
  stackStatus: string
  lastUpdated: string
  changes: Change[]
}

/**
 * Resource types a change set may not touch: privilege, code that runs during deployment, audit and key services, and
 * the same exposure the forbidden-action list blocks (resource policies, function URLs, SSM, peering, schedulers that
 * run code with a role).
 */
export const FORBIDDEN_RESOURCE_TYPES =
  /^(?:AWS::IAM::|AWS::SSO::|AWS::Organizations::|AWS::CloudTrail::|AWS::GuardDuty::|AWS::Config::|AWS::SecurityHub::|AWS::KMS::|AWS::SecretsManager::|AWS::CloudFormation::(?:CustomResource|Macro|Stack|StackSet)|Custom::|AWS::Lambda::(?:Permission|Url|LayerVersionPermission)|AWS::S3::(?:BucketPolicy|AccessPoint|MultiRegionAccessPointPolicy)|AWS::SNS::TopicPolicy|AWS::SQS::QueuePolicy|AWS::SSM::|AWS::EC2::(?:VPCPeeringConnection|KeyPair)|AWS::Events::Rule|AWS::Scheduler::|AWS::ECR::RepositoryPolicy)/

/**
 * What a model-written template may not contain, by name, since the card shows resource types, not properties: macros
 * and includes (they run or fetch at change-set creation, before any confirmation), roles and instance profiles
 * (iam:PassRole), boot scripts and inline policies. Matched as text, so JSON and YAML alike; false positives refuse.
 */
const TEMPLATE_FORBIDDEN: [RegExp, string, string][] = [
  [/\bTransform\b|Fn::Transform|AWS::Include|AWS::Serverless/, '模板转换 / 宏（Transform、AWS::Include）会在创建 change set 时运行', '模板转换 / 宏'],
  [/\b\w*Role(?:Arn|ARN|Name)?\b\s*["']?\s*:/, '给资源指定 IAM 角色等于 iam:PassRole', 'IAM 角色（iam:PassRole 类）'],
  [/\b(?:IamInstanceProfile|InstanceProfile\w*)\b/, '实例角色等于 iam:PassRole', '实例角色（iam:PassRole 类）'],
  [/\bUserData\b/, '启动脚本（UserData）会以 root 执行任意代码', '启动脚本（UserData）'],
  [/\b(?:PolicyDocument|Policies|KeyPolicy|ResourcePolicy|AccessPolicies)\b/, '内联策略会改变访问控制', '内联策略']
]

/** Why a model-written template is refused, or null. */
export function templateProblem(body: string): string | null {
  const hit = TEMPLATE_FORBIDDEN.find(([re]) => re.test(body))
  return hit ? `模板不能由助手提交：${hit[1]}。请在 Console 里部署这个模板` : null
}

/** The same scan as a neutral category for a generic request's banner, or null. */
export function templateCategory(body: string): string | null {
  const hit = TEMPLATE_FORBIDDEN.find(([re]) => re.test(body))
  return hit ? `模板含${hit[2]}` : null
}

const UPDATABLE = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE', 'IMPORT_ROLLBACK_COMPLETE'])
export const POLL_MS = 1000
const POLL_LIMIT = 30

async function describeChangeSet(p: CfnParams, ctx: ChangeCtx): Promise<any> {
  return ctx.call('cloudformation', 'DescribeChangeSet', { StackName: p.StackName, ChangeSetName: p.ChangeSetName })
}

export const createChangeSet: ChangeAdapter<CfnParams, CfnSnapshot> = {
  service: 'cloudformation',
  action: 'CreateChangeSet',
  doc: 'StackName（已有 stack）；TemplateBody（内联模板，≤51200 字符）或 UsePreviousTemplate: true；Parameters?: {ParameterKey, ParameterValue? | UsePreviousValue?}[]。提案时只创建 change set（不改资源），确认后才执行',
  schema: Type.Object(
    {
      StackName: Type.String({ pattern: '^[a-zA-Z][-a-zA-Z0-9]{0,127}$' }),
      TemplateBody: Type.Optional(Type.String({ minLength: 1, maxLength: 51200 })),
      UsePreviousTemplate: Type.Optional(Type.Boolean()),
      Parameters: Type.Optional(
        Type.Array(
          Type.Object({ ParameterKey: Type.String({ pattern: '^[a-zA-Z0-9]{1,255}$' }), ParameterValue: Type.Optional(Type.String({ maxLength: 4096 })), UsePreviousValue: Type.Optional(Type.Boolean()) }, Strict),
          { maxItems: 60 }
        )
      )
    },
    Strict
  ),
  forbiddenParams: {
    Capabilities: '不能授予 CAPABILITY_IAM / NAMED_IAM / AUTO_EXPAND：含 IAM 资源或宏的模板请在 Console 里部署',
    RoleARN: '指定服务角色等于 iam:PassRole，属于提权路径，已禁止',
    TemplateURL: '只接受内联模板（TemplateBody）',
    ChangeSetType: '只支持更新已有 stack',
    ChangeSetName: 'change set 名称由应用生成',
    ResourcesToImport: '不支持导入资源',
    NotificationARNs: '不支持修改通知',
    IncludeNestedStacks: '不支持嵌套 stack',
    ImportExistingResources: '不支持导入资源',
    OnStackFailure: '不支持',
    Tags: '修改 stack 标签会作用到全部资源，不支持'
  },
  normalize(p, ctx) {
    // Before prepare: a refused template never reaches CloudFormation, not even as a change set to clean up.
    const bad = p.TemplateBody ? templateProblem(p.TemplateBody) : null
    if (bad) throw new Error(bad)
    return { ...p, ChangeSetName: `ai-${ctx.proposalId}` }
  },
  async prepare(p, ctx) {
    if (Boolean(p.TemplateBody) === Boolean(p.UsePreviousTemplate)) throw new Error('TemplateBody 和 UsePreviousTemplate: true 必须二选一')
    const stack = (await ctx.call('cloudformation', 'DescribeStacks', { StackName: p.StackName })).Stacks?.[0]
    if (!stack) throw new Error(`找不到 stack ${p.StackName}`)
    if (!UPDATABLE.has(stack.StackStatus)) throw new Error(`stack ${p.StackName} 当前是 ${stack.StackStatus}，不能更新`)
    // A service role deploys with its own permissions, whatever the caller's: no model-written template under it.
    if (p.TemplateBody && stack.RoleARN) throw new Error(`stack ${p.StackName} 使用服务角色部署，助手只能改参数（UsePreviousTemplate），不能提交新模板`)
    await ctx.call('cloudformation', 'CreateChangeSet', {
      StackName: p.StackName,
      ChangeSetName: p.ChangeSetName,
      ChangeSetType: 'UPDATE',
      Description: `AWS Console Hub AI 提案 ${ctx.proposalId}`,
      ...(p.TemplateBody ? { TemplateBody: p.TemplateBody } : { UsePreviousTemplate: true }),
      ...(p.Parameters && { Parameters: p.Parameters })
    })
    for (let i = 0; i < POLL_LIMIT; i++) {
      const cs = await describeChangeSet(p, ctx)
      if (cs.Status === 'CREATE_COMPLETE') return
      if (cs.Status === 'FAILED') throw new Error(`change set 创建失败：${String(cs.StatusReason ?? '').slice(0, 300)}`)
      await sleep(POLL_MS)
    }
    throw new Error('change set 创建超时（30 秒）')
  },
  async snapshot(p, ctx) {
    const cs = await describeChangeSet(p, ctx)
    const stack = (await ctx.call('cloudformation', 'DescribeStacks', { StackName: p.StackName })).Stacks?.[0]
    return {
      status: cs.Status ?? '',
      executionStatus: cs.ExecutionStatus ?? '',
      statusReason: String(cs.StatusReason ?? '').slice(0, 300),
      stackStatus: stack?.StackStatus ?? '',
      lastUpdated: String(stack?.LastUpdatedTime ?? stack?.CreationTime ?? ''),
      changes: (cs.Changes ?? []).map((c: any) => ({
        action: c.ResourceChange?.Action ?? '',
        logicalId: c.ResourceChange?.LogicalResourceId ?? '',
        physicalId: c.ResourceChange?.PhysicalResourceId ?? '',
        type: c.ResourceChange?.ResourceType ?? '',
        replacement: c.ResourceChange?.Replacement ?? 'False'
      }))
    }
  },
  plan(p, s): Plan {
    const removes = s.changes.filter((c) => c.action === 'Remove')
    const replaces = s.changes.filter((c) => c.action === 'Modify' && c.replacement !== 'False')
    const forbidden = s.changes.filter((c) => FORBIDDEN_RESOURCE_TYPES.test(c.type))
    const rows: ChangeRow[] = s.changes.slice(0, 200).map((c) => ({
      item: `${c.logicalId}（${c.type}）`,
      before: c.physicalId || NONE,
      after:
        c.action === 'Add'
          ? '新建'
          : c.action === 'Remove'
            ? '删除'
            : c.replacement === 'True'
              ? '替换（先建新的再删旧的）'
              : c.replacement === 'Conditional'
                ? '修改（可能替换）'
                : '原地修改'
    }))
    const reasons = ['通过 change set 更新 stack']
    if (removes.length) reasons.push(`删除 ${removes.length} 个资源`)
    if (replaces.length) reasons.push(`${replaces.length} 个资源会被替换（或可能被替换）`)
    return {
      title: `执行 change set：更新 stack ${p.StackName}（${s.changes.length} 处变更）`,
      targets: [p.StackName],
      confirmText: p.StackName,
      risk: removes.length ? 'destructive' : replaces.length ? 'high' : 'medium',
      reasons,
      change: {
        kind: 'modify',
        rows,
        ...(removes.length && { removed: removes.map((c) => ({ name: `${c.logicalId}（${c.type}）`, ...(c.physicalId && { detail: c.physicalId }) })) })
      },
      consequences: [
        ...removes.map((c) => ({ kind: 'irreversible' as const, text: `${c.logicalId}（${c.type}）会被删除${c.physicalId ? `：${c.physicalId}` : ''}（DeletionPolicy=Retain 的除外）` })),
        ...replaces.map((c) => ({ kind: 'data' as const, text: `${c.logicalId}（${c.type}）${c.replacement === 'True' ? '会' : '可能'}被替换：新资源的 id 会变，旧资源上的数据可能丢失` })),
        { kind: 'dependency', text: '执行失败时 CloudFormation 会自动回滚' },
        { kind: 'dependency', text: '取消、过期或状态变化时，这个 change set 会被删除' }
      ],
      blockers: [
        ...(s.status !== 'CREATE_COMPLETE' || s.executionStatus !== 'AVAILABLE' ? [`change set 不可执行（${s.status} / ${s.executionStatus}）：${s.statusReason}`] : []),
        ...(s.changes.length === 0 ? ['change set 里没有任何变更'] : []),
        ...(forbidden.length ? [`change set 涉及不允许的资源类型：${[...new Set(forbidden.map((c) => c.type))].join(', ')}（IAM、自定义资源、审计和密钥服务请在 Console 里操作）`] : [])
      ]
    }
  },
  execute: (p, _s, ctx) => ctx.call('cloudformation', 'ExecuteChangeSet', { StackName: p.StackName, ChangeSetName: p.ChangeSetName }),
  verify: async (p, ctx) => {
    const stack = (await ctx.call('cloudformation', 'DescribeStacks', { StackName: p.StackName })).Stacks?.[0]
    return `${p.StackName}: ${stack?.StackStatus ?? '?'}`
  },
  discard: async (p, ctx) => {
    await ctx.call('cloudformation', 'DeleteChangeSet', { StackName: p.StackName, ChangeSetName: p.ChangeSetName })
  },
  redact: (p) => ({ ...p, ...(p.TemplateBody && { TemplateBody: `[模板 ${p.TemplateBody.length} 字符]` }) })
}
