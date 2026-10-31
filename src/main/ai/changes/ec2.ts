/** EC2 change adapters (plan §9.3). Every request is first sent with DryRun: true. */
import { Type } from 'typebox'
import {
  confirmFor,
  DELETED,
  EC2_HOURLY,
  fieldDiff,
  monthly,
  named,
  NONE,
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
const InstanceId = Type.String({ pattern: '^i-[0-9a-f]{8,17}$' })
const InstanceIds = Type.Array(InstanceId, { minItems: 1, maxItems: 20 })
const InstanceType = Type.String({ pattern: '^[a-z][a-z0-9-]*\\.[a-z0-9]+$', maxLength: 32 })
const TagKey = Type.String({ minLength: 1, maxLength: 128, pattern: '^(?!aws:)[^\\u0000-\\u001f]+$' })
const TagValue = Type.String({ maxLength: 256, pattern: '^[^\\u0000-\\u001f]*$' })
const Tags = Type.Array(Type.Object({ Key: TagKey, Value: TagValue }, Strict), { minItems: 1, maxItems: 20 })

const uniqueSorted = (ids: string[]): string[] => [...new Set(ids)].sort()

interface Instance {
  id: string
  name: string | null
  state: string
  type: string
  rootDevice: string
  publicIp: string | null
  lifecycle: string
  asg: string | null
  tags: Record<string, string>
  volumes: { device: string; volumeId: string | null; deleteOnTermination: boolean }[]
}

async function describeInstances(ids: string[], ctx: ChangeCtx): Promise<Instance[]> {
  const r = await ctx.call('ec2', 'DescribeInstances', { InstanceIds: ids })
  const found: Instance[] = (r.Reservations ?? [])
    .flatMap((res: any) => res.Instances ?? [])
    .map((i: any) => {
      const tags = tagMap(i.Tags)
      return {
        id: i.InstanceId,
        name: tags.Name ?? null,
        state: i.State?.Name ?? 'unknown',
        type: i.InstanceType ?? '',
        rootDevice: i.RootDeviceType ?? 'ebs',
        publicIp: i.PublicIpAddress ?? null,
        lifecycle: i.InstanceLifecycle ?? 'on-demand',
        asg: tags['aws:autoscaling:groupName'] ?? null,
        tags,
        volumes: (i.BlockDeviceMappings ?? []).map((b: any) => ({
          device: b.DeviceName ?? '',
          volumeId: b.Ebs?.VolumeId ?? null,
          deleteOnTermination: b.Ebs?.DeleteOnTermination === true
        }))
      }
    })
  const missing = ids.filter((id) => !found.some((i) => i.id === id))
  if (missing.length) throw new Error(`${ctx.region} 里找不到实例：${missing.join(', ')}`)
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

/** Elastic IPs associated with the instances: kept (and billed) after stop / terminate. */
async function elasticIps(ids: string[], ctx: ChangeCtx): Promise<{ ip: string; instanceId: string }[]> {
  const r = await ctx.call('ec2', 'DescribeAddresses', { Filters: [{ Name: 'instance-id', Values: ids }] })
  return (r.Addresses ?? []).map((a: any) => ({ ip: a.PublicIp, instanceId: a.InstanceId })).sort((a: any, b: any) => a.ip.localeCompare(b.ip))
}

const costLine = (instances: Instance[], what: string): Consequence => {
  const prices = instances.map((i) => monthly(EC2_HOURLY, i.type))
  const total = prices.reduce<number>((s, p) => s + (p ?? 0), 0)
  const unknown = prices.some((p) => p === undefined)
  return {
    kind: 'cost',
    text: `${what}：按需参考价约 ${usd(total)}/月${unknown ? '（部分实例类型价格未知）' : ''}（us-east-1 Linux，不含 EBS）`,
    ...(!unknown && { monthlyUsd: total })
  }
}

const stateChange = (instances: Instance[], to: string): Change => ({
  kind: 'state',
  states: instances.map((i) => ({ name: named(i.id, i.name), from: stateLabel(i.state), to }))
})

type Ids = { InstanceIds: string[] }

interface StateSnapshot {
  instances: Instance[]
  eips: { ip: string; instanceId: string }[]
}

const stateSnapshot = async (p: Ids, ctx: ChangeCtx): Promise<StateSnapshot> => ({
  instances: await describeInstances(p.InstanceIds, ctx),
  eips: await elasticIps(p.InstanceIds, ctx)
})

const ipLines = (s: StateSnapshot): Consequence[] => {
  const eip = new Set(s.eips.map((e) => e.ip))
  const lines: Consequence[] = []
  for (const i of s.instances) {
    if (i.publicIp && !eip.has(i.publicIp)) lines.push({ kind: 'dependency', text: `${named(i.id, i.name)} 的公网 IP ${i.publicIp} 会释放，再启动时会换一个（EIP 不受影响）` })
  }
  return lines
}

const notIn = (s: StateSnapshot, state: string, verb: string): string[] =>
  s.instances.filter((i) => i.state !== state).map((i) => `${named(i.id, i.name)} 当前是 ${i.state}，只能${verb} ${state} 的实例`)

const asgLines = (s: StateSnapshot, text: (asg: string) => string): Consequence[] =>
  [...new Set(s.instances.flatMap((i) => (i.asg ? [i.asg] : [])))].map((asg) => ({ kind: 'blast-radius' as const, text: text(asg) }))

export const startInstances: ChangeAdapter<Ids, StateSnapshot> = {
  service: 'ec2',
  action: 'StartInstances',
  doc: 'InstanceIds: string[]（≤20）',
  schema: Type.Object({ InstanceIds }, Strict),
  normalize: (p) => ({ InstanceIds: uniqueSorted(p.InstanceIds) }),
  snapshot: stateSnapshot,
  dryRun: true,
  plan(p, s): Plan {
    return {
      title: `启动 ${p.InstanceIds.length} 台 EC2 实例`,
      targets: p.InstanceIds,
      confirmText: confirmFor(p.InstanceIds, `启动 ${p.InstanceIds.length} 台实例`),
      risk: 'low',
      reasons: ['启动已停止的实例'],
      change: stateChange(s.instances, stateLabel('running')),
      consequences: [costLine(s.instances, '开始按小时计费'), { kind: 'dependency', text: '没有 EIP 的实例会分配新的公网 IP' }],
      blockers: notIn(s, 'stopped', '启动'),
      tags: s.instances.map((i) => i.tags)
    }
  },
  verify: async (p, ctx) => (await describeInstances(p.InstanceIds, ctx)).map((i) => `${i.id}: ${i.state}`).join('，')
}

type StopParams = Ids & { Force?: boolean; Hibernate?: boolean }

export const stopInstances: ChangeAdapter<StopParams, StateSnapshot> = {
  service: 'ec2',
  action: 'StopInstances',
  doc: 'InstanceIds: string[]（≤20）；Force?: boolean；Hibernate?: boolean',
  schema: Type.Object({ InstanceIds, Force: Type.Optional(Type.Boolean()), Hibernate: Type.Optional(Type.Boolean()) }, Strict),
  normalize: (p) => ({ ...p, InstanceIds: uniqueSorted(p.InstanceIds) }),
  snapshot: stateSnapshot,
  dryRun: true,
  plan(p, s): Plan {
    const inAsg = s.instances.some((i) => i.asg)
    const reasons = ['停止实例会中断上面的服务']
    if (p.Force) reasons.push('强制停止：不会正常关机，未写盘的数据可能丢失')
    if (inAsg) reasons.push('实例属于 Auto Scaling 组，停止后可能被判为不健康并被替换')
    return {
      title: `停止 ${p.InstanceIds.length} 台 EC2 实例${p.Hibernate ? '（休眠）' : ''}`,
      targets: p.InstanceIds,
      confirmText: confirmFor(p.InstanceIds, `停止 ${p.InstanceIds.length} 台实例`),
      risk: p.Force || inAsg ? 'high' : 'medium',
      reasons,
      change: stateChange(s.instances, stateLabel('stopped')),
      consequences: [
        { kind: 'downtime', text: '实例将停止，上面的服务不可用，直到重新启动（停止通常需要 1–3 分钟）' },
        ...ipLines(s),
        { kind: 'data', text: 'instance store 卷（如 m5d、i3 等类型自带的本地盘）上的数据会丢失；EBS 卷不受影响' },
        { kind: 'cost', text: '停止后不再按小时收实例费，EBS 卷和 EIP 继续计费' },
        ...asgLines(s, (asg) => `Auto Scaling 组 ${asg} 可能会启动替换实例`)
      ],
      blockers: [
        ...notIn(s, 'running', '停止'),
        ...s.instances.filter((i) => i.rootDevice === 'instance-store').map((i) => `${i.id} 的根卷是 instance store，不能停止（只能终止）`)
      ],
      tags: s.instances.map((i) => i.tags)
    }
  },
  verify: async (p, ctx) => (await describeInstances(p.InstanceIds, ctx)).map((i) => `${i.id}: ${i.state}`).join('，')
}

export const rebootInstances: ChangeAdapter<Ids, StateSnapshot> = {
  service: 'ec2',
  action: 'RebootInstances',
  doc: 'InstanceIds: string[]（≤20）',
  schema: Type.Object({ InstanceIds }, Strict),
  normalize: (p) => ({ InstanceIds: uniqueSorted(p.InstanceIds) }),
  snapshot: stateSnapshot,
  dryRun: true,
  plan(p, s): Plan {
    return {
      title: `重启 ${p.InstanceIds.length} 台 EC2 实例`,
      targets: p.InstanceIds,
      confirmText: confirmFor(p.InstanceIds, `重启 ${p.InstanceIds.length} 台实例`),
      risk: 'medium',
      reasons: ['重启期间服务中断'],
      change: stateChange(s.instances, '重启后运行中'),
      consequences: [{ kind: 'downtime', text: '操作系统重启，通常 1–3 分钟不可用；公网 IP 和 instance store 数据保留' }],
      blockers: notIn(s, 'running', '重启'),
      tags: s.instances.map((i) => i.tags)
    }
  }
}

interface TerminateSnapshot extends StateSnapshot {
  protectedIds: string[]
}

export const terminateInstances: ChangeAdapter<Ids, TerminateSnapshot> = {
  service: 'ec2',
  action: 'TerminateInstances',
  doc: 'InstanceIds: string[]（≤20）',
  schema: Type.Object({ InstanceIds }, Strict),
  normalize: (p) => ({ InstanceIds: uniqueSorted(p.InstanceIds) }),
  async snapshot(p, ctx) {
    const base = await stateSnapshot(p, ctx)
    const protectedIds: string[] = []
    for (const id of p.InstanceIds) {
      const r = await ctx.call('ec2', 'DescribeInstanceAttribute', { InstanceId: id, Attribute: 'disableApiTermination' })
      if (r.DisableApiTermination?.Value === true) protectedIds.push(id)
    }
    return { ...base, protectedIds }
  },
  dryRun: true,
  plan(p, s): Plan {
    const volumes = s.instances.flatMap((i) => i.volumes.map((v) => ({ ...v, instance: i })))
    return {
      title: `终止 ${p.InstanceIds.length} 台 EC2 实例`,
      targets: p.InstanceIds,
      confirmText: confirmFor(p.InstanceIds, `终止 ${p.InstanceIds.length} 台实例`),
      risk: 'destructive',
      reasons: ['终止（删除）实例，无法恢复'],
      change: {
        kind: 'delete',
        removed: [
          ...s.instances.map((i) => ({ name: named(i.id, i.name), detail: `${i.type} · ${stateLabel(i.state)}` })),
          ...volumes.filter((v) => v.deleteOnTermination).map((v) => ({ name: `卷 ${v.volumeId ?? '?'}`, detail: `${v.device}，${v.instance.id}` }))
        ],
        kept: [
          ...volumes.filter((v) => !v.deleteOnTermination).map((v) => `卷 ${v.volumeId ?? '?'}（${v.device}，${v.instance.id}）`),
          ...s.eips.map((e) => `EIP ${e.ip}`)
        ]
      },
      consequences: [
        { kind: 'irreversible', text: '实例终止后无法恢复，instance store 数据一并丢失' },
        ...volumes
          .filter((v) => v.deleteOnTermination)
          .map((v) => ({ kind: 'data' as const, text: `卷 ${v.volumeId ?? '?'}（${v.device}，${v.instance.id}）会一起删除（DeleteOnTermination）` })),
        ...volumes
          .filter((v) => !v.deleteOnTermination)
          .map((v) => ({ kind: 'dependency' as const, text: `卷 ${v.volumeId ?? '?'}（${v.device}，${v.instance.id}）会保留并继续计费` })),
        ...s.eips.map((e) => ({ kind: 'dependency' as const, text: `EIP ${e.ip} 会解除关联但仍保留，未关联时按小时计费` })),
        ...asgLines(s, (asg) => `实例属于 Auto Scaling 组 ${asg}，它会按期望数量启动替换实例`)
      ],
      blockers: [
        ...s.instances.filter((i) => i.state === 'terminated' || i.state === 'shutting-down').map((i) => `${i.id} 已经是 ${i.state}`),
        ...s.protectedIds.map((id) => `${id} 开启了终止保护（DisableApiTermination），请先在 Console 里关闭`)
      ],
      tags: s.instances.map((i) => i.tags)
    }
  },
  verify: async (p, ctx) => (await describeInstances(p.InstanceIds, ctx)).map((i) => `${i.id}: ${i.state}`).join('，')
}

type ModifyType = { InstanceId: string; InstanceType: string }

export const modifyInstanceAttribute: ChangeAdapter<ModifyType, { instance: Instance }> = {
  service: 'ec2',
  action: 'ModifyInstanceAttribute',
  doc: 'InstanceId: string；InstanceType: string（只支持改实例类型，实例需已停止）',
  schema: Type.Object({ InstanceId, InstanceType }, Strict),
  forbiddenParams: {
    UserData: '启动脚本（UserData）会以 root 执行任意代码，助手不能修改',
    DisableApiTermination: '终止保护只能在 Console 里改',
    DisableApiStop: '停止保护只能在 Console 里改',
    Groups: '换安全组请用安全组规则提案，或在 Console 里操作',
    SourceDestCheck: '只支持修改 InstanceType'
  },
  snapshot: async (p, ctx) => ({ instance: (await describeInstances([p.InstanceId], ctx))[0] }),
  dryRun: true,
  request: (p) => ({ InstanceId: p.InstanceId, InstanceType: { Value: p.InstanceType } }),
  plan(p, { instance: i }): Plan {
    const from = monthly(EC2_HOURLY, i.type)
    const to = monthly(EC2_HOURLY, p.InstanceType)
    return {
      title: `修改实例类型 ${named(i.id, i.name)}：${i.type} → ${p.InstanceType}`,
      targets: [i.id],
      confirmText: i.id,
      risk: 'medium',
      reasons: ['修改实例规格'],
      change: { kind: 'modify', rows: [{ item: '实例类型', before: i.type, after: p.InstanceType }] },
      consequences: [
        {
          kind: 'cost',
          text: `按需参考价 ${from !== undefined ? usd(from) : '未知'}/月 → ${to !== undefined ? usd(to) : '未知'}/月（us-east-1 Linux）`,
          ...(to !== undefined && { monthlyUsd: to })
        },
        { kind: 'dependency', text: '新类型必须和 AMI 的架构（x86 / arm64）、ENA / NVMe 驱动兼容，不兼容时实例可能起不来' }
      ],
      blockers: [
        ...(i.state !== 'stopped' ? [`修改实例类型需要先停止实例（${i.id} 当前是 ${i.state}）`] : []),
        ...(i.type === p.InstanceType ? [`${i.id} 已经是 ${p.InstanceType}`] : [])
      ],
      tags: [i.tags]
    }
  },
  verify: async (p, ctx) => {
    const i = (await describeInstances([p.InstanceId], ctx))[0]
    return `${i.id}: ${i.type} · ${i.state}`
  }
}

// ---- tags ----

const ResourceId = Type.String({ pattern: '^[a-z]+(-[a-z]+)?-[0-9a-f]{8,17}$', maxLength: 64 })
const Resources = Type.Array(ResourceId, { minItems: 1, maxItems: 20 })
type TagsSnapshot = Record<string, Record<string, string>>

async function currentTags(resources: string[], ctx: ChangeCtx): Promise<TagsSnapshot> {
  const r = await ctx.call('ec2', 'DescribeTags', { Filters: [{ Name: 'resource-id', Values: resources }], MaxResults: 1000 })
  const out: TagsSnapshot = Object.fromEntries(resources.map((id) => [id, {}]))
  for (const t of r.Tags ?? []) if (out[t.ResourceId]) out[t.ResourceId][t.Key] = t.Value ?? ''
  return out
}

type CreateTagsParams = { Resources: string[]; Tags: { Key: string; Value: string }[] }

export const createTags: ChangeAdapter<CreateTagsParams, TagsSnapshot> = {
  service: 'ec2',
  action: 'CreateTags',
  doc: 'Resources: string[]（EC2 资源 id，≤20）；Tags: {Key, Value}[]（≤20，不能以 aws: 开头）',
  schema: Type.Object({ Resources, Tags }, Strict),
  normalize: (p) => ({ Resources: uniqueSorted(p.Resources), Tags: [...new Map(p.Tags.map((t) => [t.Key, t])).values()].sort((a, b) => a.Key.localeCompare(b.Key)) }),
  snapshot: (p, ctx) => currentTags(p.Resources, ctx),
  dryRun: true,
  plan(p, s): Plan {
    const target = (id: string): string | undefined => (p.Resources.length > 1 ? id : undefined)
    const rows = p.Resources.flatMap((id) => rowsOf(fieldDiff(s[id] ?? {}, { ...s[id], ...Object.fromEntries(p.Tags.map((t) => [t.Key, t.Value])) }), (k) => `标签 ${k}`, target(id)))
    return {
      title: `给 ${p.Resources.length} 个资源设置 ${p.Tags.length} 个标签`,
      targets: p.Resources,
      confirmText: confirmFor(p.Resources, `${p.Resources.length} 个资源`),
      risk: 'low',
      reasons: ['只改标签'],
      change: { kind: 'modify', rows },
      consequences: [
        ...(p.Tags.some((t) => t.Key === 'Name') ? [{ kind: 'dependency' as const, text: 'Name 标签是 Console 里显示的名称' }] : []),
        { kind: 'dependency', text: '依赖标签的东西会受影响：成本分摊、IAM 条件、自动化脚本、按标签筛选的 Auto Scaling / 备份策略' }
      ],
      blockers: rows.length ? [] : ['这些标签已经是这些值，没有变更'],
      tags: Object.values(s)
    }
  }
}

type DeleteTagsParams = { Resources: string[]; Tags: { Key: string; Value?: string }[] }

export const deleteTags: ChangeAdapter<DeleteTagsParams, TagsSnapshot> = {
  service: 'ec2',
  action: 'DeleteTags',
  doc: 'Resources: string[]（≤20）；Tags: {Key, Value?}[]（给了 Value 时只在值相同时删除）',
  schema: Type.Object({ Resources, Tags: Type.Array(Type.Object({ Key: TagKey, Value: Type.Optional(TagValue) }, Strict), { minItems: 1, maxItems: 20 }) }, Strict),
  normalize: (p) => ({ Resources: uniqueSorted(p.Resources), Tags: [...p.Tags].sort((a, b) => a.Key.localeCompare(b.Key)) }),
  snapshot: (p, ctx) => currentTags(p.Resources, ctx),
  dryRun: true,
  plan(p, s): Plan {
    const rows: ChangeRow[] = p.Resources.flatMap((id) =>
      p.Tags.filter((t) => s[id]?.[t.Key] !== undefined && (t.Value === undefined || s[id][t.Key] === t.Value)).map((t) => ({
        ...(p.Resources.length > 1 && { target: id }),
        item: `标签 ${t.Key}`,
        before: show(s[id][t.Key]),
        after: DELETED
      }))
    )
    return {
      title: `删除 ${p.Resources.length} 个资源上的 ${p.Tags.length} 个标签`,
      targets: p.Resources,
      confirmText: confirmFor(p.Resources, `${p.Resources.length} 个资源`),
      risk: 'low',
      reasons: ['只改标签'],
      change: { kind: 'modify', rows },
      consequences: [{ kind: 'dependency', text: '依赖标签的东西会受影响：成本分摊、IAM 条件、自动化脚本、按标签筛选的策略' }],
      blockers: rows.length ? [] : ['这些资源上没有要删除的标签'],
      tags: Object.values(s)
    }
  }
}

// ---- security group rules ----

const Cidr4 = Type.String({ pattern: '^(\\d{1,3}\\.){3}\\d{1,3}/\\d{1,2}$' })
const Cidr6 = Type.String({ pattern: '^[0-9a-fA-F:]+/\\d{1,3}$', maxLength: 50 })
const Desc = Type.Optional(Type.String({ maxLength: 255, pattern: '^[^\\u0000-\\u001f]*$' }))
const Permission = Type.Object(
  {
    IpProtocol: Type.Enum(['tcp', 'udp', 'icmp', 'icmpv6', '-1']),
    FromPort: Type.Optional(Type.Integer({ minimum: -1, maximum: 65535 })),
    ToPort: Type.Optional(Type.Integer({ minimum: -1, maximum: 65535 })),
    IpRanges: Type.Optional(Type.Array(Type.Object({ CidrIp: Cidr4, Description: Desc }, Strict), { maxItems: 20 })),
    Ipv6Ranges: Type.Optional(Type.Array(Type.Object({ CidrIpv6: Cidr6, Description: Desc }, Strict), { maxItems: 20 })),
    UserIdGroupPairs: Type.Optional(Type.Array(Type.Object({ GroupId: Type.String({ pattern: '^sg-[0-9a-f]{8,17}$' }), Description: Desc }, Strict), { maxItems: 20 })),
    PrefixListIds: Type.Optional(Type.Array(Type.Object({ PrefixListId: Type.String({ pattern: '^pl-[0-9a-f]{8,17}$' }), Description: Desc }, Strict), { maxItems: 20 }))
  },
  Strict
)
type Perm = {
  IpProtocol: string
  FromPort?: number
  ToPort?: number
  IpRanges?: { CidrIp: string }[]
  Ipv6Ranges?: { CidrIpv6: string }[]
  UserIdGroupPairs?: { GroupId: string }[]
  PrefixListIds?: { PrefixListId: string }[]
}
type RuleParams = { GroupId: string; IpPermissions: Perm[] }

/** Ports where public ingress is a classic incident: SSH, RDP, databases, caches, search, Docker / etcd APIs. */
export const SENSITIVE_PORTS: Record<number, string> = {
  22: 'SSH', 3389: 'RDP', 3306: 'MySQL', 5432: 'PostgreSQL', 1433: 'SQL Server', 1521: 'Oracle', 6379: 'Redis', 11211: 'Memcached',
  27017: 'MongoDB', 9200: 'Elasticsearch', 5601: 'Kibana', 2375: 'Docker API', 2376: 'Docker API', 2379: 'etcd', 9092: 'Kafka', 5984: 'CouchDB', 23: 'Telnet'
}

const portsOf = (p: Perm): string =>
  p.IpProtocol === '-1' ? '全部端口' : p.IpProtocol.startsWith('icmp') ? `type ${p.FromPort ?? -1} code ${p.ToPort ?? -1}` : p.FromPort === p.ToPort ? `${p.FromPort}` : `${p.FromPort}-${p.ToPort}`

/** One string per (protocol, ports, source): the unit AWS adds and removes. */
export function ruleLines(perms: Perm[]): string[] {
  return perms
    .flatMap((p) => {
      const head = `${p.IpProtocol === '-1' ? 'all' : p.IpProtocol} ${portsOf(p)}`
      return [
        ...(p.IpRanges ?? []).map((r) => `${head} ${r.CidrIp}`),
        ...(p.Ipv6Ranges ?? []).map((r) => `${head} ${r.CidrIpv6}`),
        ...(p.UserIdGroupPairs ?? []).map((g) => `${head} ${g.GroupId}`),
        ...(p.PrefixListIds ?? []).map((l) => `${head} ${l.PrefixListId}`)
      ]
    })
    .sort()
}

/** A ruleLines line as the card says it: 「TCP 22 · 来源 0.0.0.0/0」. */
function ruleText(line: string, direction: 'ingress' | 'egress'): string {
  const parts = line.split(' ')
  const proto = parts[0]
  return `${proto === 'all' ? '全部协议' : proto.toUpperCase()} ${parts.slice(1, -1).join(' ')} · ${direction === 'ingress' ? '来源' : '目标'} ${parts[parts.length - 1]}`
}

/**
 * A source open to the internet in practice: not only 0.0.0.0/0 and ::/0, but any spelling of them (0::/0) and any
 * split into wide halves (0.0.0.0/1 + 128.0.0.0/1). IPv4 /8 or wider (10.0.0.0/8 excepted), IPv6 /16 or wider
 * outside fc00::/7.
 */
export function isPublicCidr(cidr: string): boolean {
  const [ip, bits] = cidr.split('/')
  const n = Number(bits)
  if (!Number.isInteger(n)) return true
  if (ip.includes(':')) return n <= 16 && !/^f[cd]/i.test(ip)
  return n <= 8 && !(n === 8 && ip.startsWith('10.'))
}

/** Public sources that open sensitive ports (or every port), as reasons. */
export function publicExposure(perms: Perm[]): { publicRules: string[]; sensitive: string[] } {
  const publicRules: string[] = []
  const sensitive: string[] = []
  for (const p of perms) {
    const open = [...(p.IpRanges ?? []).map((r) => r.CidrIp), ...(p.Ipv6Ranges ?? []).map((r) => r.CidrIpv6)].filter(isPublicCidr)
    if (!open.length) continue
    publicRules.push(`${p.IpProtocol} ${portsOf(p)}`)
    if (p.IpProtocol === '-1') sensitive.push('全部协议和端口')
    else if (p.IpProtocol === 'tcp' || p.IpProtocol === 'udp') {
      const from = p.FromPort ?? 0
      const to = p.ToPort ?? 65535
      for (const [port, name] of Object.entries(SENSITIVE_PORTS)) if (+port >= from && +port <= to) sensitive.push(`${port}（${name}）`)
    }
  }
  return { publicRules, sensitive: [...new Set(sensitive)] }
}

interface GroupSnapshot {
  groupId: string
  name: string
  vpcId: string
  rules: string[]
  tags: Record<string, string>
  /** Network interfaces using the group (first page). */
  enis: number
  enisMore: boolean
}

function sgRuleAdapter(action: string, direction: 'ingress' | 'egress', add: boolean): ChangeAdapter<RuleParams, GroupSnapshot> {
  const where = direction === 'ingress' ? '入站' : '出站'
  return {
    service: 'ec2',
    action,
    doc: `GroupId: string；IpPermissions: {IpProtocol: tcp|udp|icmp|icmpv6|-1, FromPort?, ToPort?, IpRanges?: {CidrIp}[], Ipv6Ranges?: {CidrIpv6}[], UserIdGroupPairs?: {GroupId}[], PrefixListIds?: {PrefixListId}[]}[]（≤10）`,
    schema: Type.Object({ GroupId: Type.String({ pattern: '^sg-[0-9a-f]{8,17}$' }), IpPermissions: Type.Array(Permission, { minItems: 1, maxItems: 10 }) }, Strict),
    async snapshot(p, ctx) {
      const r = await ctx.call('ec2', 'DescribeSecurityGroups', { GroupIds: [p.GroupId] })
      const g = r.SecurityGroups?.[0]
      if (!g) throw new Error(`${ctx.region} 里找不到安全组 ${p.GroupId}`)
      const n = await ctx.call('ec2', 'DescribeNetworkInterfaces', { Filters: [{ Name: 'group-id', Values: [p.GroupId] }], MaxResults: 1000 })
      return {
        groupId: g.GroupId,
        name: g.GroupName ?? '',
        vpcId: g.VpcId ?? '',
        rules: ruleLines((direction === 'ingress' ? g.IpPermissions : g.IpPermissionsEgress) ?? []),
        tags: tagMap(g.Tags),
        enis: (n.NetworkInterfaces ?? []).length,
        enisMore: Boolean(n.NextToken)
      }
    },
    drift: (s) => ({ groupId: s.groupId, rules: s.rules, tags: s.tags }),
    dryRun: true,
    plan(p, s): Plan {
      const wanted = ruleLines(p.IpPermissions)
      const present = new Set(s.rules)
      const changing = wanted.filter((r) => present.has(r) !== add)
      const { publicRules, sensitive } = direction === 'ingress' && add ? publicExposure(p.IpPermissions) : { publicRules: [], sensitive: [] }
      const reasons = [add ? `新增${where}规则` : `撤销${where}规则，可能切断正在使用的连接`]
      if (sensitive.length) reasons.push(`对公网（0.0.0.0/0、::/0 或其他超大网段）开放敏感端口：${sensitive.join('、')}`)
      else if (publicRules.length) reasons.push(`对公网开放：${publicRules.join('、')}`)
      const users = `${s.enis}${s.enisMore ? '+' : ''} 个网卡（实例、负载均衡、RDS 等）`
      return {
        title: `${add ? '添加' : '撤销'}安全组 ${named(s.groupId, s.name)} 的 ${changing.length || wanted.length} 条${where}规则`,
        targets: [s.groupId],
        confirmText: s.groupId,
        risk: sensitive.length ? 'high' : publicRules.length || !add ? 'medium' : 'low',
        reasons,
        change: { kind: 'modify', rows: changing.map((r) => ({ item: `${where}规则`, before: add ? NONE : ruleText(r, direction), after: add ? ruleText(r, direction) : DELETED })) },
        consequences: [
          { kind: 'blast-radius', text: `规则立即对使用这个安全组的 ${users}生效` },
          ...(sensitive.length ? [{ kind: 'blast-radius' as const, text: `互联网上任何地址都能连到 ${sensitive.join('、')}` }] : []),
          ...(!add ? [{ kind: 'downtime' as const, text: '依赖这些规则的连接会被拒绝（已建立的连接可能也会断开）' }] : [])
        ],
        blockers: changing.length === wanted.length ? [] : [add ? `规则已存在：${wanted.filter((r) => present.has(r)).join('；')}` : `规则不存在：${wanted.filter((r) => !present.has(r)).join('；')}`],
        tags: [s.tags]
      }
    }
  }
}

export const authorizeIngress = sgRuleAdapter('AuthorizeSecurityGroupIngress', 'ingress', true)
export const revokeIngress = sgRuleAdapter('RevokeSecurityGroupIngress', 'ingress', false)
export const authorizeEgress = sgRuleAdapter('AuthorizeSecurityGroupEgress', 'egress', true)
export const revokeEgress = sgRuleAdapter('RevokeSecurityGroupEgress', 'egress', false)

// ---- RunInstances ----

type RunParams = {
  ImageId: string
  InstanceType: string
  Count?: number
  SubnetId?: string
  SecurityGroupIds?: string[]
  KeyName?: string
  Tags?: { Key: string; Value: string }[]
  ClientToken?: string
}

interface RunSnapshot {
  image: { id: string; name: string; state: string; owner: string; ownerAlias: string | null; arch: string; platform: string; public: boolean }
  subnet: { id: string; az: string; vpcId: string; publicIp: boolean } | null
  type: { vcpu: number | null; memoryMiB: number | null; arches: string[] } | null
  groups: { id: string; name: string }[]
}

export const runInstances: ChangeAdapter<RunParams, RunSnapshot> = {
  service: 'ec2',
  action: 'RunInstances',
  doc: 'ImageId: ami-…；InstanceType；Count?: 1–10（默认 1）；SubnetId?；SecurityGroupIds?: string[]；KeyName?；Tags?: {Key, Value}[]。不支持 UserData 和 IAM 实例角色',
  schema: Type.Object(
    {
      ImageId: Type.String({ pattern: '^ami-[0-9a-f]{8,17}$' }),
      InstanceType,
      Count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      SubnetId: Type.Optional(Type.String({ pattern: '^subnet-[0-9a-f]{8,17}$' })),
      SecurityGroupIds: Type.Optional(Type.Array(Type.String({ pattern: '^sg-[0-9a-f]{8,17}$' }), { minItems: 1, maxItems: 5 })),
      KeyName: Type.Optional(Type.String({ minLength: 1, maxLength: 255, pattern: '^[\\x20-\\x7e]+$' })),
      Tags: Type.Optional(Tags)
    },
    Strict
  ),
  forbiddenParams: {
    UserData: '启动脚本（UserData）会在实例上以 root 执行任意代码，助手不能设置；需要时请在 Console 里创建',
    IamInstanceProfile: '给实例挂 IAM 角色等于 iam:PassRole，属于提权路径，已禁止',
    LaunchTemplate: '启动模板可能带 UserData 或 IAM 角色，不支持',
    NetworkInterfaces: '不支持自定义网卡，请用 SubnetId / SecurityGroupIds',
    MinCount: '请用 Count',
    MaxCount: '请用 Count'
  },
  // ClientToken makes RunInstances idempotent: the same proposal can never launch twice.
  normalize: (p, ctx) => ({
    ...p,
    Count: p.Count ?? 1,
    ...(p.SecurityGroupIds && { SecurityGroupIds: uniqueSorted(p.SecurityGroupIds) }),
    ClientToken: ctx.proposalId
  }),
  async snapshot(p, ctx) {
    const img = (await ctx.call('ec2', 'DescribeImages', { ImageIds: [p.ImageId] })).Images?.[0]
    if (!img) throw new Error(`${ctx.region} 里找不到 AMI ${p.ImageId}`)
    const subnet = p.SubnetId ? (await ctx.call('ec2', 'DescribeSubnets', { SubnetIds: [p.SubnetId] })).Subnets?.[0] : undefined
    if (p.SubnetId && !subnet) throw new Error(`${ctx.region} 里找不到子网 ${p.SubnetId}`)
    let type: RunSnapshot['type'] = null
    try {
      const t = (await ctx.call('ec2', 'DescribeInstanceTypes', { InstanceTypes: [p.InstanceType] })).InstanceTypes?.[0]
      if (t) type = { vcpu: t.VCpuInfo?.DefaultVCpus ?? null, memoryMiB: t.MemoryInfo?.SizeInMiB ?? null, arches: t.ProcessorInfo?.SupportedArchitectures ?? [] }
    } catch {
      type = null
    }
    if (!type) throw new Error(`${ctx.region} 里没有实例类型 ${p.InstanceType}`)
    const groups = p.SecurityGroupIds ? ((await ctx.call('ec2', 'DescribeSecurityGroups', { GroupIds: p.SecurityGroupIds })).SecurityGroups ?? []) : []
    if (p.KeyName) await ctx.call('ec2', 'DescribeKeyPairs', { KeyNames: [p.KeyName] })
    return {
      image: {
        id: img.ImageId,
        name: img.Name ?? '',
        state: img.State ?? '',
        owner: img.OwnerId ?? '',
        ownerAlias: img.ImageOwnerAlias ?? null,
        arch: img.Architecture ?? '',
        platform: img.PlatformDetails ?? img.Platform ?? 'Linux/UNIX',
        public: img.Public === true
      },
      subnet: subnet ? { id: subnet.SubnetId, az: subnet.AvailabilityZone ?? '', vpcId: subnet.VpcId ?? '', publicIp: subnet.MapPublicIpOnLaunch === true } : null,
      type,
      groups: groups.map((g: any) => ({ id: g.GroupId, name: g.GroupName ?? '' })).sort((a: any, b: any) => a.id.localeCompare(b.id))
    }
  },
  dryRun: true,
  request: (p) => ({
    ImageId: p.ImageId,
    InstanceType: p.InstanceType,
    MinCount: p.Count,
    MaxCount: p.Count,
    ...(p.SubnetId && { SubnetId: p.SubnetId }),
    ...(p.SecurityGroupIds && { SecurityGroupIds: p.SecurityGroupIds }),
    ...(p.KeyName && { KeyName: p.KeyName }),
    ...(p.Tags && { TagSpecifications: [{ ResourceType: 'instance', Tags: p.Tags }] }),
    ClientToken: p.ClientToken
  }),
  plan(p, s): Plan {
    const count = p.Count ?? 1
    const hourly = EC2_HOURLY[p.InstanceType]
    const cost = monthly(EC2_HOURLY, p.InstanceType, count)
    const name = p.Tags?.find((t) => t.Key === 'Name')?.Value
    const reasons = ['创建新实例并开始计费']
    if (count > 3) reasons.push(`一次创建 ${count} 台`)
    if (hourly === undefined) reasons.push(`实例类型 ${p.InstanceType} 不在参考价表里，费用未知`)
    else if (hourly >= 1) reasons.push(`单价高：约 $${hourly}/小时`)
    const thirdParty = !s.image.ownerAlias && s.image.public
    const t = s.type
    return {
      title: `创建 ${count} 台 EC2 实例（${p.InstanceType}${name ? ` · ${name}` : ''}）`,
      targets: [name ?? `${p.InstanceType}×${count}`],
      confirmText: name ?? `创建 ${count} 台 ${p.InstanceType}`,
      risk: count > 3 || hourly === undefined || hourly >= 1 ? 'high' : 'medium',
      reasons,
      change: {
        kind: 'create',
        summary: `创建 ${count} 台 ${p.InstanceType}`,
        fields: [
          { label: '实例类型', value: `${p.InstanceType}${t?.vcpu ? `（${t.vcpu} vCPU · ${Math.round((t.memoryMiB ?? 0) / 1024)} GiB 内存）` : ''}` },
          { label: '数量', value: `${count} 台` },
          { label: '镜像（AMI）', value: `${s.image.id} · ${s.image.name || '无名称'} · ${s.image.arch} · ${s.image.platform}` },
          s.subnet
            ? { label: '子网', value: `${s.subnet.id}（${s.subnet.az} · ${s.subnet.vpcId}）`, ...(s.subnet.publicIp && { note: '自动分配公网 IP' }) }
            : { label: '子网', value: '默认 VPC 的默认子网' },
          { label: '安全组', value: s.groups.length ? s.groups.map((g) => named(g.id, g.name)).join('，') : 'VPC 默认安全组' },
          ...(p.KeyName ? [{ label: '密钥对', value: p.KeyName }] : []),
          ...(p.Tags?.length ? [{ label: '标签', value: p.Tags.map((tag) => `${tag.Key}=${show(tag.Value)}`).join('，') }] : []),
          cost !== undefined
            ? { label: '预估月费', value: `约 ${usd(cost)}/月`, note: '按需参考价，us-east-1 Linux，不含 EBS 和流量' }
            : { label: '预估月费', value: '未知（实例类型不在参考价表里）' }
        ]
      },
      consequences: [
        { kind: 'cost', text: cost !== undefined ? `按需参考价约 ${usd(cost)}/月（${count} 台，us-east-1 Linux，不含 EBS 和流量）` : '费用未知（实例类型不在参考价表里）', ...(cost !== undefined && { monthlyUsd: cost }) },
        ...(s.subnet?.publicIp || !s.subnet ? [{ kind: 'blast-radius' as const, text: '实例可能拿到公网 IP，能否从公网访问取决于安全组' }] : []),
        ...(!s.groups.length ? [{ kind: 'dependency' as const, text: '没有指定安全组，会用 VPC 的默认安全组' }] : []),
        ...(thirdParty ? [{ kind: 'dependency' as const, text: `AMI 来自第三方账号 ${s.image.owner}（不是 Amazon 或本账号），请确认来源可信` }] : [])
      ],
      blockers: [
        ...(s.image.state !== 'available' ? [`AMI ${s.image.id} 当前是 ${s.image.state || '未知'}，不能用来启动`] : []),
        ...(t && s.image.arch && t.arches.length && !t.arches.includes(s.image.arch) ? [`${p.InstanceType} 不支持 AMI 的架构 ${s.image.arch}`] : [])
      ],
      tags: p.Tags ? [tagMap(p.Tags)] : []
    }
  },
  verify: async (_p, _ctx, response) => (response?.Instances ?? []).map((i: any) => `${i.InstanceId}: ${i.State?.Name ?? ''}`).join('，') || '已提交'
}

// ---- EBS volumes ----

const VolumeId = Type.String({ pattern: '^vol-[0-9a-f]{8,17}$' })

interface Volume {
  id: string
  name: string | null
  size: number
  type: string
  iops: number | null
  throughput: number | null
  state: string
  encrypted: boolean
  attachments: string[]
  tags: Record<string, string>
}

async function describeVolume(id: string, ctx: ChangeCtx): Promise<Volume> {
  const v = (await ctx.call('ec2', 'DescribeVolumes', { VolumeIds: [id] })).Volumes?.[0]
  if (!v) throw new Error(`${ctx.region} 里找不到卷 ${id}`)
  const tags = tagMap(v.Tags)
  return {
    id: v.VolumeId,
    name: tags.Name ?? null,
    size: v.Size ?? 0,
    type: v.VolumeType ?? '',
    iops: v.Iops ?? null,
    throughput: v.Throughput ?? null,
    state: v.State ?? 'unknown',
    encrypted: v.Encrypted === true,
    attachments: (v.Attachments ?? []).map((a: any) => `${a.InstanceId ?? '?'}:${a.Device ?? '?'}`).sort(),
    tags
  }
}

/** EBS storage, USD per GB-month, us-east-1. shortcut: reference prices for storage only; provisioned IOPS / throughput are extra and not counted. */
const EBS_GB_MONTH: Record<string, number> = { gp2: 0.1, gp3: 0.08, io1: 0.125, io2: 0.125, st1: 0.045, sc1: 0.015, standard: 0.05 }
const SNAPSHOT_GB_MONTH = 0.05

type SnapshotParams = { VolumeId: string; Description?: string; Tags?: { Key: string; Value: string }[] }

export const createSnapshot: ChangeAdapter<SnapshotParams, { volume: Volume }> = {
  service: 'ec2',
  action: 'CreateSnapshot',
  doc: 'VolumeId: vol-…；Description?；Tags?: {Key, Value}[]（打在快照上）',
  schema: Type.Object({ VolumeId, Description: Type.Optional(Type.String({ maxLength: 255, pattern: '^[^\\u0000-\\u001f]*$' })), Tags: Type.Optional(Tags) }, Strict),
  forbiddenParams: { OutpostArn: '不支持 Outposts', TagSpecifications: '请用 Tags' },
  snapshot: async (p, ctx) => ({ volume: await describeVolume(p.VolumeId, ctx) }),
  dryRun: true,
  request: (p) => ({
    VolumeId: p.VolumeId,
    ...(p.Description && { Description: p.Description }),
    ...(p.Tags && { TagSpecifications: [{ ResourceType: 'snapshot', Tags: p.Tags }] })
  }),
  plan(p, { volume: v }): Plan {
    return {
      title: `给卷 ${named(v.id, v.name)}（${v.size} GiB）创建快照`,
      targets: [v.id],
      confirmText: v.id,
      risk: 'low',
      reasons: ['创建快照（只读取卷的数据）'],
      change: {
        kind: 'create',
        fields: [
          { label: '源卷', value: named(v.id, v.name) },
          { label: '卷大小', value: `${v.size} GiB` },
          { label: '卷类型', value: v.type },
          { label: '加密', value: v.encrypted ? '是' : '否' },
          ...(p.Description ? [{ label: '描述', value: p.Description }] : []),
          ...(p.Tags?.length ? [{ label: '快照标签', value: p.Tags.map((t) => `${t.Key}=${show(t.Value)}`).join('，') }] : [])
        ]
      },
      consequences: [
        { kind: 'downtime', text: '不停机，卷在快照期间可以照常使用' },
        { kind: 'cost', text: `快照按实际存的数据计费（标准层参考价 $${SNAPSHOT_GB_MONTH}/GB-月，us-east-1）：第一个快照是全量，最多约 ${usd(v.size * SNAPSHOT_GB_MONTH)}/月，之后是增量` },
        ...(v.attachments.length ? [{ kind: 'data' as const, text: `卷正挂在 ${v.attachments.join(', ')} 上：快照是崩溃一致的，正在写入的数据可能不完整；需要应用一致时先停止实例或冻结文件系统` }] : [])
      ],
      blockers: ['in-use', 'available'].includes(v.state) ? [] : [`卷 ${v.id} 当前是 ${v.state}，不能创建快照`],
      tags: [v.tags]
    }
  },
  verify: async (_p, ctx, response) => {
    const id = response?.SnapshotId
    if (!id) return '已提交'
    const s = (await ctx.call('ec2', 'DescribeSnapshots', { SnapshotIds: [id] })).Snapshots?.[0]
    return `${id}: ${s?.State ?? '?'}${s?.Progress ? ` · ${s.Progress}` : ''}`
  }
}

type ModifyVolumeParams = { VolumeId: string; Size?: number; VolumeType?: string; Iops?: number; Throughput?: number }
interface ModifyVolumeSnapshot {
  volume: Volume
  /** The latest modification of the volume, if any. */
  last: { state: string; startTime: string } | null
  /** Hours since `last` started, when the snapshot was taken. Not part of drift: it moves by itself. */
  hoursSinceLast: number | null
}

export const modifyVolume: ChangeAdapter<ModifyVolumeParams, ModifyVolumeSnapshot> = {
  service: 'ec2',
  action: 'ModifyVolume',
  doc: 'VolumeId；Size?（GiB，只能增大）；VolumeType?: gp2|gp3|io1|io2|st1|sc1；Iops?；Throughput?（gp3，MiB/s）。至少给一项',
  schema: Type.Object(
    {
      VolumeId,
      Size: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })),
      VolumeType: Type.Optional(Type.Enum(['gp2', 'gp3', 'io1', 'io2', 'st1', 'sc1'])),
      Iops: Type.Optional(Type.Integer({ minimum: 100, maximum: 256000 })),
      Throughput: Type.Optional(Type.Integer({ minimum: 125, maximum: 2000 }))
    },
    Strict
  ),
  forbiddenParams: { MultiAttachEnabled: '多重挂载会影响数据一致性，请在 Console 里改' },
  async snapshot(p, ctx) {
    const volume = await describeVolume(p.VolumeId, ctx)
    let mods: any[] = []
    try {
      mods = (await ctx.call('ec2', 'DescribeVolumesModifications', { VolumeIds: [p.VolumeId] })).VolumesModifications ?? []
    } catch (err) {
      // A volume never modified answers NotFound rather than an empty list.
      if (!/NotFound/.test((err as { name?: string }).name ?? '')) throw err
    }
    const latest = mods.map((m) => ({ state: m.ModificationState ?? '', startTime: new Date(m.StartTime ?? 0).toISOString() })).sort((a, b) => b.startTime.localeCompare(a.startTime))[0] ?? null
    return { volume, last: latest, hoursSinceLast: latest ? (Date.now() - Date.parse(latest.startTime)) / 3600_000 : null }
  },
  drift: (s) => ({ volume: s.volume, last: s.last }),
  dryRun: true,
  plan(p, s): Plan {
    const v = s.volume
    const before = { Size: v.size, VolumeType: v.type, Iops: v.iops ?? undefined, Throughput: v.throughput ?? undefined }
    const after = { Size: p.Size ?? v.size, VolumeType: p.VolumeType ?? v.type, Iops: p.Iops ?? before.Iops, Throughput: p.Throughput ?? before.Throughput }
    const label: Record<keyof typeof before, [string, (x: string | number) => string]> = {
      Size: ['存储大小', (x) => `${x} GiB`],
      VolumeType: ['卷类型', String],
      Iops: ['IOPS', String],
      Throughput: ['吞吐量', (x) => `${x} MiB/s`]
    }
    const rows: ChangeRow[] = (Object.keys(label) as (keyof typeof before)[])
      .filter((k) => before[k] !== after[k])
      .map((k) => ({ item: label[k][0], before: before[k] === undefined ? NONE : label[k][1](before[k]), after: label[k][1](after[k] as string | number) }))
    const toHdd = p.VolumeType !== undefined && p.VolumeType !== v.type && (p.VolumeType === 'st1' || p.VolumeType === 'sc1')
    const grows = p.Size !== undefined && p.Size > v.size
    const from = EBS_GB_MONTH[v.type] !== undefined ? v.size * EBS_GB_MONTH[v.type] : undefined
    const to = EBS_GB_MONTH[after.VolumeType] !== undefined ? after.Size * EBS_GB_MONTH[after.VolumeType] : undefined
    const reasons = ['修改 EBS 卷']
    if (toHdd) reasons.push(`改成机械盘类型 ${p.VolumeType}：随机读写性能大幅下降，且不能作启动卷`)
    return {
      title: `修改卷 ${named(v.id, v.name)}（${v.type} · ${v.size} GiB）`,
      targets: [v.id],
      confirmText: v.id,
      risk: toHdd ? 'high' : 'medium',
      reasons,
      change: { kind: 'modify', rows },
      consequences: [
        { kind: 'downtime', text: '通常不停机；修改和之后的优化阶段（可能持续数小时）性能可能波动' },
        ...(grows
          ? [
              { kind: 'irreversible' as const, text: 'EBS 卷只能扩大，不能缩小' },
              { kind: 'dependency' as const, text: '扩大后要在操作系统里扩展分区和文件系统才能用上新空间' }
            ]
          : []),
        { kind: 'dependency', text: '修改后至少 6 小时内不能再次修改这个卷' },
        ...(toHdd ? [{ kind: 'dependency' as const, text: 'st1 / sc1 不能作启动卷；如果这是根卷，实例可能起不来' }] : []),
        {
          kind: 'cost',
          text: `存储参考价 ${from !== undefined ? usd(from) : '未知'}/月 → ${to !== undefined ? usd(to) : '未知'}/月（us-east-1，不含 IOPS / 吞吐量费用）`,
          ...(to !== undefined && { monthlyUsd: Math.round(to * 100) / 100 })
        }
      ],
      blockers: [
        ...(p.Size !== undefined && p.Size < v.size ? [`EBS 卷只能扩大：当前 ${v.size} GiB，不能改成 ${p.Size} GiB`] : []),
        ...(!['in-use', 'available'].includes(v.state) ? [`卷 ${v.id} 当前是 ${v.state}`] : []),
        ...(s.last && (s.last.state === 'modifying' || s.last.state === 'optimizing') ? [`卷 ${v.id} 的上一次修改还在进行（${s.last.state}）`] : []),
        ...(s.hoursSinceLast !== null && s.hoursSinceLast < 6 ? [`距离上一次修改不到 6 小时（AWS 限制），请稍后再试`] : []),
        ...(rows.length ? [] : ['没有变更（值和现在一样，或没有给出要修改的字段）'])
      ],
      tags: [v.tags]
    }
  },
  verify: async (p, ctx) => {
    const m = (await ctx.call('ec2', 'DescribeVolumesModifications', { VolumeIds: [p.VolumeId] })).VolumesModifications?.[0]
    return m ? `${p.VolumeId}: ${m.ModificationState ?? '?'} · ${m.TargetVolumeType ?? ''} ${m.TargetSize ?? ''} GiB` : '已提交'
  }
}

export const EC2_ADAPTERS = [
  startInstances,
  stopInstances,
  rebootInstances,
  terminateInstances,
  modifyInstanceAttribute,
  createTags,
  deleteTags,
  authorizeIngress,
  revokeIngress,
  authorizeEgress,
  revokeEgress,
  runInstances,
  createSnapshot,
  modifyVolume
]
