/** DynamoDB UpdateTable (plan §9.3): billing mode, table throughput, deletion protection. No DryRun; tables are never deleted. */
import { Type } from 'typebox'
import type { Risk } from '../../../shared/ai'
import { NONE, riskAtLeast, tagMap, usd, HOURS_PER_MONTH, type ChangeAdapter, type ChangeCtx, type ChangeRow, type Consequence, type Plan } from './common'

const Strict = { additionalProperties: false }
const Units = Type.Integer({ minimum: 1, maximum: 40000 })
const ONLY = '只支持修改计费模式、表的预置容量和删除保护'

/** Provisioned capacity, USD per unit-hour, us-east-1 standard table class. shortcut: reference prices; on-demand costs depend on traffic. */
const RCU_HOURLY = 0.00013
const WCU_HOURLY = 0.00065

type Billing = 'PAY_PER_REQUEST' | 'PROVISIONED'
type TableParams = {
  TableName: string
  BillingMode?: Billing
  ProvisionedThroughput?: { ReadCapacityUnits: number; WriteCapacityUnits: number }
  DeletionProtectionEnabled?: boolean
}

interface TableSnapshot {
  name: string
  arn: string
  status: string
  billing: Billing
  read: number
  write: number
  deletionProtection: boolean
  indexes: number
  decreasesToday: number
  tags: Record<string, string>
}

async function describeTable(name: string, ctx: ChangeCtx): Promise<TableSnapshot> {
  const t = (await ctx.call('dynamodb', 'DescribeTable', { TableName: name })).Table
  if (!t) throw new Error(`${ctx.region} 里找不到表 ${name}`)
  const tags = t.TableArn ? (await ctx.call('dynamodb', 'ListTagsOfResource', { ResourceArn: t.TableArn })).Tags : []
  return {
    name: t.TableName,
    arn: t.TableArn ?? '',
    status: t.TableStatus ?? 'UNKNOWN',
    billing: t.BillingModeSummary?.BillingMode ?? 'PROVISIONED',
    read: t.ProvisionedThroughput?.ReadCapacityUnits ?? 0,
    write: t.ProvisionedThroughput?.WriteCapacityUnits ?? 0,
    deletionProtection: t.DeletionProtectionEnabled === true,
    indexes: (t.GlobalSecondaryIndexes ?? []).length,
    decreasesToday: t.ProvisionedThroughput?.NumberOfDecreasesToday ?? 0,
    tags: tagMap(tags)
  }
}

const BILLING_LABEL: Record<Billing, string> = { PAY_PER_REQUEST: '按需（PAY_PER_REQUEST）', PROVISIONED: '预置（PROVISIONED）' }

const capacityCost = (read: number, write: number): number => Math.round((read * RCU_HOURLY + write * WCU_HOURLY) * HOURS_PER_MONTH * 100) / 100

