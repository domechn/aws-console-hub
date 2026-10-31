import { describe, expect, it } from 'vitest'
import type { AwsAccount } from '../../../shared/types'
import type { ChangeAdapter, ChangeCtx } from './common'
import { createChangeSet } from './cfn'
import { updateTable } from './dynamodb'
import { createSnapshot, modifyVolume } from './ec2'
import { ProposalEngine } from './engine'
import { lookupChange } from './registry'
import { createBucket, modifyDb } from './services'
import { tagResources, untagResources } from './tagging'
import { awsErr, AWS_ACCOUNT, fakeAws } from './testing'

const REGION = 'ap-northeast-1'
const ARN_I = `arn:aws:ec2:${REGION}:${AWS_ACCOUNT}:instance/i-0aaaaaaaaaaaaaaa1`
const ARN_Q = `arn:aws:sqs:${REGION}:${AWS_ACCOUNT}:jobs`
const HOUR = 3600_000

const db = (patch: Record<string, unknown> = {}) => ({
  DBInstanceIdentifier: 'app-db',
  DBInstanceStatus: 'available',
  Engine: 'postgres',
  EngineVersion: '16.3',
  DBInstanceClass: 'db.t3.medium',
  MultiAZ: false,
  AllocatedStorage: 100,
  BackupRetentionPeriod: 7,
  PreferredMaintenanceWindow: 'sun:18:00-sun:18:30',
  PendingModifiedValues: {},
  TagList: [],
  ...patch
})
const table = (patch: Record<string, unknown> = {}) => ({
  TableName: 'orders',
  TableArn: `arn:aws:dynamodb:${REGION}:${AWS_ACCOUNT}:table/orders`,
  TableStatus: 'ACTIVE',
  BillingModeSummary: { BillingMode: 'PROVISIONED' },
  ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 5, NumberOfDecreasesToday: 1 },
  DeletionProtectionEnabled: true,
  ...patch
})
const volume = (patch: Record<string, unknown> = {}) => ({
  VolumeId: 'vol-0aaaaaaaaaaaaaaa1',
  Size: 100,
  VolumeType: 'gp3',
  Iops: 3000,
  Throughput: 125,
  State: 'in-use',
  Encrypted: true,
  Attachments: [{ InstanceId: 'i-0aaaaaaaaaaaaaaa1', Device: '/dev/xvda' }],
  Tags: [{ Key: 'Name', Value: 'web-root' }],
  ...patch
})

type Handlers = Record<string, (p: any, region: string) => unknown>

function world(over: Handlers = {}) {
  const tags: Record<string, { Key: string; Value: string }[]> = { [ARN_I]: [{ Key: 'Name', Value: 'web-1' }, { Key: 'env', Value: 'prod' }] }
  return {
    tags,
    ...fakeAws({
      'rds:DescribeDBInstances': () => ({ DBInstances: [db()] }),
      'rds:ModifyDBInstance': () => ({ $metadata: { requestId: 'req-modify-db' } }),
      'dynamodb:DescribeTable': () => ({ Table: table() }),
      'dynamodb:ListTagsOfResource': () => ({ Tags: [{ Key: 'team', Value: 'core' }] }),
      'dynamodb:UpdateTable': () => ({ $metadata: { requestId: 'req-ddb' } }),
      's3:HeadBucket': () => Promise.reject(Object.assign(awsErr('NotFound'), { $metadata: { httpStatusCode: 404 } })),
      's3:CreateBucket': () => ({ $metadata: { requestId: 'req-create' } }),
      's3:PutPublicAccessBlock': () => ({}),
      's3:PutBucketVersioning': () => ({}),
      's3:GetPublicAccessBlock': () => ({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }),
      's3:GetBucketVersioning': () => ({ Status: 'Enabled' }),
      'tag:GetResources': (p) => ({ ResourceTagMappingList: p.ResourceARNList.filter((a: string) => tags[a]).map((a: string) => ({ ResourceARN: a, Tags: tags[a] })) }),
      'tag:TagResources': () => ({ FailedResourcesMap: {}, $metadata: { requestId: 'req-tag' } }),
      'tag:UntagResources': () => ({ FailedResourcesMap: {} }),
      'iam:SimulatePrincipalPolicy': (p) => ({ EvaluationResults: p.ActionNames.map((x: string) => ({ EvalActionName: x, EvalDecision: 'allowed' })) }),
      'ec2:DescribeVolumes': () => ({ Volumes: [volume()] }),
      'ec2:DescribeVolumesModifications': () => Promise.reject(awsErr('InvalidVolumeModification.NotFound')),
      'ec2:DescribeSnapshots': (p) => ({ Snapshots: [{ SnapshotId: p.SnapshotIds[0], State: 'pending', Progress: '0%' }] }),
      ...over
    })
  }
}

