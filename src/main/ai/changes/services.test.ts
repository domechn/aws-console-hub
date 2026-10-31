import { describe, expect, it } from 'vitest'
import type { AwsAccount } from '../../../shared/types'
import type { ChangeAdapter, ChangeCtx } from './common'
import { ProposalEngine } from './engine'
import { deleteBucket, deleteDb, putBucketTagging, putBucketVersioning, rebootDb, setDesiredCapacity, startDb, stopDb, updateEcsService, updateLambdaConfig } from './services'
import { awsErr, AWS_ACCOUNT, fakeAws } from './testing'

const db = (patch: Record<string, unknown> = {}) => ({
  DBInstanceIdentifier: 'prod-db-1',
  DBInstanceStatus: 'available',
  Engine: 'postgres',
  EngineVersion: '16.3',
  DBInstanceClass: 'db.m6g.large',
  MultiAZ: true,
  DeletionProtection: false,
  BackupRetentionPeriod: 7,
  ReadReplicaDBInstanceIdentifiers: [],
  TagList: [{ Key: 'team', Value: 'core' }],
  ...patch
})

function world(over: Record<string, (p: any, region: string) => unknown> = {}) {
  const env: Record<string, string> = { DB_URL: 'postgres://user:hunter2@db/app', LOG_LEVEL: 'info' }
  const lambda = { FunctionName: 'api', MemorySize: 512, Timeout: 10, RevisionId: 'rev-1', LastUpdateStatus: 'Successful' }
  const bucketTags = { value: [{ Key: 'team', Value: 'core' }] as { Key: string; Value: string }[] | null }
  return {
    env,
    lambda,
    bucketTags,
    ...fakeAws({
      'rds:DescribeDBInstances': () => ({ DBInstances: [db()] }),
      'rds:DeleteDBInstance': () => ({ $metadata: { requestId: 'req-del' } }),
      'lambda:GetFunctionConfiguration': () => ({ ...lambda, Environment: { Variables: { ...env } } }),
      'lambda:UpdateFunctionConfiguration': () => ({ $metadata: { requestId: 'req-lambda' } }),
      's3:GetBucketLocation': (p) => ({ LocationConstraint: p.Bucket === 'eu-bucket' ? 'EU' : 'ap-northeast-1' }),
      's3:GetBucketTagging': () => {
        if (!bucketTags.value) throw awsErr('NoSuchTagSet')
        return { TagSet: bucketTags.value }
      },
      's3:PutBucketTagging': () => ({}),
      's3:DeleteBucketTagging': () => ({}),
      's3:GetBucketVersioning': () => ({}),
      's3:ListObjectsV2': () => ({ KeyCount: 0 }),
      's3:ListObjectVersions': () => ({ Versions: [], DeleteMarkers: [] }),
      'ecs:DescribeServices': () => ({ services: [{ serviceName: 'web', status: 'ACTIVE', desiredCount: 4, runningCount: 4, taskDefinition: 'arn:td:web:7', launchType: 'FARGATE' }] }),
      'autoscaling:DescribeAutoScalingGroups': () => ({ AutoScalingGroups: [{ AutoScalingGroupName: 'web-asg', MinSize: 0, MaxSize: 10, DesiredCapacity: 3, Instances: [{}, {}, {}], Tags: [{ Key: 'env', Value: 'production' }] }] }),
      ...over
    })
  }
}

async function planOf(a: ChangeAdapter, params: any, over?: Record<string, (p: any, region: string) => unknown>) {
  const w = world(over)
  const ctx: ChangeCtx = { region: 'ap-northeast-1', proposalId: 'p-0123456789ab', call: (s, act, p, r) => w.aws('acc-1', s, act, p, r ?? 'ap-northeast-1') as Promise<any> }
  const p = a.normalize ? a.normalize(structuredClone(params), ctx) : params
  const s = await a.snapshot(p, ctx)
  return { p, s, plan: a.plan(p, s), w, ctx }
}

