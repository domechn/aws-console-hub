/** Change adapters for RDS, Lambda, S3, ECS and Auto Scaling (plan §9.3). None of these APIs has a DryRun. */
import { Type } from 'typebox'
import type { Risk } from '../../../shared/ai'
import {
  awsError,
  fieldDiff,
  fingerprint,
  monthly,
  RDS_HOURLY,
  riskAtLeast,
  rowsOf,
  show,
  stateLabel,
  tagMap,
  usd,
  type Change,
  type ChangeAdapter,
  type ChangeCtx,
  type ChangeRow,
  type Consequence,
  type Plan
} from './common'

const Strict = { additionalProperties: false }

// ---- RDS ----

const DbId = Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9-]{0,62}$' })

interface Db {
  id: string
  status: string
  engine: string
  class: string
  multiAZ: boolean
  deletionProtection: boolean
  cluster: string | null
  replicas: string[]
  replicaOf: string | null
  backupRetention: number
  storage: number
  /** ddd:hh24:mi-ddd:hh24:mi, UTC. */
  maintenanceWindow: string
  /** Modifications already waiting for the maintenance window. */
  pending: Record<string, unknown>
  tags: Record<string, string>
}

async function describeDb(id: string, ctx: ChangeCtx): Promise<Db> {
  const d = (await ctx.call('rds', 'DescribeDBInstances', { DBInstanceIdentifier: id })).DBInstances?.[0]
  if (!d) throw new Error(`${ctx.region} 里找不到数据库实例 ${id}`)
  return {
    id: d.DBInstanceIdentifier,
    status: d.DBInstanceStatus ?? 'unknown',
    engine: `${d.Engine ?? ''} ${d.EngineVersion ?? ''}`.trim(),
    class: d.DBInstanceClass ?? '',
    multiAZ: d.MultiAZ === true,
    deletionProtection: d.DeletionProtection === true,
    cluster: d.DBClusterIdentifier ?? null,
    replicas: [...(d.ReadReplicaDBInstanceIdentifiers ?? [])].sort(),
    replicaOf: d.ReadReplicaSourceDBInstanceIdentifier ?? null,
    backupRetention: d.BackupRetentionPeriod ?? 0,
    storage: d.AllocatedStorage ?? 0,
    maintenanceWindow: d.PreferredMaintenanceWindow ?? '',
    pending: d.PendingModifiedValues ?? {},
    tags: tagMap(d.TagList)
  }
}

const dbLabel = (d: Db): string => `${d.id}（${d.engine} · ${d.class}）`
const dbState = (d: Db, to: string): Change => ({ kind: 'state', states: [{ name: dbLabel(d), from: stateLabel(d.status), to }] })
const statusIs = (d: Db, status: string, verb: string): string[] => (d.status === status ? [] : [`${d.id} 当前是 ${d.status}，只能${verb} ${status} 的实例`])
const verifyDb = async (p: { DBInstanceIdentifier: string }, ctx: ChangeCtx): Promise<string> => {
  const d = await describeDb(p.DBInstanceIdentifier, ctx)
  return `${d.id}: ${d.status}`
}

type DbParams = { DBInstanceIdentifier: string }
const dbArn = (p: DbParams, at: { region: string; account: string }): string[] => [`arn:aws:rds:${at.region}:${at.account}:db:${p.DBInstanceIdentifier}`]

export const stopDb: ChangeAdapter<DbParams, Db> = {
  service: 'rds',
  action: 'StopDBInstance',
  doc: 'DBInstanceIdentifier',
  schema: Type.Object({ DBInstanceIdentifier: DbId }, Strict),
  forbiddenParams: { DBSnapshotIdentifier: '停止前快照请单独在 Console 里做' },
  snapshot: (p, ctx) => describeDb(p.DBInstanceIdentifier, ctx),
  arns: dbArn,
  plan: (p, d): Plan => ({
    title: `停止数据库 ${dbLabel(d)}`,
    targets: [d.id],
    confirmText: d.id,
    risk: 'medium',
    reasons: ['停止数据库会断开所有连接'],
    change: dbState(d, stateLabel('stopped')),
    consequences: [
      { kind: 'downtime', text: '数据库停止，所有连接断开，依赖它的应用会报错，直到重新启动' },
      { kind: 'dependency', text: '停止 7 天后 AWS 会自动重新启动它' },
      { kind: 'cost', text: '停止期间不收实例费，存储和备份继续计费' }
    ],
    blockers: [
      ...statusIs(d, 'available', '停止'),
      ...(d.cluster ? [`${d.id} 属于 Aurora 集群 ${d.cluster}，要停止整个集群（不支持）`] : []),
      ...(d.replicas.length || d.replicaOf ? [`${d.id} 有只读副本关系，RDS 不允许停止`] : [])
    ],
    tags: [d.tags]
  }),
  verify: verifyDb
}

export const startDb: ChangeAdapter<DbParams, Db> = {
  service: 'rds',
  action: 'StartDBInstance',
  doc: 'DBInstanceIdentifier',
  schema: Type.Object({ DBInstanceIdentifier: DbId }, Strict),
  snapshot: (p, ctx) => describeDb(p.DBInstanceIdentifier, ctx),
  arns: dbArn,
  plan: (p, d): Plan => {
    const cost = monthly(RDS_HOURLY, d.class)
    return {
      title: `启动数据库 ${dbLabel(d)}`,
      targets: [d.id],
      confirmText: d.id,
      risk: 'low',
      reasons: ['启动已停止的数据库'],
      change: dbState(d, stateLabel('available')),
      consequences: [
        {
          kind: 'cost',
          text: `开始收实例费：参考价约 ${cost !== undefined ? `${usd(cost * (d.multiAZ ? 2 : 1))}/月` : '未知'}（us-east-1${d.multiAZ ? '，Multi-AZ 按两倍' : ''}）`,
          ...(cost !== undefined && { monthlyUsd: cost * (d.multiAZ ? 2 : 1) })
        }
      ],
      blockers: statusIs(d, 'stopped', '启动'),
      tags: [d.tags]
    }
  },
  verify: verifyDb
}