async function planOf(a: ChangeAdapter, params: any, over?: Handlers) {
  const w = world(over)
  const ctx: ChangeCtx = { region: REGION, proposalId: 'p-0123456789ab', call: (s, act, p, r) => w.aws('acc-1', s, act, p, r ?? REGION) as Promise<any> }
  const p = a.normalize ? a.normalize(structuredClone(params), ctx) : params
  const s = await a.snapshot(p, ctx)
  return { p, s, plan: a.plan(p, s), w, ctx }
}
const kinds = (plan: { consequences: { kind: string }[] }) => plan.consequences.map((c) => c.kind)

describe('rds:ModifyDBInstance', () => {
  it('class change: high, restart named with its timing; maintenance window by default, now when asked', async () => {
    const later = await planOf(modifyDb, { DBInstanceIdentifier: 'app-db', DBInstanceClass: 'db.m6g.large', ApplyImmediately: false })
    expect(later.plan).toMatchObject({ title: '修改数据库 app-db（postgres 16.3 · db.t3.medium）（维护窗口应用）', risk: 'high', confirmText: 'app-db', blockers: [] })
    expect(later.plan.change).toEqual({
      kind: 'modify',
      rows: [{ item: '实例规格', before: 'db.t3.medium', after: 'db.m6g.large' }],
      fields: [{ label: '应用时间', value: '下一个维护窗口（sun:18:00-sun:18:30，UTC）' }]
    })
    expect(later.plan.consequences[0].text).toBe('在下一个维护窗口（sun:18:00-sun:18:30，UTC）重启数据库：单可用区，通常中断几分钟到十几分钟，期间连接全部断开')
    expect(later.plan.consequences[1]).toEqual({ kind: 'cost', text: '实例参考价 $49.64/月 → $111/月（us-east-1）', monthlyUsd: 110.96 })
    expect(kinds(later.plan)).toEqual(['downtime', 'cost', 'dependency'])
    expect(modifyDb.request!(later.p, later.s)).toEqual({ DBInstanceIdentifier: 'app-db', DBInstanceClass: 'db.m6g.large', ApplyImmediately: false })
    const now = await planOf(modifyDb, { DBInstanceIdentifier: 'app-db', DBInstanceClass: 'db.m6g.large', ApplyImmediately: true }, {
      'rds:DescribeDBInstances': () => ({ DBInstances: [db({ MultiAZ: true, PendingModifiedValues: { AllocatedStorage: 200 } })] })
    })
    expect(now.plan.consequences[0].text).toContain('立即重启数据库：Multi-AZ 先改备用实例再故障转移')
    expect(now.plan.consequences.find((c) => c.text.startsWith('已有等待维护窗口的修改'))?.text).toBe('已有等待维护窗口的修改：{"AllocatedStorage":200}。立即应用时，这些修改也会一起应用')
  })

  it('storage: increase only, medium, irreversible; backups off is destructive; 0 → n is an outage', async () => {
    const grow = await planOf(modifyDb, { DBInstanceIdentifier: 'app-db', AllocatedStorage: 200, ApplyImmediately: true })
    expect(grow.plan).toMatchObject({ risk: 'medium', blockers: [] })
    expect(grow.plan.change).toEqual({ kind: 'modify', rows: [{ item: '存储大小', before: '100 GiB', after: '200 GiB' }], fields: [{ label: '应用时间', value: '立即应用' }] })
    expect(kinds(grow.plan)).toEqual(['irreversible', 'downtime', 'cost'])
    expect((await planOf(modifyDb, { DBInstanceIdentifier: 'app-db', AllocatedStorage: 50, ApplyImmediately: true })).plan.blockers).toEqual([
      'RDS 存储只能增大：当前 100 GiB，不能改成 50 GiB'
    ])
    const off = await planOf(modifyDb, { DBInstanceIdentifier: 'app-db', BackupRetentionPeriod: 0, ApplyImmediately: true })
    expect(off.plan).toMatchObject({ risk: 'destructive', reasons: ['关闭自动备份：现有自动备份会被删除，时间点恢复不再可用'] })
    expect(off.plan.change.rows).toEqual([{ item: '备份保留天数', before: '7 天', after: '0 天（关闭自动备份）' }])
    expect(kinds(off.plan)).toEqual(['irreversible', 'downtime'])
    expect((await planOf(modifyDb, { DBInstanceIdentifier: 'app-db', BackupRetentionPeriod: 14, ApplyImmediately: true })).plan.risk).toBe('low')
    const on = await planOf(modifyDb, { DBInstanceIdentifier: 'app-db', BackupRetentionPeriod: 7, ApplyImmediately: false }, { 'rds:DescribeDBInstances': () => ({ DBInstances: [db({ BackupRetentionPeriod: 0 })] }) })
    expect(on.plan).toMatchObject({ risk: 'medium' })
    expect(on.plan.consequences[0].text).toBe('在下一个维护窗口（sun:18:00-sun:18:30，UTC）开启或关闭自动备份会造成一次短暂中断')
  })

  it('blocks no-ops, non-available instances, and storage / retention on Aurora members; forbids passwords, public access, PassRole', async () => {
    expect((await planOf(modifyDb, { DBInstanceIdentifier: 'app-db', DBInstanceClass: 'db.t3.medium', ApplyImmediately: true })).plan.blockers).toEqual(['没有变更（值和现在一样，或没有给出要修改的字段）'])
    const busy = await planOf(modifyDb, { DBInstanceIdentifier: 'app-db', AllocatedStorage: 200, ApplyImmediately: true }, {
      'rds:DescribeDBInstances': () => ({ DBInstances: [db({ DBInstanceStatus: 'modifying', DBClusterIdentifier: 'c1' })] })
    })
    expect(busy.plan.blockers).toEqual(['app-db 当前是 modifying，只能修改 available 的实例', 'app-db 属于 Aurora 集群 c1，存储和备份保留期在集群级别设置（不支持）'])
    for (const k of ['MasterUserPassword', 'PubliclyAccessible', 'MonitoringRoleArn', 'DeletionProtection', 'EngineVersion']) expect(modifyDb.forbiddenParams![k]).toBeTruthy()
    expect(modifyDb.arns!({ DBInstanceIdentifier: 'app-db', ApplyImmediately: true }, { region: REGION, account: AWS_ACCOUNT })).toEqual([`arn:aws:rds:${REGION}:${AWS_ACCOUNT}:db:app-db`])
  })
})