describe('RDS adapters (golden)', () => {
  it('Stop / Start / Reboot: state diffs, risks, and state preconditions', async () => {
    const stop = await planOf(stopDb, { DBInstanceIdentifier: 'prod-db-1' })
    expect(stop.plan).toMatchObject({ title: '停止数据库 prod-db-1（postgres 16.3 · db.m6g.large）', risk: 'medium', confirmText: 'prod-db-1', blockers: [] })
    expect(stop.plan.change).toEqual({ kind: 'state', states: [{ name: 'prod-db-1（postgres 16.3 · db.m6g.large）', from: '可用', to: '已停止' }] })
    expect(stop.plan.consequences.map((c) => c.kind)).toEqual(['downtime', 'dependency', 'cost'])
    const aurora = await planOf(stopDb, { DBInstanceIdentifier: 'prod-db-1' }, { 'rds:DescribeDBInstances': () => ({ DBInstances: [db({ DBClusterIdentifier: 'c1' })] }) })
    expect(aurora.plan.blockers).toEqual(['prod-db-1 属于 Aurora 集群 c1，要停止整个集群（不支持）'])
    const start = await planOf(startDb, { DBInstanceIdentifier: 'prod-db-1' }, { 'rds:DescribeDBInstances': () => ({ DBInstances: [db({ DBInstanceStatus: 'stopped' })] }) })
    expect(start.plan).toMatchObject({ risk: 'low', blockers: [], change: { kind: 'state', states: [{ from: '已停止', to: '可用' }] } })
    expect(start.plan.consequences[0]).toEqual({ kind: 'cost', text: '开始收实例费：参考价约 $222/月（us-east-1，Multi-AZ 按两倍）', monthlyUsd: 221.92 })
    expect((await planOf(startDb, { DBInstanceIdentifier: 'prod-db-1' })).plan.blockers).toEqual(['prod-db-1 当前是 available，只能启动 stopped 的实例'])
    expect((await planOf(rebootDb, { DBInstanceIdentifier: 'prod-db-1', ForceFailover: true })).plan).toMatchObject({ risk: 'high', blockers: [], change: { kind: 'state', states: [{ from: '可用', to: '重启后可用' }] } })
    const single = await planOf(rebootDb, { DBInstanceIdentifier: 'prod-db-1', ForceFailover: true }, { 'rds:DescribeDBInstances': () => ({ DBInstances: [db({ MultiAZ: false })] }) })
    expect(single.plan.blockers).toEqual(['prod-db-1 不是 Multi-AZ，不能强制故障转移'])
  })

  it('DeleteDBInstance: destructive; final snapshot by default name, skip-final-snapshot and backups called out; protection refused', async () => {
    const keep = await planOf(deleteDb, { DBInstanceIdentifier: 'prod-db-1', SkipFinalSnapshot: false })
    expect(keep.p).toEqual({ DBInstanceIdentifier: 'prod-db-1', SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: 'prod-db-1-final-0123456789ab' })
    expect(keep.plan).toMatchObject({ risk: 'destructive', confirmText: 'prod-db-1', blockers: [] })
    expect(keep.plan.change).toEqual({
      kind: 'delete',
      removed: [
        { name: '数据库 prod-db-1', detail: 'postgres 16.3 · db.m6g.large · 可用' },
        { name: '自动备份', detail: '保留 7 天的时间点恢复' }
      ],
      kept: ['最终快照 prod-db-1-final-0123456789ab（删除前创建）', '已有的手动快照']
    })
    expect(keep.plan.reasons).toEqual(['删除数据库实例', '自动备份会一起删除'])
    const skip = await planOf(deleteDb, { DBInstanceIdentifier: 'prod-db-1', SkipFinalSnapshot: true, FinalDBSnapshotIdentifier: 'ignored', DeleteAutomatedBackups: false })
    expect(skip.p).toEqual({ DBInstanceIdentifier: 'prod-db-1', SkipFinalSnapshot: true, DeleteAutomatedBackups: false })
    expect(skip.plan.reasons).toEqual(['删除数据库实例', '跳过最终快照：删除后数据无法恢复'])
    expect(skip.plan.change).toMatchObject({ removed: [{ name: '数据库 prod-db-1' }], kept: ['自动备份（保留 7 天）', '已有的手动快照'] })
    expect(skip.plan.consequences.find((c) => c.kind === 'data')?.text).toContain('不保留最终快照')
    const prot = await planOf(deleteDb, { DBInstanceIdentifier: 'prod-db-1', SkipFinalSnapshot: false }, { 'rds:DescribeDBInstances': () => ({ DBInstances: [db({ DeletionProtection: true })] }) })
    expect(prot.plan.blockers).toEqual(['prod-db-1 开启了删除保护（DeletionProtection），请先在 Console 里关闭'])
  })
})