export const rebootDb: ChangeAdapter<DbParams & { ForceFailover?: boolean }, Db> = {
  service: 'rds',
  action: 'RebootDBInstance',
  doc: 'DBInstanceIdentifier；ForceFailover?: boolean（仅 Multi-AZ）',
  schema: Type.Object({ DBInstanceIdentifier: DbId, ForceFailover: Type.Optional(Type.Boolean()) }, Strict),
  snapshot: (p, ctx) => describeDb(p.DBInstanceIdentifier, ctx),
  arns: dbArn,
  plan: (p, d): Plan => ({
    title: `重启数据库 ${dbLabel(d)}${p.ForceFailover ? '（强制故障转移）' : ''}`,
    targets: [d.id],
    confirmText: d.id,
    risk: p.ForceFailover ? 'high' : 'medium',
    reasons: ['重启期间数据库不可用', ...(p.ForceFailover ? ['强制切换到备用可用区'] : [])],
    change: dbState(d, '重启后可用'),
    consequences: [{ kind: 'downtime', text: '重启期间连接全部断开，通常几十秒到几分钟' }],
    blockers: [...statusIs(d, 'available', '重启'), ...(p.ForceFailover && !d.multiAZ ? [`${d.id} 不是 Multi-AZ，不能强制故障转移`] : [])],
    tags: [d.tags]
  }),
  verify: verifyDb
}

type DeleteDbParams = DbParams & { SkipFinalSnapshot: boolean; FinalDBSnapshotIdentifier?: string; DeleteAutomatedBackups?: boolean }

export const deleteDb: ChangeAdapter<DeleteDbParams, Db> = {
  service: 'rds',
  action: 'DeleteDBInstance',
  doc: 'DBInstanceIdentifier；SkipFinalSnapshot: boolean（必填）；FinalDBSnapshotIdentifier?（不跳过时的快照名，默认自动生成）；DeleteAutomatedBackups?: boolean（AWS 默认 true）',
  schema: Type.Object(
    {
      DBInstanceIdentifier: DbId,
      SkipFinalSnapshot: Type.Boolean(),
      FinalDBSnapshotIdentifier: Type.Optional(Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9-]{0,254}$' })),
      DeleteAutomatedBackups: Type.Optional(Type.Boolean())
    },
    Strict
  ),
  normalize: (p, ctx) =>
    p.SkipFinalSnapshot
      ? { DBInstanceIdentifier: p.DBInstanceIdentifier, SkipFinalSnapshot: true, ...(p.DeleteAutomatedBackups !== undefined && { DeleteAutomatedBackups: p.DeleteAutomatedBackups }) }
      : { ...p, FinalDBSnapshotIdentifier: p.FinalDBSnapshotIdentifier ?? `${p.DBInstanceIdentifier}-final-${ctx.proposalId.slice(2)}`.slice(0, 255) },
  snapshot: (p, ctx) => describeDb(p.DBInstanceIdentifier, ctx),
  arns: dbArn,
  plan: (p, d): Plan => {
    const dropsBackups = p.DeleteAutomatedBackups !== false
    const reasons = ['删除数据库实例']
    if (p.SkipFinalSnapshot && !d.cluster) reasons.push('跳过最终快照：删除后数据无法恢复')
    if (dropsBackups) reasons.push('自动备份会一起删除')
    return {
      title: `删除数据库 ${dbLabel(d)}`,
      targets: [d.id],
      confirmText: d.id,
      risk: 'destructive',
      reasons,
      change: {
        kind: 'delete',
        removed: [
          { name: `数据库 ${d.id}`, detail: `${d.engine} · ${d.class} · ${stateLabel(d.status)}` },
          ...(dropsBackups ? [{ name: '自动备份', detail: `保留 ${d.backupRetention} 天的时间点恢复` }] : [])
        ],
        kept: [
          ...(p.SkipFinalSnapshot || d.cluster ? [] : [`最终快照 ${p.FinalDBSnapshotIdentifier ?? ''}（删除前创建）`]),
          ...(dropsBackups ? [] : [`自动备份（保留 ${d.backupRetention} 天）`]),
          ...(d.cluster ? [`Aurora 集群 ${d.cluster} 和其中的数据`] : []),
          '已有的手动快照'
        ]
      },
      consequences: [
        { kind: 'irreversible', text: '数据库实例删除后无法恢复' },
        ...(p.SkipFinalSnapshot && !d.cluster
          ? [{ kind: 'data' as const, text: '不保留最终快照：数据只能从之前的手动快照恢复（如果有）' }]
          : d.cluster
            ? []
            : [{ kind: 'data' as const, text: `删除前会创建最终快照 ${p.FinalDBSnapshotIdentifier ?? ''}，快照按存储计费` }]),
        ...(dropsBackups ? [{ kind: 'data' as const, text: `自动备份（保留 ${d.backupRetention} 天）会一起删除，时间点恢复不再可用` }] : []),
        ...d.replicas.map((r) => ({ kind: 'dependency' as const, text: `只读副本 ${r} 会失去源实例` })),
        ...(d.cluster ? [{ kind: 'dependency' as const, text: `它是 Aurora 集群 ${d.cluster} 的成员；集群本身和数据不会因此删除` }] : []),
        { kind: 'downtime', text: '连接它的应用会立即失败' }
      ],
      blockers: [
        ...(d.deletionProtection ? [`${d.id} 开启了删除保护（DeletionProtection），请先在 Console 里关闭`] : []),
        ...(d.status === 'deleting' ? [`${d.id} 正在删除`] : [])
      ],
      tags: [d.tags]
    }
  },
  verify: async (p, ctx) => verifyDb(p, ctx).catch(() => `${p.DBInstanceIdentifier}: deleting`)
}

type ModifyDbParams = DbParams & { DBInstanceClass?: string; AllocatedStorage?: number; BackupRetentionPeriod?: number; ApplyImmediately: boolean }

const ONLY_MODIFY = '只支持修改实例类型（DBInstanceClass）、存储（AllocatedStorage）和备份保留天数（BackupRetentionPeriod）'