describe('dynamodb:UpdateTable', () => {
  it('deletion protection off is high; on is low; throughput increase low with cost, decrease medium with the daily limit', async () => {
    const off = await planOf(updateTable, { TableName: 'orders', DeletionProtectionEnabled: false })
    expect(off.plan).toMatchObject({ risk: 'high', confirmText: 'orders', blockers: [], tags: [{ team: 'core' }] })
    expect(off.plan.change).toEqual({ kind: 'modify', rows: [{ item: '删除保护', before: '开启', after: '关闭' }] })
    const on = await planOf(updateTable, { TableName: 'orders', DeletionProtectionEnabled: true }, { 'dynamodb:DescribeTable': () => ({ Table: table({ DeletionProtectionEnabled: false }) }) })
    expect(on.plan.risk).toBe('low')
    const up = await planOf(updateTable, { TableName: 'orders', ProvisionedThroughput: { ReadCapacityUnits: 100, WriteCapacityUnits: 50 } })
    expect(up.plan).toMatchObject({ risk: 'low', blockers: [] })
    expect(up.plan.change.rows).toEqual([
      { item: '读容量', before: '10 RCU', after: '100 RCU' },
      { item: '写容量', before: '5 WCU', after: '50 WCU' }
    ])
    expect(up.plan.consequences[0]).toEqual({ kind: 'cost', text: '预置容量参考价约 $33.21/月（100 RCU + 50 WCU，us-east-1 标准表，不含存储和索引）', monthlyUsd: 33.21 })
    expect(updateTable.request!(up.p, up.s)).toEqual({ TableName: 'orders', ProvisionedThroughput: { ReadCapacityUnits: 100, WriteCapacityUnits: 50 } })
    const down = await planOf(updateTable, { TableName: 'orders', ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } })
    expect(down.plan.risk).toBe('medium')
    expect(down.plan.consequences.at(-1)?.text).toBe('AWS 限制每天缩减容量的次数（今天已缩减 1 次）')
    // The decrease counter is not drift.
    expect(updateTable.drift!({ ...down.s, decreasesToday: 3 })).toEqual(updateTable.drift!(down.s))
  })

  it('billing switches and their preconditions; no-op and non-ACTIVE blocked; index and stream changes forbidden', async () => {
    const ondemand = await planOf(updateTable, { TableName: 'orders', BillingMode: 'PAY_PER_REQUEST' })
    expect(ondemand.plan).toMatchObject({ risk: 'medium', blockers: [], change: { kind: 'modify', rows: [{ item: '计费模式', before: '预置（PROVISIONED）', after: '按需（PAY_PER_REQUEST）' }] } })
    expect(kinds(ondemand.plan)).toEqual(['dependency', 'cost'])
    const ppr = () => ({ Table: table({ BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' }, ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 }, GlobalSecondaryIndexes: [{}] }) })
    expect((await planOf(updateTable, { TableName: 'orders', BillingMode: 'PROVISIONED' }, { 'dynamodb:DescribeTable': ppr })).plan.blockers).toEqual([
      '切换到预置模式（PROVISIONED）必须同时给出 ProvisionedThroughput',
      '表有 1 个全局二级索引，切换到预置模式要同时设置索引的容量（不支持），请在 Console 里操作'
    ])
    expect((await planOf(updateTable, { TableName: 'orders', ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } }, { 'dynamodb:DescribeTable': ppr })).plan.blockers).toEqual([
      '按需模式（PAY_PER_REQUEST）不能设置预置容量'
    ])
    expect((await planOf(updateTable, { TableName: 'orders', DeletionProtectionEnabled: true })).plan.blockers).toEqual(['没有变更（值和现在一样，或没有给出要修改的字段）'])
    expect((await planOf(updateTable, { TableName: 'orders', DeletionProtectionEnabled: false }, { 'dynamodb:DescribeTable': () => ({ Table: table({ TableStatus: 'UPDATING' }) }) })).plan.blockers).toEqual([
      '表 orders 当前是 UPDATING，只能修改 ACTIVE 的表'
    ])
    for (const k of ['GlobalSecondaryIndexUpdates', 'StreamSpecification', 'SSESpecification', 'ReplicaUpdates']) expect(updateTable.forbiddenParams![k]).toBeTruthy()
    // No adapter: a generic request card (the user sees the request and types the action name).
    expect(lookupChange('dynamodb', 'DeleteTable')).toEqual({ generic: true })
  })
})

describe('s3:CreateBucket', () => {
  it('a free name: medium, BPA and ACL-off on the card, region from the proposal', async () => {
    const { plan, p, s, w, ctx } = await planOf(createBucket, { Bucket: 'my-new-bucket', Versioning: true })
    expect(plan).toMatchObject({ title: `创建 S3 桶 my-new-bucket（${REGION}）`, risk: 'medium', confirmText: 'my-new-bucket', blockers: [] })
    expect(plan.change).toEqual({
      kind: 'create',
      fields: [
        { label: '桶名', value: 'my-new-bucket' },
        { label: 'Region', value: REGION },
        { label: '公开访问阻止', value: '全部开启（4 项）' },
        { label: '对象所有权', value: '禁用 ACL（BucketOwnerEnforced）' },
        { label: '版本控制', value: '开启' }
      ]
    })
    await createBucket.execute!(p, s, ctx)
    expect(w.writes().map((c) => [c.action, c.params])).toEqual([
      ['CreateBucket', { Bucket: 'my-new-bucket', ObjectOwnership: 'BucketOwnerEnforced', CreateBucketConfiguration: { LocationConstraint: REGION } }],
      ['PutPublicAccessBlock', { Bucket: 'my-new-bucket', PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }],
      ['PutBucketVersioning', { Bucket: 'my-new-bucket', VersioningConfiguration: { Status: 'Enabled' } }]
    ])
    expect(await createBucket.verify!(p, ctx, {})).toBe('my-new-bucket: 公开访问阻止全部开启 · 版本控制 Enabled')
  })

  it('us-east-1 has no LocationConstraint; a failure after creation says the bucket exists', async () => {
    const w = world({ 's3:PutPublicAccessBlock': () => Promise.reject(awsErr('AccessDenied', 'denied')) })
    const ctx: ChangeCtx = { region: 'us-east-1', proposalId: 'p-0123456789ab', call: (s, act, p, r) => w.aws('acc-1', s, act, p, r ?? 'us-east-1') as Promise<any> }
    await expect(createBucket.execute!({ Bucket: 'b-1-x' }, { exists: 'free', region: 'us-east-1' }, ctx)).rejects.toThrow('桶 b-1-x 已创建，但开启公开访问阻止失败：AccessDenied: denied')
    expect(w.of('s3', 'CreateBucket')[0].params).toEqual({ Bucket: 'b-1-x', ObjectOwnership: 'BucketOwnerEnforced' })
  })

  it('names that exist (mine, another account, another region) are blocked; bad names and ACL params refused by schema / forbidden list', async () => {
    const head = (status: number, name: string) => ({ 's3:HeadBucket': () => Promise.reject(Object.assign(awsErr(name), { $metadata: { httpStatusCode: status } })) })
    expect((await planOf(createBucket, { Bucket: 'taken-x' }, { 's3:HeadBucket': () => ({}) })).plan.blockers).toEqual(['桶 taken-x 已存在（你的账号）'])
    expect((await planOf(createBucket, { Bucket: 'taken-x' }, head(403, 'Forbidden'))).plan.blockers).toEqual(['桶名 taken-x 已被其他账号占用，请换一个名字'])
    expect((await planOf(createBucket, { Bucket: 'taken-x' }, head(301, 'PermanentRedirect'))).plan.blockers?.[0]).toContain('已存在于其他 region')
    await expect(planOf(createBucket, { Bucket: 'x-y' }, head(500, 'InternalError'))).rejects.toThrow('InternalError')
    const { Value } = await import('typebox/value')
    for (const bad of ['Ab-c', 'a..b', '192.168.1.1', 'xn--abc', 'foo-s3alias', 'ab', 'a_b-c']) expect(Value.Check(createBucket.schema, { Bucket: bad }), bad).toBe(false)
    expect(Value.Check(createBucket.schema, { Bucket: 'my.dotted-bucket' })).toBe(true)
    for (const k of ['ACL', 'GrantRead', 'ObjectOwnership', 'CreateBucketConfiguration']) expect(createBucket.forbiddenParams![k]).toBeTruthy()
    expect((await planOf(createBucket, { Bucket: 'my.dotted-bucket' })).plan.consequences.at(-1)?.text).toContain('桶名含点号')
  })
})

describe('tag:TagResources / UntagResources', () => {
  it('diffs per ARN; never-tagged resources start empty; meaningful keys and losing env=prod raise to medium', async () => {
    const plain = await planOf(tagResources, { ResourceARNList: [ARN_Q, ARN_Q], Tags: { cost: 'x1' } })
    expect(plain.p.ResourceARNList).toEqual([ARN_Q])
    expect(plain.plan).toMatchObject({ risk: 'low', confirmText: 'jobs', blockers: [] })
    expect(plain.plan.change).toEqual({ kind: 'modify', rows: [{ item: '标签 cost', before: '无', after: 'x1' }] })
    // Several ARNs: each row names its resource; a never-tagged one starts empty.
    const both = await planOf(tagResources, { ResourceARNList: [ARN_Q, ARN_I], Tags: { cost: 'x1' } })
    expect(both.plan.change.rows).toEqual([
      { target: ARN_I, item: '标签 cost', before: '无', after: 'x1' },
      { target: ARN_Q, item: '标签 cost', before: '无', after: 'x1' }
    ])
    const env = await planOf(tagResources, { ResourceARNList: [ARN_I], Tags: { env: 'dev' } })
    expect(env.plan.risk).toBe('medium')
    expect(env.plan.reasons).toEqual(['只改标签', '涉及 env：可能影响基于标签的权限（ABAC）、成本分摊和本应用的生产识别', '会去掉生产环境标签（env=prod 等）：之后的提案不再因此升一级风险'])
    expect(env.plan.tags).toEqual([{ Name: 'web-1', env: 'prod' }])
    const untag = await planOf(untagResources, { ResourceARNList: [ARN_I], TagKeys: ['env', 'nope'] })
    expect(untag.plan.change).toEqual({ kind: 'modify', rows: [{ item: '标签 env', before: 'prod', after: '（删除）' }] })
    expect(untag.plan.risk).toBe('medium')
    expect((await planOf(untagResources, { ResourceARNList: [ARN_Q], TagKeys: ['nope'] })).plan.blockers).toEqual(['没有变更'])
  })

  it('refuses ABAC-guarded services, unknown services, other accounts and other regions, and never looks them up', async () => {
    const arns = [
      `arn:aws:iam::${AWS_ACCOUNT}:role/Admin`,
      `arn:aws:kms:${REGION}:${AWS_ACCOUNT}:key/1234`,
      `arn:aws:secretsmanager:${REGION}:${AWS_ACCOUNT}:secret:db`,
      `arn:aws:route53:::hostedzone/Z1`,
      `arn:aws:sqs:${REGION}:999999999999:theirs`,
      `arn:aws:sqs:us-east-1:${AWS_ACCOUNT}:elsewhere`
    ]
    const { plan, w } = await planOf(tagResources, { ResourceARNList: arns, Tags: { a: '1' } })
    expect(plan.blockers).toHaveLength(6)
    expect(plan.blockers!.join('\n')).toMatch(/IAM 资源的标签可能用于权限判断（ABAC）[\s\S]*KMS[\s\S]*不支持给 route53[\s\S]*Secrets Manager[\s\S]*不属于当前账号[\s\S]*在 us-east-1，提案的 region 是 ap-northeast-1/)
    expect(w.of('tag', 'GetResources')).toEqual([])
  })

  it('a partial failure (FailedResourcesMap) is an error that names the failed ARNs', async () => {
    const { p, s, ctx } = await planOf(tagResources, { ResourceARNList: [ARN_I, ARN_Q], Tags: { cost: 'x' } }, {
      'tag:TagResources': () => ({ FailedResourcesMap: { [ARN_Q]: { StatusCode: 403, ErrorCode: 'InvalidParameterException', ErrorMessage: 'no' } } })
    })
    await expect(tagResources.execute!(p, s, ctx)).rejects.toThrow(`1 个资源设置标签失败（其余资源已修改）：${ARN_Q}（InvalidParameterException: no）`)
  })

  it('the schema refuses aws: keys (any case) and non-ARNs', async () => {
    const { Value } = await import('typebox/value')
    expect(Value.Check(tagResources.schema, { ResourceARNList: [ARN_Q], Tags: { 'AWS:x': '1' } })).toBe(false)
    expect(Value.Check(tagResources.schema, { ResourceARNList: ['i-0abc'], Tags: { a: '1' } })).toBe(false)
    expect(Value.Check(untagResources.schema, { ResourceARNList: [ARN_Q], TagKeys: ['aws:cloudformation:stack-name'] })).toBe(false)
  })
})

describe('EBS: CreateSnapshot / ModifyVolume', () => {
  it('CreateSnapshot: low, crash-consistency called out for attached volumes, tags on the snapshot, verify reads it back', async () => {
    const { plan, p, s, ctx } = await planOf(createSnapshot, { VolumeId: 'vol-0aaaaaaaaaaaaaaa1', Description: 'before upgrade', Tags: [{ Key: 'purpose', Value: 'backup' }] })
    expect(plan).toMatchObject({ title: '给卷 web-root（vol-0aaaaaaaaaaaaaaa1）（100 GiB）创建快照', risk: 'low', blockers: [] })
    expect(kinds(plan)).toEqual(['downtime', 'cost', 'data'])
    expect(plan.change).toEqual({
      kind: 'create',
      fields: [
        { label: '源卷', value: 'web-root（vol-0aaaaaaaaaaaaaaa1）' },
        { label: '卷大小', value: '100 GiB' },
        { label: '卷类型', value: 'gp3' },
        { label: '加密', value: '是' },
        { label: '描述', value: 'before upgrade' },
        { label: '快照标签', value: 'purpose=backup' }
      ]
    })
    expect(plan.consequences[1].text).toContain('最多约 $5.00/月')
    expect(createSnapshot.request!(p, s)).toEqual({ VolumeId: 'vol-0aaaaaaaaaaaaaaa1', Description: 'before upgrade', TagSpecifications: [{ ResourceType: 'snapshot', Tags: [{ Key: 'purpose', Value: 'backup' }] }] })
    expect(await createSnapshot.verify!(p, ctx, { SnapshotId: 'snap-1' })).toBe('snap-1: pending · 0%')
    expect((await planOf(createSnapshot, { VolumeId: 'vol-0aaaaaaaaaaaaaaa1' }, { 'ec2:DescribeVolumes': () => ({ Volumes: [volume({ State: 'error' })] }) })).plan.blockers).toEqual([
      '卷 vol-0aaaaaaaaaaaaaaa1 当前是 error，不能创建快照'
    ])
  })

  it('ModifyVolume: grow is medium and irreversible; to st1/sc1 high; shrink, no-op, in-progress and the 6-hour cooldown are blocked', async () => {
    const grow = await planOf(modifyVolume, { VolumeId: 'vol-0aaaaaaaaaaaaaaa1', Size: 200 })
    expect(grow.plan).toMatchObject({ risk: 'medium', blockers: [] })
    expect(grow.plan.change).toEqual({ kind: 'modify', rows: [{ item: '存储大小', before: '100 GiB', after: '200 GiB' }] })
    const retype = await planOf(modifyVolume, { VolumeId: 'vol-0aaaaaaaaaaaaaaa1', VolumeType: 'io2', Iops: 5000, Throughput: 250 })
    expect(retype.plan.change.rows).toEqual([
      { item: '卷类型', before: 'gp3', after: 'io2' },
      { item: 'IOPS', before: '3000', after: '5000' },
      { item: '吞吐量', before: '125 MiB/s', after: '250 MiB/s' }
    ])
    expect(kinds(grow.plan)).toEqual(['downtime', 'irreversible', 'dependency', 'dependency', 'cost'])
    expect(grow.plan.consequences.at(-1)).toEqual({ kind: 'cost', text: '存储参考价 $8.00/月 → $16.00/月（us-east-1，不含 IOPS / 吞吐量费用）', monthlyUsd: 16 })
    expect((await planOf(modifyVolume, { VolumeId: 'vol-0aaaaaaaaaaaaaaa1', VolumeType: 'sc1' })).plan.risk).toBe('high')
    expect((await planOf(modifyVolume, { VolumeId: 'vol-0aaaaaaaaaaaaaaa1', Size: 50 })).plan.blockers).toEqual(['EBS 卷只能扩大：当前 100 GiB，不能改成 50 GiB'])
    expect((await planOf(modifyVolume, { VolumeId: 'vol-0aaaaaaaaaaaaaaa1', VolumeType: 'gp3' })).plan.blockers).toEqual(['没有变更（值和现在一样，或没有给出要修改的字段）'])
    const recent = { 'ec2:DescribeVolumesModifications': () => ({ VolumesModifications: [{ ModificationState: 'optimizing', StartTime: new Date(Date.now() - 2 * HOUR) }] }) }
    expect((await planOf(modifyVolume, { VolumeId: 'vol-0aaaaaaaaaaaaaaa1', Size: 200 }, recent)).plan.blockers).toEqual([
      '卷 vol-0aaaaaaaaaaaaaaa1 的上一次修改还在进行（optimizing）',
      '距离上一次修改不到 6 小时（AWS 限制），请稍后再试'
    ])
    const old = { 'ec2:DescribeVolumesModifications': () => ({ VolumesModifications: [{ ModificationState: 'completed', StartTime: new Date(Date.now() - 30 * HOUR) }] }) }
    const ok = await planOf(modifyVolume, { VolumeId: 'vol-0aaaaaaaaaaaaaaa1', Size: 200 }, old)
    expect(ok.plan.blockers).toEqual([])
    // Time since the last modification moves by itself: not drift.
    expect(modifyVolume.drift!({ ...ok.s, hoursSinceLast: 99 })).toEqual(modifyVolume.drift!(ok.s))
  })
})

describe('cloudformation:CreateChangeSet plan', () => {
  it('one row per resource change; removals are also listed as removed', () => {
    const change = (action: string, logicalId: string, physicalId: string, replacement = 'False') => ({ action, logicalId, physicalId, type: 'AWS::SQS::Queue', replacement })
    const plan = createChangeSet.plan(
      { StackName: 'app', UsePreviousTemplate: true, ChangeSetName: 'ai-p-0123456789ab' },
      {
        status: 'CREATE_COMPLETE',
        executionStatus: 'AVAILABLE',
        statusReason: '',
        stackStatus: 'UPDATE_COMPLETE',
        lastUpdated: '',
        changes: [change('Add', 'New', ''), change('Modify', 'Jobs', 'q-jobs', 'True'), change('Modify', 'Logs', 'q-logs'), change('Remove', 'Old', 'q-old')]
      }
    )
    expect(plan.risk).toBe('destructive')
    expect(plan.change).toEqual({
      kind: 'modify',
      rows: [
        { item: 'New（AWS::SQS::Queue）', before: '无', after: '新建' },
        { item: 'Jobs（AWS::SQS::Queue）', before: 'q-jobs', after: '替换（先建新的再删旧的）' },
        { item: 'Logs（AWS::SQS::Queue）', before: 'q-logs', after: '原地修改' },
        { item: 'Old（AWS::SQS::Queue）', before: 'q-old', after: '删除' }
      ],
      removed: [{ name: 'Old（AWS::SQS::Queue）', detail: 'q-old' }]
    })
  })
})

describe('through the engine: nothing written before confirm, exactly the change after', () => {
  const account: AwsAccount = { id: 'acc-1', kind: 'base', name: 'Sandbox', accountId: AWS_ACCOUNT, role: 'Admin', command: 'x', defaultRegion: REGION, color: '#000', aiAllowWrite: true }
  function engineWith(over: Handlers = {}) {
    const w = world(over)
    const audits: { type: string; data: Record<string, any> }[] = []
    const engine = new ProposalEngine({ aws: w.aws, account: () => account, audit: (type, _a, data) => audits.push({ type, data }), onState: () => {} })
    const propose = (service: string, action: string, params: unknown) => engine.propose({ accountId: 'acc-1', conversationId: 'c1', region: REGION }, { service, action, params })
    const confirm = (id: string, typed?: string) => engine.confirm('acc-1', 'c1', id, typed)
    return { w, audits, propose, confirm }
  }

  it('CreateBucket: zero writes at proposal, three after confirm', async () => {
    const e = engineWith()
    const { view } = await e.propose('s3', 'CreateBucket', { Bucket: 'my-new-bucket', Versioning: true })
    expect(e.w.writes()).toEqual([])
    expect(await e.confirm(view.id)).toMatchObject({ status: 'succeeded', requestId: 'req-create', summary: 'my-new-bucket: 公开访问阻止全部开启 · 版本控制 Enabled' })
    expect(e.w.writes().map((c) => c.action)).toEqual(['CreateBucket', 'PutPublicAccessBlock', 'PutBucketVersioning'])
  })

  it('TagResources: the guard lets tag:GetResources through; a partial failure is recorded as failed', async () => {
    const e = engineWith({ 'tag:TagResources': () => ({ FailedResourcesMap: { [ARN_Q]: { ErrorCode: 'InternalServiceException' } } }) })
    const { view } = await e.propose('tag', 'TagResources', { ResourceARNList: [ARN_Q], Tags: { cost: 'x' } })
    expect(e.w.writes()).toEqual([])
    expect(e.w.of('tag', 'GetResources')).toHaveLength(1)
    expect(await e.confirm(view.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('InternalServiceException') })
    expect(e.w.writes().map((c) => c.action)).toEqual(['TagResources'])
    expect(e.audits.map((a) => a.type)).toContain('proposal_failed')
  })

  it('ModifyDBInstance: high needs the id typed; sends exactly the stored request', async () => {
    const e = engineWith()
    const { view } = await e.propose('rds', 'ModifyDBInstance', { DBInstanceIdentifier: 'app-db', DBInstanceClass: 'db.m6g.large', ApplyImmediately: true })
    expect(view).toMatchObject({ risk: 'high', confirmText: 'app-db' })
    expect(e.w.writes()).toEqual([])
    await expect(e.confirm(view.id, 'wrong')).rejects.toThrow('不一致')
    expect(await e.confirm(view.id, 'app-db')).toMatchObject({ status: 'succeeded', requestId: 'req-modify-db' })
    expect(e.w.writes().map((c) => [c.action, c.params])).toEqual([['ModifyDBInstance', { DBInstanceIdentifier: 'app-db', DBInstanceClass: 'db.m6g.large', ApplyImmediately: true }]])
  })

  it("refuses the missing ApplyImmediately (no default); a param the adapter won't model goes to a tier C generic card that shows the value, the audit row doesn't", async () => {
    const e = engineWith()
    await expect(e.propose('rds', 'ModifyDBInstance', { DBInstanceIdentifier: 'app-db', DBInstanceClass: 'db.m6g.large' })).rejects.toThrow('参数无效')
    const { view } = await e.propose('rds', 'ModifyDBInstance', { DBInstanceIdentifier: 'app-db', MasterUserPassword: 'hunter2-secret', ApplyImmediately: true })
    expect(view).toMatchObject({ generic: true, tier: 'C' })
    expect(view.dangers?.join()).toContain('MasterUserPassword')
    // The model chose this value: the user must see what the password is being set to.
    expect(JSON.stringify(view.card)).toContain('hunter2-secret')
    expect(JSON.stringify(e.audits)).not.toContain('hunter2-secret')
    expect(e.w.calls.filter((c) => !['sts', 'iam'].includes(c.service))).toEqual([])
  })
})