describe('Lambda UpdateFunctionConfiguration', () => {
  it('diffs memory / timeout / env: current values hidden, new values shown unless secret-named; snapshots keep no values', async () => {
    const { plan, s } = await planOf(updateLambdaConfig, { FunctionName: 'api', MemorySize: 1024, Timeout: 5, SetEnvironment: { LOG_LEVEL: 'debug', API_SECRET: 's3cr3t-value' }, RemoveEnvironment: ['DB_URL'] })
    expect(plan.change).toEqual({
      kind: 'modify',
      rows: [
        { item: '内存', before: '512 MB', after: '1024 MB' },
        { item: '超时', before: '10 秒', after: '5 秒' },
        { item: '环境变量 DB_URL', before: '[已隐藏]', after: '（删除）' },
        { item: '环境变量 LOG_LEVEL', before: '[已隐藏]', after: 'debug' },
        { item: '环境变量 API_SECRET', before: '无', after: '[已隐藏]（新值，12 字符）' }
      ]
    })
    expect(plan).toMatchObject({ risk: 'high', reasons: ['修改函数配置', '修改环境变量会改变函数代码的行为，请逐个核对新值'], blockers: [] })
    expect(plan.consequences.map((c) => c.kind)).toEqual(['downtime', 'cost', 'downtime', 'dependency'])
    const text = JSON.stringify({ plan, s })
    for (const secret of ['hunter2', 's3cr3t-value', 'info']) expect(text).not.toContain(secret)
    expect(updateLambdaConfig.redact!({ FunctionName: 'api', SetEnvironment: { K: 'v' } })).toEqual({ FunctionName: 'api', SetEnvironment: { K: '[redacted]' } })
    // Memory alone stays medium.
    expect((await planOf(updateLambdaConfig, { FunctionName: 'api', MemorySize: 1024 })).plan.risk).toBe('medium')
  })

  it('refuses variables that change what code the runtime loads or where traffic goes', async () => {
    for (const name of ['NODE_OPTIONS', 'AWS_LAMBDA_EXEC_WRAPPER', 'JAVA_TOOL_OPTIONS', 'PYTHONPATH', 'LD_PRELOAD', 'DOTNET_STARTUP_HOOKS', 'HTTPS_PROXY', 'https_proxy', 'PATH']) {
      const { plan } = await planOf(updateLambdaConfig, { FunctionName: 'api', SetEnvironment: { [name]: "--import=data:text/javascript,fetch('https://x')" } })
      expect(plan.blockers?.[0], name).toContain(`不允许设置 ${name}`)
    }
    expect((await planOf(updateLambdaConfig, { FunctionName: 'api', SetEnvironment: { FEATURE_FLAG: 'on' } })).plan.blockers).toEqual([])
  })

  it('executes by merging into the current variables with the RevisionId; a revision change refuses', async () => {
    const { p, s, w, ctx } = await planOf(updateLambdaConfig, { FunctionName: 'api', SetEnvironment: { LOG_LEVEL: 'debug' } })
    await updateLambdaConfig.execute!(p, s, ctx)
    expect(w.of('lambda', 'UpdateFunctionConfiguration')[0].params).toEqual({
      FunctionName: 'api',
      Environment: { Variables: { DB_URL: 'postgres://user:hunter2@db/app', LOG_LEVEL: 'debug' } },
      RevisionId: 'rev-1'
    })
    w.lambda.RevisionId = 'rev-2'
    await expect(updateLambdaConfig.execute!(p, s, ctx)).rejects.toThrow('被修改了')
    expect((await planOf(updateLambdaConfig, { FunctionName: 'api', MemorySize: 512 })).plan.blockers).toEqual(['没有变更（值和现在一样）'])
    expect((await planOf(updateLambdaConfig, { FunctionName: 'api', RemoveEnvironment: ['NOPE'] })).plan.blockers).toEqual(['没有变更（值和现在一样）', '要删除的环境变量不存在：NOPE'])
  })

  it('never writes an env value into the audit log or the proposal card (through the engine)', async () => {
    const w = world()
    const account: AwsAccount = { id: 'acc-1', kind: 'base', name: 'A', accountId: AWS_ACCOUNT, role: 'Admin', command: 'x', defaultRegion: 'us-east-1', color: '#000', aiAllowWrite: true }
    const audits: unknown[] = []
    const engine = new ProposalEngine({ aws: w.aws, account: () => account, audit: (...a) => audits.push(a), onState: () => {} })
    const { view } = await engine.propose(
      { accountId: 'acc-1', conversationId: 'c', region: 'ap-northeast-1' },
      { service: 'lambda', action: 'UpdateFunctionConfiguration', params: { FunctionName: 'api', SetEnvironment: { API_TOKEN: 'tok-very-secret-123' } } }
    )
    expect(JSON.stringify(audits)).not.toContain('tok-very-secret-123')
    expect(JSON.stringify(view)).not.toContain('tok-very-secret-123')
    expect(JSON.stringify(view)).not.toContain('hunter2')
    expect(w.writes()).toEqual([])
  })
})