export const updateTable: ChangeAdapter<TableParams, TableSnapshot> = {
  service: 'dynamodb',
  action: 'UpdateTable',
  doc: 'TableName；BillingMode?: PAY_PER_REQUEST | PROVISIONED；ProvisionedThroughput?: {ReadCapacityUnits, WriteCapacityUnits}（1–40000，PROVISIONED 时必填）；DeletionProtectionEnabled?: boolean。不支持删除表',
  schema: Type.Object(
    {
      TableName: Type.String({ pattern: '^[a-zA-Z0-9_.-]{3,255}$' }),
      BillingMode: Type.Optional(Type.Enum(['PAY_PER_REQUEST', 'PROVISIONED'])),
      ProvisionedThroughput: Type.Optional(Type.Object({ ReadCapacityUnits: Units, WriteCapacityUnits: Units }, Strict)),
      DeletionProtectionEnabled: Type.Optional(Type.Boolean())
    },
    Strict
  ),
  forbiddenParams: {
    GlobalSecondaryIndexUpdates: `索引的增删改不支持；${ONLY}`,
    AttributeDefinitions: ONLY,
    StreamSpecification: `流设置会影响下游消费者；${ONLY}`,
    SSESpecification: `加密设置请在 Console 里改；${ONLY}`,
    ReplicaUpdates: `全局表副本请在 Console 里改；${ONLY}`,
    TableClass: ONLY,
    OnDemandThroughput: ONLY,
    WarmThroughput: ONLY
  },
  snapshot: (p, ctx) => describeTable(p.TableName, ctx),
  // Decrease counters tick on their own schedule; the table's settings are what must hold still.
  drift: (s) => ({ ...s, decreasesToday: undefined }),
  arns: (p, at) => [`arn:aws:dynamodb:${at.region}:${at.account}:table/${p.TableName}`],
  request: (p) => ({ ...p }),
  plan(p, s): Plan {
    const billing = p.BillingMode ?? s.billing
    const read = p.ProvisionedThroughput?.ReadCapacityUnits
    const write = p.ProvisionedThroughput?.WriteCapacityUnits
    const billingChange = billing !== s.billing
    const throughputChange = p.ProvisionedThroughput !== undefined && (billingChange || read !== s.read || write !== s.write)
    const protectionChange = p.DeletionProtectionEnabled !== undefined && p.DeletionProtectionEnabled !== s.deletionProtection
    const decrease = throughputChange && !billingChange && ((read ?? 0) < s.read || (write ?? 0) < s.write)
    const risks: Risk[] = []
    const reasons: string[] = []
    const consequences: Consequence[] = []
    const rows: ChangeRow[] = []
    if (billingChange) {
      risks.push('medium')
      reasons.push(`计费模式 ${s.billing} → ${billing}`)
      rows.push({ item: '计费模式', before: BILLING_LABEL[s.billing], after: BILLING_LABEL[billing] })
      consequences.push({ kind: 'dependency', text: 'AWS 限制每张表在 24 小时内切换计费模式的次数，切换后短时间内可能无法改回' })
      if (billing === 'PAY_PER_REQUEST') consequences.push({ kind: 'cost', text: '按请求计费：费用随读写量变化，不再有预置容量费用' })
    }
    if (throughputChange) {
      risks.push(decrease ? 'medium' : 'low')
      reasons.push(decrease ? '缩减预置容量' : '设置预置容量')
      // On-demand tables have no provisioned capacity to compare with.
      const onDemand = s.billing === 'PAY_PER_REQUEST'
      rows.push(
        { item: '读容量', before: onDemand ? NONE : `${s.read} RCU`, after: `${read} RCU` },
        { item: '写容量', before: onDemand ? NONE : `${s.write} WCU`, after: `${write} WCU` }
      )
      const cost = capacityCost(read ?? 0, write ?? 0)
      consequences.push({ kind: 'cost', text: `预置容量参考价约 ${usd(cost)}/月（${read} RCU + ${write} WCU，参考区域 us-east-1，可能与资源所在区域不同；标准表，不含存储和索引）`, monthlyUsd: cost })
      consequences.push({ kind: 'throttling', text: '超过预置容量的请求会被限流（ProvisionedThroughputExceededException）' })
      if (decrease) consequences.push({ kind: 'dependency', text: `AWS 限制每天缩减容量的次数（今天已缩减 ${s.decreasesToday} 次）` })
    }
    if (protectionChange) {
      risks.push(p.DeletionProtectionEnabled ? 'low' : 'high')
      reasons.push(p.DeletionProtectionEnabled ? '开启删除保护' : '关闭删除保护：之后这张表可以被删除')
      rows.push({ item: '删除保护', before: s.deletionProtection ? '开启' : '关闭', after: p.DeletionProtectionEnabled ? '开启' : '关闭' })
      if (!p.DeletionProtectionEnabled) consequences.push({ kind: 'dependency', text: '关闭后，任何有 dynamodb:DeleteTable 权限的人或程序都能删除这张表和其中的数据' })
    }
    return {
      title: `修改 DynamoDB 表 ${s.name}`,
      targets: [s.name],
      confirmText: s.name,
      risk: risks.reduce<Risk>((a, b) => riskAtLeast(a, b), 'low'),
      reasons,
      change: { kind: 'modify', rows },
      consequences,
      blockers: [
        ...(s.status !== 'ACTIVE' ? [`表 ${s.name} 当前是 ${s.status}，只能修改 ACTIVE 的表`] : []),
        ...(billing === 'PAY_PER_REQUEST' && p.ProvisionedThroughput ? ['按需模式（PAY_PER_REQUEST）不能设置预置容量'] : []),
        ...(billing === 'PROVISIONED' && billingChange && !p.ProvisionedThroughput ? ['切换到预置模式（PROVISIONED）必须同时给出 ProvisionedThroughput'] : []),
        ...(billing === 'PROVISIONED' && billingChange && s.indexes ? [`表有 ${s.indexes} 个全局二级索引，切换到预置模式要同时设置索引的容量（不支持），请在 Console 里操作`] : []),
        ...(rows.length ? [] : ['没有变更（值和现在一样，或没有给出要修改的字段）'])
      ],
      tags: [s.tags]
    }
  },
  verify: async (p, ctx) => {
    const s = await describeTable(p.TableName, ctx)
    return `${s.name}: ${s.status} · ${s.billing}${s.billing === 'PROVISIONED' ? ` ${s.read}/${s.write}` : ''} · 删除保护${s.deletionProtection ? '开' : '关'}`
  }
}