export const modifyDb: ChangeAdapter<ModifyDbParams, Db> = {
  service: 'rds',
  action: 'ModifyDBInstance',
  doc: 'DBInstanceIdentifier；DBInstanceClass?；AllocatedStorage?（GiB，只能增大）；BackupRetentionPeriod?: 0–35（0 = 关闭自动备份）；ApplyImmediately: boolean（必填：true 立即应用，false 在维护窗口应用）',
  schema: Type.Object(
    {
      DBInstanceIdentifier: DbId,
      DBInstanceClass: Type.Optional(Type.String({ pattern: '^db\\.[a-z0-9]+\\.[a-z0-9]+$', maxLength: 40 })),
      AllocatedStorage: Type.Optional(Type.Integer({ minimum: 5, maximum: 65536 })),
      BackupRetentionPeriod: Type.Optional(Type.Integer({ minimum: 0, maximum: 35 })),
      ApplyImmediately: Type.Boolean()
    },
    Strict
  ),
  forbiddenParams: {
    MasterUserPassword: '不能通过助手修改数据库密码',
    ManageMasterUserPassword: '不能通过助手修改数据库密码管理方式',
    PubliclyAccessible: '可能把数据库暴露到公网，请在 Console 里操作',
    VpcSecurityGroupIds: '修改网络访问请在 Console 里操作',
    DBSecurityGroups: '修改网络访问请在 Console 里操作',
    DBParameterGroupName: '参数组会改变数据库行为，请在 Console 里操作',
    OptionGroupName: '选项组会改变数据库行为，请在 Console 里操作',
    EngineVersion: '引擎升级请在 Console 里操作',
    AllowMajorVersionUpgrade: '引擎升级请在 Console 里操作',
    DeletionProtection: '删除保护只能在 Console 里改',
    NewDBInstanceIdentifier: '改名会改变连接地址，不支持',
    EnableIAMDatabaseAuthentication: '修改认证方式请在 Console 里操作',
    MonitoringRoleArn: '设置监控角色等于 iam:PassRole，属于提权路径，已禁止',
    DomainIAMRoleName: '设置目录服务角色等于 iam:PassRole，属于提权路径，已禁止',
    CACertificateIdentifier: '更换证书会影响客户端连接，请在 Console 里操作',
    StorageType: ONLY_MODIFY,
    Iops: ONLY_MODIFY,
    MultiAZ: ONLY_MODIFY
  },
  snapshot: (p, ctx) => describeDb(p.DBInstanceIdentifier, ctx),
  arns: dbArn,
  request: (p) => ({
    DBInstanceIdentifier: p.DBInstanceIdentifier,
    ...(p.DBInstanceClass !== undefined && { DBInstanceClass: p.DBInstanceClass }),
    ...(p.AllocatedStorage !== undefined && { AllocatedStorage: p.AllocatedStorage }),
    ...(p.BackupRetentionPeriod !== undefined && { BackupRetentionPeriod: p.BackupRetentionPeriod }),
    ApplyImmediately: p.ApplyImmediately
  }),
  plan(p, d): Plan {
    const classChange = p.DBInstanceClass !== undefined && p.DBInstanceClass !== d.class
    const storageChange = p.AllocatedStorage !== undefined && p.AllocatedStorage !== d.storage
    const retention = p.BackupRetentionPeriod
    const retentionChange = retention !== undefined && retention !== d.backupRetention
    const backupsOff = retentionChange && retention === 0
    // 0 ↔ non-zero turns automated backups on or off, which restarts the instance.
    const backupToggle = retentionChange && (retention === 0) !== (d.backupRetention === 0)
    const changed = classChange || storageChange || retentionChange
    const when = p.ApplyImmediately ? '立即' : `在下一个维护窗口（${d.maintenanceWindow || '未知'}，UTC）`
    const pending = Object.keys(d.pending).length > 0
    const risks: Risk[] = []
    const reasons: string[] = []
    const consequences: Consequence[] = []
    if (classChange) {
      risks.push('high')
      reasons.push('修改数据库实例类型会重启实例')
      consequences.push({
        kind: 'downtime',
        text: `${when}重启数据库：${d.multiAZ ? 'Multi-AZ 先改备用实例再故障转移，通常中断 1–2 分钟' : '单可用区，通常中断几分钟到十几分钟'}，期间连接全部断开`
      })
      const from = monthly(RDS_HOURLY, d.class)
      const to = monthly(RDS_HOURLY, p.DBInstanceClass)
      const factor = d.multiAZ ? 2 : 1
      consequences.push({
        kind: 'cost',
        text: `实例参考价 ${from !== undefined ? usd(from * factor) : '未知'}/月 → ${to !== undefined ? usd(to * factor) : '未知'}/月（us-east-1${d.multiAZ ? '，Multi-AZ 按两倍' : ''}）`,
        ...(to !== undefined && { monthlyUsd: to * factor })
      })
    }
    if (storageChange) {
      risks.push('medium')
      reasons.push(`存储 ${d.storage} → ${p.AllocatedStorage} GiB`)
      consequences.push(
        { kind: 'irreversible', text: 'RDS 存储只能增大，不能缩小' },
        { kind: 'downtime', text: `${when}应用；通常不停机，但存储优化期间性能可能下降，之后至少 6 小时（且优化完成前）不能再改存储` },
        { kind: 'cost', text: `存储按 GiB·月计费，增加 ${(p.AllocatedStorage ?? 0) - d.storage} GiB` }
      )
    }
    if (retentionChange) {
      if (backupsOff) {
        risks.push('destructive')
        reasons.push('关闭自动备份：现有自动备份会被删除，时间点恢复不再可用')
        consequences.push({ kind: 'irreversible', text: `现有的自动备份（保留 ${d.backupRetention} 天）会被删除，之后无法再做时间点恢复` })
      } else {
        risks.push(backupToggle || (retention ?? 0) < d.backupRetention ? 'medium' : 'low')
        reasons.push(`备份保留天数 ${d.backupRetention} → ${retention}`)
        if ((retention ?? 0) < d.backupRetention) consequences.push({ kind: 'data', text: `超过 ${retention} 天的自动备份会被删除` })
      }
      if (backupToggle) consequences.push({ kind: 'downtime', text: `${when}开启或关闭自动备份会造成一次短暂中断` })
    }
    if (pending) {
      consequences.push({
        kind: 'dependency',
        text: `已有等待维护窗口的修改：${show(d.pending)}${p.ApplyImmediately ? '。立即应用时，这些修改也会一起应用' : ''}`
      })
    }
    if (!p.ApplyImmediately && changed) {
      consequences.push({ kind: 'dependency', text: `修改会在维护窗口 ${d.maintenanceWindow || '（未知）'}（UTC）应用，在那之前不生效` })
    }
    const days = (n: number): string => (n === 0 ? '0 天（关闭自动备份）' : `${n} 天`)
    const rows: ChangeRow[] = [
      ...(classChange ? [{ item: '实例规格', before: d.class, after: p.DBInstanceClass as string }] : []),
      ...(storageChange ? [{ item: '存储大小', before: `${d.storage} GiB`, after: `${p.AllocatedStorage} GiB` }] : []),
      ...(retentionChange ? [{ item: '备份保留天数', before: days(d.backupRetention), after: days(retention ?? 0) }] : [])
    ]
    return {
      title: `修改数据库 ${dbLabel(d)}（${p.ApplyImmediately ? '立即应用' : '维护窗口应用'}）`,
      targets: [d.id],
      confirmText: d.id,
      risk: risks.reduce<Risk>((a, b) => riskAtLeast(a, b), 'low'),
      reasons,
      // When it applies is not a field of the database: shown next to the table, not as a row of it.
      change: { kind: 'modify', rows, ...(changed && { fields: [{ label: '应用时间', value: p.ApplyImmediately ? '立即应用' : `下一个维护窗口（${d.maintenanceWindow || '未知'}，UTC）` }] }) },
      consequences,
      blockers: [
        ...statusIs(d, 'available', '修改'),
        ...(d.cluster && (p.AllocatedStorage !== undefined || retention !== undefined) ? [`${d.id} 属于 Aurora 集群 ${d.cluster}，存储和备份保留期在集群级别设置（不支持）`] : []),
        ...(p.AllocatedStorage !== undefined && p.AllocatedStorage < d.storage ? [`RDS 存储只能增大：当前 ${d.storage} GiB，不能改成 ${p.AllocatedStorage} GiB`] : []),
        ...(changed ? [] : ['没有变更（值和现在一样，或没有给出要修改的字段）'])
      ],
      tags: [d.tags]
    }
  },
  verify: async (p, ctx) => {
    const d = await describeDb(p.DBInstanceIdentifier, ctx)
    return `${d.id}: ${d.status} · ${d.class} · ${d.storage} GiB · 备份 ${d.backupRetention} 天${Object.keys(d.pending).length ? ` · 待应用 ${show(d.pending)}` : ''}`
  }
}