describe('S3 bucket-level adapters', () => {
  it('resolves the bucket region and merges tags into the current set', async () => {
    expect(await putBucketTagging.locate!({ Bucket: 'eu-bucket' }, (async () => ({ LocationConstraint: 'EU' })) as never)).toBe('eu-west-1')
    expect(await putBucketTagging.locate!({ Bucket: 'b' }, (async () => ({})) as never)).toBe('us-east-1')
    const { plan, p, s, w, ctx } = await planOf(putBucketTagging, { Bucket: 'my-bucket', SetTags: { env: 'dev' }, RemoveTags: ['team'] })
    expect(plan).toMatchObject({ risk: 'low', confirmText: 'my-bucket', blockers: [] })
    expect(plan.change).toEqual({
      kind: 'modify',
      rows: [
        { item: '标签 team', before: 'core', after: '（删除）' },
        { item: '标签 env', before: '无', after: 'dev' }
      ]
    })
    await putBucketTagging.execute!(p, s, ctx)
    expect(w.of('s3', 'PutBucketTagging')[0].params).toEqual({ Bucket: 'my-bucket', Tagging: { TagSet: [{ Key: 'env', Value: 'dev' }] } })
    // Removing the last tag: PutBucketTagging can't send an empty set, so the tagging is deleted.
    const last = await planOf(putBucketTagging, { Bucket: 'my-bucket', RemoveTags: ['team'] })
    await putBucketTagging.execute!(last.p, last.s, last.ctx)
    expect(last.w.of('s3', 'DeleteBucketTagging')).toHaveLength(1)
    const none = await planOf(putBucketTagging, { Bucket: 'my-bucket', SetTags: { a: '1' } }, { 's3:GetBucketTagging': () => Promise.reject(awsErr('NoSuchTagSet')) })
    expect(none.plan.change).toEqual({ kind: 'modify', rows: [{ item: '标签 a', before: '无', after: '1' }] })
  })

  it('versioning: Enabled is low, Suspended is medium, no change is refused', async () => {
    const on = await planOf(putBucketVersioning, { Bucket: 'b-1', Status: 'Enabled' })
    expect(on.plan).toMatchObject({ risk: 'low', change: { kind: 'modify', rows: [{ item: '版本控制', before: '从未开启', after: '已开启' }] }, blockers: [] })
    expect(putBucketVersioning.request!(on.p, on.s)).toEqual({ Bucket: 'b-1', VersioningConfiguration: { Status: 'Enabled' } })
    const off = await planOf(putBucketVersioning, { Bucket: 'b-1', Status: 'Suspended' }, { 's3:GetBucketVersioning': () => ({ Status: 'Enabled' }) })
    expect(off.plan).toMatchObject({ risk: 'medium', blockers: [] })
    expect((await planOf(putBucketVersioning, { Bucket: 'b-1', Status: 'Enabled' }, { 's3:GetBucketVersioning': () => ({ Status: 'Enabled' }) })).plan.blockers).toEqual(['版本控制已经是 Enabled'])
  })

  it('DeleteBucket: only empty buckets, destructive', async () => {
    expect((await planOf(deleteBucket, { Bucket: 'b-1' })).plan).toMatchObject({
      risk: 'destructive',
      confirmText: 'b-1',
      blockers: [],
      change: { kind: 'delete', removed: [{ name: 'S3 桶 b-1', detail: '空桶' }], kept: [] }
    })
    const full = await planOf(deleteBucket, { Bucket: 'b-1' }, { 's3:ListObjectVersions': () => ({ Versions: [{}], DeleteMarkers: [] }) })
    expect(full.plan.blockers).toEqual(['桶不为空（还有对象或版本），助手只能删除空桶；请先在 Console 里清空'])
  })
})