// ---- Lambda ----

type LambdaParams = { FunctionName: string; MemorySize?: number; Timeout?: number; SetEnvironment?: Record<string, string>; RemoveEnvironment?: string[] }

interface LambdaSnapshot {
  name: string
  memory: number
  timeout: number
  revisionId: string
  updateStatus: string
  /** Variable name → fingerprint: drift sees value changes, the values themselves are not kept. */
  env: Record<string, string>
}

// Record keys go through propertyNames: a pattern key schema becomes patternProperties, which lets other keys
// (and their values) through unchecked.
const ENV_NAME = { pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,127}$' }
const EnvName = Type.String(ENV_NAME)

/**
 * Variables that make the runtime load other code, send traffic elsewhere or trust other certificates (NODE_OPTIONS
 * --import=data:…, AWS_LAMBDA_EXEC_WRAPPER, LD_PRELOAD, proxies…), or that Lambda reserves: never set by the assistant.
 */
export const RUNTIME_ENV =
  /^(?:AWS_|LAMBDA_|LD_|DYLD_|DOTNET_|CORECLR_|COR_|JAVA_|_JAVA|JDK_|PYTHON|PERL5|RUBY|GEM_|NODE_|NPM_CONFIG_|BUN_|DENO_)|^(?:PATH|HOME|ENV|BASH_ENV|SHELLOPTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|TZDIR)$/i
/** Values shown on the card unless the name says they are secret (they are the model's, not AWS data). */
const SECRET_ENV = /pass|secret|token|key|credential|auth|private|cert|dsn|url|uri|conn/i

async function lambdaConfig(name: string, ctx: ChangeCtx): Promise<any> {
  return ctx.call('lambda', 'GetFunctionConfiguration', { FunctionName: name })
}

export const updateLambdaConfig: ChangeAdapter<LambdaParams, LambdaSnapshot> = {
  service: 'lambda',
  action: 'UpdateFunctionConfiguration',
  doc: 'FunctionName；MemorySize?: 128–10240；Timeout?: 1–900（秒）；SetEnvironment?: {名: 值}（新增或覆盖）；RemoveEnvironment?: string[]（其他变量保持不变）',
  schema: Type.Object(
    {
      FunctionName: Type.String({ pattern: '^[a-zA-Z0-9-_:]{1,140}$' }),
      MemorySize: Type.Optional(Type.Integer({ minimum: 128, maximum: 10240 })),
      Timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 900 })),
      SetEnvironment: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 4096 }), { maxProperties: 20, propertyNames: ENV_NAME })),
      RemoveEnvironment: Type.Optional(Type.Array(EnvName, { minItems: 1, maxItems: 20 }))
    },
    Strict
  ),
  forbiddenParams: {
    Role: '修改执行角色等于 iam:PassRole，属于提权路径，已禁止',
    Layers: '层（Layers）会给函数注入代码，不支持',
    Environment: '请用 SetEnvironment / RemoveEnvironment，没提到的变量会保持不变',
    Handler: '只支持修改内存、超时和环境变量',
    Runtime: '只支持修改内存、超时和环境变量',
    KMSKeyArn: '只支持修改内存、超时和环境变量',
    VpcConfig: '只支持修改内存、超时和环境变量'
  },
  arns: (p, at) => [p.FunctionName.startsWith('arn:') ? p.FunctionName : `arn:aws:lambda:${at.region}:${at.account}:function:${p.FunctionName}`],
  async snapshot(p, ctx) {
    const c = await lambdaConfig(p.FunctionName, ctx)
    const vars: Record<string, string> = c.Environment?.Variables ?? {}
    return {
      name: c.FunctionName,
      memory: c.MemorySize ?? 128,
      timeout: c.Timeout ?? 3,
      revisionId: c.RevisionId ?? '',
      updateStatus: c.LastUpdateStatus ?? 'Successful',
      env: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, fingerprint(v)]))
    }
  },
  plan(p, s): Plan {
    const hidden = '[已隐藏]'
    const envBefore = Object.fromEntries(Object.keys(s.env).map((k) => [k, hidden]))
    const envAfter: Record<string, string> = { ...envBefore }
    // A hidden new value is how an injected NODE_OPTIONS would get confirmed unseen: new values show, secret-named excepted.
    for (const [k, v] of Object.entries(p.SetEnvironment ?? {})) envAfter[k] = s.env[k] === fingerprint(v) ? hidden : SECRET_ENV.test(k) ? `${hidden}（新值，${v.length} 字符）` : show(v)
    const runtime = Object.keys(p.SetEnvironment ?? {}).filter((k) => RUNTIME_ENV.test(k))
    for (const k of p.RemoveEnvironment ?? []) delete envAfter[k]
    const rows: ChangeRow[] = [
      ...(p.MemorySize !== undefined && p.MemorySize !== s.memory ? [{ item: '内存', before: `${s.memory} MB`, after: `${p.MemorySize} MB` }] : []),
      ...(p.Timeout !== undefined && p.Timeout !== s.timeout ? [{ item: '超时', before: `${s.timeout} 秒`, after: `${p.Timeout} 秒` }] : []),
      ...rowsOf(fieldDiff(envBefore, envAfter), (k) => `环境变量 ${k}`)
    ]
    const consequences: Consequence[] = [{ kind: 'downtime', text: '没有停机：更新完成前的调用用旧配置，之后的调用用新配置' }]
    if (p.MemorySize && p.MemorySize !== s.memory) {
      consequences.push({ kind: 'cost', text: `按 GB·秒计费：内存 ${s.memory} → ${p.MemorySize} MB，同样时长的调用费用约 ×${(p.MemorySize / s.memory).toFixed(2)}（CPU 也随内存变化）` })
    }
    if (p.Timeout && p.Timeout < s.timeout) consequences.push({ kind: 'downtime', text: `超时从 ${s.timeout}s 缩短到 ${p.Timeout}s，运行更久的调用会被中止` })
    const envChange = Boolean(p.SetEnvironment || p.RemoveEnvironment)
    if (envChange) consequences.push({ kind: 'dependency', text: '函数代码读到的环境变量会变，行为可能随之改变；现有的值和名称像密钥的新值不在卡片和审计日志里显示' })
    const missing = (p.RemoveEnvironment ?? []).filter((k) => s.env[k] === undefined)
    return {
      title: `修改 Lambda 函数 ${s.name} 的配置`,
      targets: [s.name],
      confirmText: s.name,
      risk: envChange ? 'high' : 'medium',
      reasons: ['修改函数配置', ...(envChange ? ['修改环境变量会改变函数代码的行为，请逐个核对新值'] : [])],
      change: { kind: 'modify', rows },
      consequences,
      blockers: [
        ...(runtime.length ? [`不允许设置 ${runtime.join(', ')}：这类变量会让运行时加载其他代码、改走代理或被 Lambda 保留，请在 Console 里操作`] : []),
        ...(rows.length ? [] : ['没有变更（值和现在一样）']),
        ...(missing.length ? [`要删除的环境变量不存在：${missing.join(', ')}`] : []),
        ...(s.updateStatus === 'InProgress' ? ['函数上一次更新还没完成，请稍后再试'] : [])
      ]
    }
  },
  // The values themselves: read now, merged, and sent with RevisionId, so a change in between makes AWS refuse.
  async execute(p, s, ctx) {
    const c = await lambdaConfig(p.FunctionName, ctx)
    if ((c.RevisionId ?? '') !== s.revisionId) throw new Error('函数配置在确认期间被修改了，未执行')
    const env: Record<string, string> = { ...(c.Environment?.Variables ?? {}), ...(p.SetEnvironment ?? {}) }
    for (const k of p.RemoveEnvironment ?? []) delete env[k]
    return ctx.call('lambda', 'UpdateFunctionConfiguration', {
      FunctionName: p.FunctionName,
      ...(p.MemorySize !== undefined && { MemorySize: p.MemorySize }),
      ...(p.Timeout !== undefined && { Timeout: p.Timeout }),
      ...((p.SetEnvironment || p.RemoveEnvironment) && { Environment: { Variables: env } }),
      RevisionId: s.revisionId
    })
  },
  verify: async (p, ctx) => {
    const c = await lambdaConfig(p.FunctionName, ctx)
    return `${c.FunctionName}: ${c.MemorySize} MB · ${c.Timeout}s · ${c.LastUpdateStatus ?? ''}`
  },
  redact: (p) => ({ ...p, ...(p.SetEnvironment && { SetEnvironment: Object.fromEntries(Object.keys(p.SetEnvironment).map((k) => [k, '[redacted]'])) }) })
}

// ---- S3 (bucket level only) ----

const Bucket = Type.String({ pattern: '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' })
const bucketArn = (p: { Bucket: string }): string[] => [`arn:aws:s3:::${p.Bucket}`]

/** The bucket's own region: S3 rejects requests sent to another one. */
async function bucketRegion(bucket: string, call: ChangeCtx['call']): Promise<string> {
  const r = await call('s3', 'GetBucketLocation', { Bucket: bucket }, 'us-east-1')
  const c = r.LocationConstraint
  return !c ? 'us-east-1' : c === 'EU' ? 'eu-west-1' : c
}

type BucketTagParams = { Bucket: string; SetTags?: Record<string, string>; RemoveTags?: string[] }

async function bucketTags(bucket: string, ctx: ChangeCtx): Promise<Record<string, string>> {
  try {
    return tagMap((await ctx.call('s3', 'GetBucketTagging', { Bucket: bucket })).TagSet)
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchTagSet') return {}
    throw err
  }
}

const mergedTags = (p: BucketTagParams, current: Record<string, string>): Record<string, string> => {
  const out = { ...current, ...(p.SetTags ?? {}) }
  for (const k of p.RemoveTags ?? []) delete out[k]
  return out
}

const S3_TAG_KEY = { minLength: 1, maxLength: 128, pattern: '^(?!aws:)[^\\u0000-\\u001f]+$' }
const S3TagKey = Type.String(S3_TAG_KEY)