describe('capacity adapters', () => {
  it('ECS desiredCount: increase low, decrease medium, zero high; running counts do not count as drift', async () => {
    const up = await planOf(updateEcsService, { cluster: 'main', service: 'web', desiredCount: 6 })
    expect(up.plan).toMatchObject({ risk: 'low', confirmText: 'web', change: { kind: 'modify', rows: [{ item: '期望任务数', before: '4 个', after: '6 个' }] }, blockers: [] })
    expect(updateEcsService.request!(up.p, up.s)).toEqual({ cluster: 'main', service: 'web', desiredCount: 6 })
    expect((await planOf(updateEcsService, { cluster: 'main', service: 'web', desiredCount: 2 })).plan.risk).toBe('medium')
    expect((await planOf(updateEcsService, { cluster: 'main', service: 'web', desiredCount: 0 })).plan).toMatchObject({ risk: 'high', reasons: ['缩容到 0：服务完全停止'] })
    expect((await planOf(updateEcsService, { cluster: 'main', service: 'web', desiredCount: 4 })).plan.blockers).toEqual(['期望任务数已经是 4'])
    expect(updateEcsService.drift!({ ...up.s, running: 1 })).toEqual(updateEcsService.drift!(up.s))
    expect(Object.keys(updateEcsService.forbiddenParams!)).toContain('taskDefinition')
  })

  it('ASG desired capacity: within min..max only; prod tag is reported for escalation', async () => {
    const down = await planOf(setDesiredCapacity, { AutoScalingGroupName: 'web-asg', DesiredCapacity: 1 })
    expect(down.plan).toMatchObject({ risk: 'medium', tags: [{ env: 'production' }], blockers: [], change: { kind: 'modify', rows: [{ item: '期望容量', before: '3 台', after: '1 台' }] } })
    expect(down.plan.consequences.map((c) => c.kind)).toEqual(['blast-radius', 'downtime', 'dependency'])
    expect((await planOf(setDesiredCapacity, { AutoScalingGroupName: 'web-asg', DesiredCapacity: 11 })).plan.blockers).toEqual(['期望容量必须在 0..10 之间（修改 min / max 不支持）'])
  })
})