export const putBucketTagging: ChangeAdapter<BucketTagParams, { tags: Record<string, string> }> = {
  service: 's3',
  action: 'PutBucketTagging',
  doc: 'Bucket；SetTags?: {键: 值}；RemoveTags?: string[]（其他标签保持不变）',
  schema: Type.Object(
    {
      Bucket,
      SetTags: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 256, pattern: '^[^\\u0000-\\u001f]*$' }), { maxProperties: 20, propertyNames: S3_TAG_KEY })),
      RemoveTags: Type.Optional(Type.Array(S3TagKey, { minItems: 1, maxItems: 20 }))
    },
    Strict
  ),
  forbiddenParams: { Tagging: '请用 SetTags / RemoveTags，没提到的标签会保持不变' },
  locate: (p, call) => bucketRegion(p.Bucket, call),
  arns: bucketArn,
  snapshot: async (p, ctx) => ({ tags: await bucketTags(p.Bucket, ctx) }),
  plan(p, s): Plan {
    const after = mergedTags(p, s.tags)
    const rows = rowsOf(fieldDiff(s.tags, after), (k) => `标签 ${k}`)
    return {
      title: `修改 S3 桶 ${p.Bucket} 的标签`,
      targets: [p.Bucket],
      confirmText: p.Bucket,
      risk: 'low',
      reasons: ['只改标签'],
      change: { kind: 'modify', rows },
      consequences: [{ kind: 'dependency', text: '依赖标签的东西会受影响：成本分摊、IAM / 桶策略里的标签条件、自动化脚本' }],
      blockers: rows.length ? [] : ['没有变更'],
      tags: [s.tags]
    }
  },
  // PutBucketTagging replaces the whole set: merge into what is there now (the drift check just confirmed it).
  async execute(p, s, ctx) {
    const tags = mergedTags(p, s.tags)
    if (!Object.keys(tags).length) return ctx.call('s3', 'DeleteBucketTagging', { Bucket: p.Bucket })
    return ctx.call('s3', 'PutBucketTagging', { Bucket: p.Bucket, Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) } })
  }
}

export const putBucketVersioning: ChangeAdapter<{ Bucket: string; Status: 'Enabled' | 'Suspended' }, { status: string; mfaDelete: string }> = {
  service: 's3',
  action: 'PutBucketVersioning',
  doc: 'Bucket；Status: Enabled | Suspended',
  schema: Type.Object({ Bucket, Status: Type.Enum(['Enabled', 'Suspended']) }, Strict),
  forbiddenParams: { MFA: 'MFA Delete 只能由 root 用户在 Console / CLI 里设置', VersioningConfiguration: '请用 Status' },
  locate: (p, call) => bucketRegion(p.Bucket, call),
  arns: bucketArn,
  async snapshot(p, ctx) {
    const r = await ctx.call('s3', 'GetBucketVersioning', { Bucket: p.Bucket })
    return { status: r.Status ?? 'Off', mfaDelete: r.MFADelete ?? 'Disabled' }
  },
  request: (p) => ({ Bucket: p.Bucket, VersioningConfiguration: { Status: p.Status } }),
  plan: (p, s): Plan => ({
    title: `${p.Status === 'Enabled' ? '开启' : '暂停'} S3 桶 ${p.Bucket} 的版本控制`,
    targets: [p.Bucket],
    confirmText: p.Bucket,
    risk: p.Status === 'Enabled' ? 'low' : 'medium',
    reasons: [p.Status === 'Enabled' ? '开启版本控制' : '暂停版本控制：之后覆盖或删除的对象不再保留旧版本'],
    change: { kind: 'modify', rows: [{ item: '版本控制', before: stateLabel(s.status), after: stateLabel(p.Status) }] },
    consequences:
      p.Status === 'Enabled'
        ? [
            { kind: 'cost', text: '旧版本会一直占用存储并计费，建议配合生命周期规则清理' },
            { kind: 'irreversible', text: '开启后只能暂停，不能回到「从未开启」' }
          ]
        : [{ kind: 'data', text: '暂停后，覆盖或删除对象时不再保留旧版本（已有的版本不受影响）' }],
    blockers: s.status === p.Status ? [`版本控制已经是 ${p.Status}`] : []
  })
}

export const deleteBucket: ChangeAdapter<{ Bucket: string }, { objects: number; versions: number; tags: Record<string, string> }> = {
  service: 's3',
  action: 'DeleteBucket',
  doc: 'Bucket（只能删除空桶）',
  schema: Type.Object({ Bucket }, Strict),
  locate: (p, call) => bucketRegion(p.Bucket, call),
  arns: bucketArn,
  async snapshot(p, ctx) {
    const objects = (await ctx.call('s3', 'ListObjectsV2', { Bucket: p.Bucket, MaxKeys: 1 })).KeyCount ?? 0
    const v = await ctx.call('s3', 'ListObjectVersions', { Bucket: p.Bucket, MaxKeys: 1 })
    return { objects, versions: (v.Versions?.length ?? 0) + (v.DeleteMarkers?.length ?? 0), tags: await bucketTags(p.Bucket, ctx) }
  },
  plan: (p, s): Plan => ({
    title: `删除 S3 桶 ${p.Bucket}`,
    targets: [p.Bucket],
    confirmText: p.Bucket,
    risk: 'destructive',
    reasons: ['删除存储桶'],
    change: { kind: 'delete', removed: [{ name: `S3 桶 ${p.Bucket}`, detail: '空桶' }], kept: [] },
    consequences: [
      { kind: 'irreversible', text: '桶删除后，桶名会释放，可能被其他账号注册' },
      { kind: 'dependency', text: '引用这个桶的应用、CloudFront、日志投递、复制规则都会失败' }
    ],
    blockers: s.objects || s.versions ? [`桶不为空（还有对象或版本），助手只能删除空桶；请先在 Console 里清空`] : [],
    tags: [s.tags]
  })
}

/** S3 naming rules, including the reserved prefixes and suffixes and IP-like names. */
const NewBucket = Type.String({
  pattern: '^(?!xn--|sthree-|amzn-s3-demo-)(?!.*\\.\\.)(?!\\d+\\.\\d+\\.\\d+\\.\\d+$)(?!.*(-s3alias|--ol-s3|\\.mrap|--x-s3|--table-s3)$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
})
const ACL_REASON = 'ACL 可能把数据公开；新桶一律禁用 ACL（BucketOwnerEnforced）'
const PUBLIC_ACCESS_BLOCK = { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true }

type CreateBucketParams = { Bucket: string; Versioning?: boolean }
/** free: no bucket by that name. mine: this account's, in this region. taken: another account's. elsewhere: exists in another region (owner unknown). */
type BucketName = { exists: 'free' | 'mine' | 'taken' | 'elsewhere'; region: string }

export const createBucket: ChangeAdapter<CreateBucketParams, BucketName> = {
  service: 's3',
  action: 'CreateBucket',
  doc: 'Bucket（3–63 位小写字母、数字、- 和 .，全局唯一）；Versioning?: boolean（默认不开）。建在提案的 region；公开访问阻止始终开启、禁用 ACL',
  schema: Type.Object({ Bucket: NewBucket, Versioning: Type.Optional(Type.Boolean()) }, Strict),
  forbiddenParams: {
    ACL: ACL_REASON,
    GrantFullControl: ACL_REASON,
    GrantRead: ACL_REASON,
    GrantWrite: ACL_REASON,
    GrantReadACP: ACL_REASON,
    GrantWriteACP: ACL_REASON,
    ObjectOwnership: ACL_REASON,
    ObjectLockEnabledForBucket: '对象锁定开启后不能关闭，请在 Console 里创建',
    CreateBucketConfiguration: 'region 由提案的 region 决定（可在提案里传 region）'
  },
  iamActions: ['s3:CreateBucket', 's3:PutBucketOwnershipControls', 's3:PutBucketPublicAccessBlock', 's3:PutBucketVersioning'],
  arns: bucketArn,
  async snapshot(p, ctx) {
    try {
      await ctx.call('s3', 'HeadBucket', { Bucket: p.Bucket })
      return { exists: 'mine', region: ctx.region }
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      const status = e.$metadata?.httpStatusCode
      if (status === 404 || e.name === 'NotFound' || e.name === 'NoSuchBucket') return { exists: 'free', region: ctx.region }
      if (status === 403 || e.name === 'Forbidden') return { exists: 'taken', region: ctx.region }
      if (status === 301 || e.name === 'PermanentRedirect' || e.name === 'MovedPermanently') return { exists: 'elsewhere', region: ctx.region }
      throw err
    }
  },
  plan: (p, s): Plan => ({
    title: `创建 S3 桶 ${p.Bucket}（${s.region}）`,
    targets: [p.Bucket],
    confirmText: p.Bucket,
    risk: 'medium',
    reasons: ['新建存储桶'],
    change: {
      kind: 'create',
      fields: [
        { label: '桶名', value: p.Bucket },
        { label: 'Region', value: s.region },
        { label: '公开访问阻止', value: '全部开启（4 项）' },
        { label: '对象所有权', value: '禁用 ACL（BucketOwnerEnforced）' },
        { label: '版本控制', value: p.Versioning ? '开启' : '不开启' }
      ]
    },
    consequences: [
      { kind: 'cost', text: '按存储量、请求数和流量计费；空桶本身不收费' },
      ...(p.Versioning ? [{ kind: 'cost' as const, text: '开启版本控制后旧版本会一直占用存储并计费' }] : []),
      { kind: 'dependency', text: '桶名全局唯一；之后删除桶时名字会释放，可能被其他账号注册' },
      ...(p.Bucket.includes('.') ? [{ kind: 'dependency' as const, text: '桶名含点号：用 HTTPS 虚拟主机方式访问时证书不匹配，也不能用 Transfer Acceleration' }] : [])
    ],
    blockers:
      s.exists === 'free'
        ? []
        : [
            s.exists === 'mine'
              ? `桶 ${p.Bucket} 已存在（你的账号）`
              : s.exists === 'taken'
                ? `桶名 ${p.Bucket} 已被其他账号占用，请换一个名字`
                : `桶名 ${p.Bucket} 已存在于其他 region（可能属于其他账号），请换一个名字`
          ]
  }),
  // Public access block is always set, on top of S3's own default for new buckets; a failure after the bucket exists says so.
  async execute(p, _s, ctx) {
    const created = await ctx.call('s3', 'CreateBucket', {
      Bucket: p.Bucket,
      ObjectOwnership: 'BucketOwnerEnforced',
      ...(ctx.region !== 'us-east-1' && { CreateBucketConfiguration: { LocationConstraint: ctx.region } })
    })
    const step = async (what: string, call: () => Promise<unknown>): Promise<void> => {
      try {
        await call()
      } catch (err) {
        throw new Error(`桶 ${p.Bucket} 已创建，但${what}失败：${awsError(err)}。请在 Console 里检查这个桶的设置`)
      }
    }
    await step('开启公开访问阻止', () => ctx.call('s3', 'PutPublicAccessBlock', { Bucket: p.Bucket, PublicAccessBlockConfiguration: PUBLIC_ACCESS_BLOCK }))
    if (p.Versioning) await step('开启版本控制', () => ctx.call('s3', 'PutBucketVersioning', { Bucket: p.Bucket, VersioningConfiguration: { Status: 'Enabled' } }))
    return created
  },
  verify: async (p, ctx) => {
    const pab = (await ctx.call('s3', 'GetPublicAccessBlock', { Bucket: p.Bucket })).PublicAccessBlockConfiguration ?? {}
    const v = await ctx.call('s3', 'GetBucketVersioning', { Bucket: p.Bucket })
    const all = Object.keys(PUBLIC_ACCESS_BLOCK).every((k) => pab[k] === true)
    return `${p.Bucket}: 公开访问阻止${all ? '全部开启' : '未全部开启'} · 版本控制 ${v.Status ?? 'Off'}`
  }
}

// ---- ECS ----

type EcsParams = { cluster: string; service: string; desiredCount: number }
interface EcsSnapshot {
  name: string
  status: string
  desired: number
  running: number
  taskDefinition: string
  launchType: string
}

const capacityRisk = (from: number, to: number): Pick<Plan, 'risk' | 'reasons'> =>
  to === 0
    ? { risk: 'high', reasons: ['缩容到 0：服务完全停止'] }
    : to < from
      ? { risk: 'medium', reasons: [`缩容：${from} → ${to}`] }
      : { risk: 'low', reasons: [`扩容：${from} → ${to}`] }

export const updateEcsService: ChangeAdapter<EcsParams, EcsSnapshot> = {
  service: 'ecs',
  action: 'UpdateService',
  doc: 'cluster；service；desiredCount: 0–1000（只支持改期望任务数）',
  schema: Type.Object(
    { cluster: Type.String({ minLength: 1, maxLength: 255, pattern: '^[a-zA-Z0-9:/_-]+$' }), service: Type.String({ minLength: 1, maxLength: 255, pattern: '^[a-zA-Z0-9:/_-]+$' }), desiredCount: Type.Integer({ minimum: 0, maximum: 1000 }) },
    Strict
  ),
  forbiddenParams: {
    taskDefinition: '换任务定义等于部署新代码，不支持',
    forceNewDeployment: '只支持修改 desiredCount',
    networkConfiguration: '只支持修改 desiredCount'
  },
  async snapshot(p, ctx) {
    const s = (await ctx.call('ecs', 'DescribeServices', { cluster: p.cluster, services: [p.service] })).services?.[0]
    if (!s) throw new Error(`集群 ${p.cluster} 里找不到服务 ${p.service}`)
    return { name: s.serviceName, status: s.status ?? '', desired: s.desiredCount ?? 0, running: s.runningCount ?? 0, taskDefinition: s.taskDefinition ?? '', launchType: s.launchType ?? '' }
  },
  arns: (p, at) => [p.service.startsWith('arn:') ? p.service : `arn:aws:ecs:${at.region}:${at.account}:service/${p.cluster.split('/').pop()}/${p.service}`],
  // Running counts move on their own; only what the proposal is about must hold still.
  drift: (s) => ({ status: s.status, desired: s.desired, taskDefinition: s.taskDefinition }),
  request: (p) => ({ cluster: p.cluster, service: p.service, desiredCount: p.desiredCount }),
  plan: (p, s): Plan => ({
    title: `ECS 服务 ${s.name} 期望任务数 ${s.desired} → ${p.desiredCount}`,
    targets: [`${p.cluster}/${s.name}`],
    confirmText: s.name,
    ...capacityRisk(s.desired, p.desiredCount),
    change: { kind: 'modify', rows: [{ item: '期望任务数', before: `${s.desired} 个`, after: `${p.desiredCount} 个` }] },
    consequences: [
      { kind: 'blast-radius', text: `当前运行 ${s.running} 个任务（${s.launchType || '容量提供方'}）` },
      ...(p.desiredCount < s.desired ? [{ kind: 'downtime' as const, text: `会停掉 ${s.desired - p.desiredCount} 个任务${p.desiredCount === 0 ? '，服务不再处理请求' : '，剩余任务承担全部流量'}` }] : []),
      ...(p.desiredCount > s.desired ? [{ kind: 'cost' as const, text: `多运行 ${p.desiredCount - s.desired} 个任务，费用相应增加` }] : [])
    ],
    blockers: [...(s.status !== 'ACTIVE' ? [`服务当前是 ${s.status}`] : []), ...(s.desired === p.desiredCount ? [`期望任务数已经是 ${p.desiredCount}`] : [])]
  }),
  verify: async (p, ctx) => {
    const s = (await ctx.call('ecs', 'DescribeServices', { cluster: p.cluster, services: [p.service] })).services?.[0]
    return `${p.service}: desired ${s?.desiredCount ?? '?'} · running ${s?.runningCount ?? '?'}`
  }
}

// ---- Auto Scaling ----

type AsgParams = { AutoScalingGroupName: string; DesiredCapacity: number; HonorCooldown?: boolean }
interface AsgSnapshot {
  name: string
  min: number
  max: number
  desired: number
  instances: number
  tags: Record<string, string>
}

async function describeAsg(name: string, ctx: ChangeCtx): Promise<AsgSnapshot> {
  const g = (await ctx.call('autoscaling', 'DescribeAutoScalingGroups', { AutoScalingGroupNames: [name] })).AutoScalingGroups?.[0]
  if (!g) throw new Error(`${ctx.region} 里找不到 Auto Scaling 组 ${name}`)
  return { name: g.AutoScalingGroupName, min: g.MinSize ?? 0, max: g.MaxSize ?? 0, desired: g.DesiredCapacity ?? 0, instances: (g.Instances ?? []).length, tags: tagMap(g.Tags) }
}

export const setDesiredCapacity: ChangeAdapter<AsgParams, AsgSnapshot> = {
  service: 'autoscaling',
  action: 'SetDesiredCapacity',
  doc: 'AutoScalingGroupName；DesiredCapacity（必须在 min..max 之间）；HonorCooldown?: boolean',
  schema: Type.Object(
    { AutoScalingGroupName: Type.String({ minLength: 1, maxLength: 255, pattern: '^[^\\u0000-\\u001f]+$' }), DesiredCapacity: Type.Integer({ minimum: 0, maximum: 10000 }), HonorCooldown: Type.Optional(Type.Boolean()) },
    Strict
  ),
  snapshot: (p, ctx) => describeAsg(p.AutoScalingGroupName, ctx),
  drift: (s) => ({ min: s.min, max: s.max, desired: s.desired }),
  plan: (p, s): Plan => ({
    title: `Auto Scaling 组 ${s.name} 期望容量 ${s.desired} → ${p.DesiredCapacity}`,
    targets: [s.name],
    confirmText: s.name,
    ...capacityRisk(s.desired, p.DesiredCapacity),
    change: { kind: 'modify', rows: [{ item: '期望容量', before: `${s.desired} 台`, after: `${p.DesiredCapacity} 台` }] },
    consequences: [
      { kind: 'blast-radius', text: `当前 ${s.instances} 台实例（min ${s.min} / max ${s.max}）` },
      ...(p.DesiredCapacity < s.desired ? [{ kind: 'downtime' as const, text: `会终止 ${s.desired - p.DesiredCapacity} 台实例（按组的终止策略选择），上面的数据随实例删除` }] : []),
      ...(p.DesiredCapacity > s.desired ? [{ kind: 'cost' as const, text: `多启动 ${p.DesiredCapacity - s.desired} 台实例，费用相应增加` }] : []),
      { kind: 'dependency', text: '扩缩容策略或计划任务之后可能再次改变容量' }
    ],
    blockers: [
      ...(p.DesiredCapacity < s.min || p.DesiredCapacity > s.max ? [`期望容量必须在 ${s.min}..${s.max} 之间（修改 min / max 不支持）`] : []),
      ...(p.DesiredCapacity === s.desired ? [`期望容量已经是 ${s.desired}`] : [])
    ],
    tags: [s.tags]
  }),
  verify: async (p, ctx) => {
    const s = await describeAsg(p.AutoScalingGroupName, ctx)
    return `${s.name}: desired ${s.desired} · ${s.instances} 台`
  }
}

export const SERVICE_ADAPTERS = [
  stopDb,
  startDb,
  rebootDb,
  deleteDb,
  modifyDb,
  updateLambdaConfig,
  putBucketTagging,
  putBucketVersioning,
  deleteBucket,
  createBucket,
  updateEcsService,
  setDesiredCapacity
]
