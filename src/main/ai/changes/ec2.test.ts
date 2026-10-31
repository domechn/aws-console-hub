import { describe, expect, it } from 'vitest'
import type { ChangeAdapter, ChangeCtx } from './common'
import {
  authorizeEgress,
  authorizeIngress,
  createTags,
  deleteTags,
  modifyInstanceAttribute,
  publicExposure,
  rebootInstances,
  revokeEgress,
  revokeIngress,
  ruleLines,
  runInstances,
  startInstances,
  stopInstances,
  terminateInstances
} from './ec2'
import { ec2World, fakeAws } from './testing'

const WEB = 'i-0aaaaaaaaaaaaaaa1'
const DB = 'i-0bbbbbbbbbbbbbbb2'
const SG = 'sg-0ccccccccccccccc1'

async function planOf(a: ChangeAdapter, params: any, tweak?: (w: ReturnType<typeof ec2World>) => void) {
  const world = ec2World()
  tweak?.(world)
  const fake = fakeAws(world.handlers)
  const ctx: ChangeCtx = { region: 'ap-northeast-1', proposalId: 'p-0123456789ab', call: (s, act, p, r) => fake.aws('acc-1', s, act, p, r ?? 'ap-northeast-1') as Promise<any> }
  const p = a.normalize ? a.normalize(structuredClone(params), ctx) : params
  const s = await a.snapshot(p, ctx)
  return { p, s, plan: a.plan(p, s), fake, world }
}
const kinds = (plan: { consequences: { kind: string }[] }) => plan.consequences.map((c) => c.kind)

describe('EC2 adapters (golden)', () => {
  it('StartInstances: stopped → running, low, cost; refuses running ones', async () => {
    const { plan, fake } = await planOf(startInstances, { InstanceIds: [DB, DB] })
    expect(plan).toMatchObject({ title: '启动 1 台 EC2 实例', targets: [DB], confirmText: DB, risk: 'low', blockers: [] })
    expect(plan.change).toEqual({ kind: 'state', states: [{ name: `db-2（${DB}）`, from: '已停止', to: '运行中' }] })
    expect(plan.consequences[0]).toEqual({ kind: 'cost', text: '开始按小时计费：按需参考价约 $70.08/月（us-east-1 Linux，不含 EBS）', monthlyUsd: 70.08 })
    expect(plan.tags).toEqual([{ Name: 'db-2', env: 'prod' }])
    expect(fake.writes()).toEqual([])
    expect((await planOf(startInstances, { InstanceIds: [WEB] })).plan.blockers).toEqual([`web-1（${WEB}） 当前是 running，只能启动 stopped 的实例`])
  })

  it('StopInstances: running → stopped, medium, downtime, released public IP, instance store', async () => {
    const { plan } = await planOf(stopInstances, { InstanceIds: [WEB] })
    expect(plan).toMatchObject({ title: '停止 1 台 EC2 实例', risk: 'medium', blockers: [] })
    expect(plan.change).toEqual({ kind: 'state', states: [{ name: `web-1（${WEB}）`, from: '运行中', to: '已停止' }] })
    expect(kinds(plan)).toEqual(['downtime', 'dependency', 'data', 'cost'])
    expect(plan.consequences[1].text).toContain('公网 IP 3.3.3.3 会释放')
  })

  it('StopInstances: an EIP keeps its address; Force and ASG membership are high risk; instance-store roots are refused', async () => {
    const eip = await planOf(stopInstances, { InstanceIds: [WEB] }, (w) => w.eips.push({ PublicIp: '3.3.3.3', InstanceId: WEB }))
    expect(eip.plan.consequences.some((c) => c.text.includes('3.3.3.3'))).toBe(false)
    expect((await planOf(stopInstances, { InstanceIds: [WEB], Force: true })).plan).toMatchObject({ risk: 'high', reasons: expect.arrayContaining([expect.stringContaining('强制停止')]) })
    const asg = await planOf(stopInstances, { InstanceIds: [WEB] }, (w) => w.instances[WEB].Tags.push({ Key: 'aws:autoscaling:groupName', Value: 'web-asg' }))
    expect(asg.plan.risk).toBe('high')
    expect(asg.plan.consequences.at(-1)).toEqual({ kind: 'blast-radius', text: 'Auto Scaling 组 web-asg 可能会启动替换实例' })
    const store = await planOf(stopInstances, { InstanceIds: [WEB] }, (w) => (w.instances[WEB].RootDeviceType = 'instance-store'))
    expect(store.plan.blockers).toEqual([`${WEB} 的根卷是 instance store，不能停止（只能终止）`])
  })

  it('RebootInstances: medium, short downtime', async () => {
    const { plan } = await planOf(rebootInstances, { InstanceIds: [WEB] })
    expect(plan).toMatchObject({ risk: 'medium', change: { kind: 'state', states: [{ from: '运行中', to: '重启后运行中' }] }, blockers: [] })
    expect(kinds(plan)).toEqual(['downtime'])
  })

  it('TerminateInstances: destructive, lists volumes deleted and kept, EIPs, and refuses protected instances', async () => {
    const { plan } = await planOf(terminateInstances, { InstanceIds: [DB, WEB] }, (w) => w.eips.push({ PublicIp: '5.5.5.5', InstanceId: DB }))
    expect(plan).toMatchObject({ title: '终止 2 台 EC2 实例', risk: 'destructive', confirmText: '终止 2 台实例', targets: [WEB, DB], blockers: [] })
    expect(plan.change).toEqual({
      kind: 'delete',
      removed: [
        { name: `web-1（${WEB}）`, detail: 't3.large · 运行中' },
        { name: `db-2（${DB}）`, detail: 'm5.large · 已停止' },
        { name: '卷 vol-0aaaaaaaaaaaaaaa1', detail: `/dev/xvda，${WEB}` },
        { name: '卷 vol-0bbbbbbbbbbbbbbb1', detail: `/dev/xvda，${DB}` }
      ],
      kept: [`卷 vol-0bbbbbbbbbbbbbbb2（/dev/sdf，${DB}）`, 'EIP 5.5.5.5']
    })
    expect(plan.consequences.map((c) => c.text)).toEqual([
      '实例终止后无法恢复，instance store 数据一并丢失',
      `卷 vol-0aaaaaaaaaaaaaaa1（/dev/xvda，${WEB}）会一起删除（DeleteOnTermination）`,
      `卷 vol-0bbbbbbbbbbbbbbb1（/dev/xvda，${DB}）会一起删除（DeleteOnTermination）`,
      `卷 vol-0bbbbbbbbbbbbbbb2（/dev/sdf，${DB}）会保留并继续计费`,
      'EIP 5.5.5.5 会解除关联但仍保留，未关联时按小时计费'
    ])
    const prot = await planOf(terminateInstances, { InstanceIds: [WEB] }, (w) => w.protectedIds.add(WEB))
    expect(prot.plan.blockers).toEqual([`${WEB} 开启了终止保护（DisableApiTermination），请先在 Console 里关闭`])
  })

  it('ModifyInstanceAttribute: instance type only, needs a stopped instance, cost before → after', async () => {
    const { plan, p } = await planOf(modifyInstanceAttribute, { InstanceId: DB, InstanceType: 'm5.xlarge' })
    expect(plan).toMatchObject({ risk: 'medium', confirmText: DB, blockers: [] })
    expect(plan.change).toEqual({ kind: 'modify', rows: [{ item: '实例类型', before: 'm5.large', after: 'm5.xlarge' }] })
    expect(plan.consequences[0]).toMatchObject({ kind: 'cost', text: '按需参考价 $70.08/月 → $140/月（us-east-1 Linux）', monthlyUsd: 140.16 })
    expect(modifyInstanceAttribute.request!(p, {} as never)).toEqual({ InstanceId: DB, InstanceType: { Value: 'm5.xlarge' } })
    expect((await planOf(modifyInstanceAttribute, { InstanceId: WEB, InstanceType: 'm5.xlarge' })).plan.blockers).toEqual([`修改实例类型需要先停止实例（${WEB} 当前是 running）`])
    expect((await planOf(modifyInstanceAttribute, { InstanceId: DB, InstanceType: 'm5.large' })).plan.blockers).toEqual([`${DB} 已经是 m5.large`])
    expect(Object.keys(modifyInstanceAttribute.forbiddenParams!)).toContain('UserData')
  })

  it('CreateTags / DeleteTags: tag-set diffs, low risk, nothing to do is refused', async () => {
    const set = await planOf(createTags, { Resources: [WEB], Tags: [{ Key: 'team', Value: 'core' }, { Key: 'Name', Value: 'web-01' }] })
    expect(set.plan).toMatchObject({ risk: 'low', blockers: [] })
    expect(set.plan.change).toEqual({
      kind: 'modify',
      rows: [
        { item: '标签 Name', before: 'web-1', after: 'web-01' },
        { item: '标签 team', before: '无', after: 'core' }
      ]
    })
    // Several resources: each row says which one.
    const two = await planOf(createTags, { Resources: [WEB, DB], Tags: [{ Key: 'team', Value: 'core' }] })
    expect(two.plan.change.rows).toEqual([
      { target: WEB, item: '标签 team', before: '无', after: 'core' },
      { target: DB, item: '标签 team', before: '无', after: 'core' }
    ])
    expect((await planOf(createTags, { Resources: [WEB], Tags: [{ Key: 'Name', Value: 'web-1' }] })).plan.blockers).toEqual(['这些标签已经是这些值，没有变更'])
    const del = await planOf(deleteTags, { Resources: [DB], Tags: [{ Key: 'env', Value: 'prod' }, { Key: 'missing' }] })
    expect(del.plan.change).toEqual({ kind: 'modify', rows: [{ item: '标签 env', before: 'prod', after: '（删除）' }] })
    expect(del.plan.tags).toEqual([{ Name: 'db-2', env: 'prod' }])
    expect((await planOf(deleteTags, { Resources: [DB], Tags: [{ Key: 'env', Value: 'dev' }] })).plan.blockers).toEqual(['这些资源上没有要删除的标签'])
  })

  it('security group rules: public sensitive ports are high, existing / missing rules are refused, ENIs are the blast radius', async () => {
    const ssh = await planOf(authorizeIngress, { GroupId: SG, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] })
    expect(ssh.plan).toMatchObject({ risk: 'high', confirmText: SG, blockers: [] })
    expect(ssh.plan.reasons).toContain('对公网（0.0.0.0/0、::/0 或其他超大网段）开放敏感端口：22（SSH）')
    expect(ssh.plan.change).toEqual({ kind: 'modify', rows: [{ item: '入站规则', before: '无', after: 'TCP 22 · 来源 0.0.0.0/0' }] })
    expect(ssh.plan.consequences[0].text).toBe('规则立即对使用这个安全组的 3 个网卡（实例、负载均衡、RDS 等）生效')
    const range = await planOf(authorizeIngress, { GroupId: SG, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 3000, ToPort: 3400, Ipv6Ranges: [{ CidrIpv6: '::/0' }] }] })
    expect(range.plan.reasons).toContain('对公网（0.0.0.0/0、::/0 或其他超大网段）开放敏感端口：3306（MySQL）、3389（RDP）')
    const web = await planOf(authorizeIngress, { GroupId: SG, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] })
    expect(web.plan.risk).toBe('medium')
    const internal = await planOf(authorizeIngress, { GroupId: SG, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: '10.0.0.0/16' }] }] })
    expect(internal.plan.risk).toBe('low')
    const dup = await planOf(authorizeIngress, { GroupId: SG, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] })
    expect(dup.plan.blockers).toEqual(['规则已存在：tcp 443 0.0.0.0/0'])
    const revoke = await planOf(revokeIngress, { GroupId: SG, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] })
    expect(revoke.plan).toMatchObject({ risk: 'medium', change: { kind: 'modify', rows: [{ item: '入站规则', before: 'TCP 443 · 来源 0.0.0.0/0', after: '（删除）' }] }, blockers: [] })
    expect(kinds(revoke.plan)).toEqual(['blast-radius', 'downtime'])
    const out = await planOf(authorizeEgress, { GroupId: SG, IpPermissions: [{ IpProtocol: 'udp', FromPort: 53, ToPort: 53, IpRanges: [{ CidrIp: '10.0.0.2/32' }] }] })
    expect(out.plan.change).toEqual({ kind: 'modify', rows: [{ item: '出站规则', before: '无', after: 'UDP 53 · 目标 10.0.0.2/32' }] })
    const outAll = await planOf(revokeEgress, { GroupId: SG, IpPermissions: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] })
    expect(outAll.plan.change).toEqual({ kind: 'modify', rows: [{ item: '出站规则', before: '全部协议 全部端口 · 目标 0.0.0.0/0', after: '（删除）' }] })
    expect((await planOf(revokeIngress, { GroupId: SG, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '1.2.3.4/32' }] }] })).plan.blockers).toEqual(['规则不存在：tcp 22 1.2.3.4/32'])
  })

  it('rule helpers: one line per source, all-protocol rules are public on every port', () => {
    expect(ruleLines([{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }], UserIdGroupPairs: [{ GroupId: SG }] }])).toEqual(['all 全部端口 0.0.0.0/0', `all 全部端口 ${SG}`])
    expect(publicExposure([{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }]).sensitive).toEqual(['全部协议和端口'])
    expect(publicExposure([{ IpProtocol: 'udp', FromPort: 53, ToPort: 53, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }])).toEqual({ publicRules: ['udp 53'], sensitive: [] })
    // Other spellings of "everyone" and wide halves are public too; private and narrow ranges are not.
    const ssh = (cidrs: string[]) => publicExposure([{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: cidrs.filter((c) => !c.includes(':')).map((CidrIp) => ({ CidrIp })), Ipv6Ranges: cidrs.filter((c) => c.includes(':')).map((CidrIpv6) => ({ CidrIpv6 })) }]).sensitive
    for (const c of ['0.0.0.0/1', '128.0.0.0/1', '11.0.0.0/8', '0::/0', '2000::/3', '::/0']) expect(ssh([c]), c).toEqual(['22（SSH）'])
    for (const c of ['10.0.0.0/8', '172.16.0.0/12', '1.2.3.4/32', 'fd00::/8', '2001:db8::/32']) expect(ssh([c]), c).toEqual([])
  })

  it('RunInstances: resolved AMI / type / subnet, ClientToken from the proposal, cost; many or pricey is high', async () => {
    const { plan, p } = await planOf(runInstances, {
      ImageId: 'ami-0ddddddddddddddd1',
      InstanceType: 't3.micro',
      SubnetId: 'subnet-0fffffffffffffff1',
      KeyName: 'me',
      Tags: [{ Key: 'Name', Value: 'tmp-1' }]
    })
    expect(p).toMatchObject({ Count: 1, ClientToken: 'p-0123456789ab' })
    expect(plan).toMatchObject({ title: '创建 1 台 EC2 实例（t3.micro · tmp-1）', risk: 'medium', confirmText: 'tmp-1', blockers: [] })
    expect(plan.change).toEqual({
      kind: 'create',
      summary: '创建 1 台 t3.micro',
      fields: [
        { label: '实例类型', value: 't3.micro（2 vCPU · 8 GiB 内存）' },
        { label: '数量', value: '1 台' },
        { label: '镜像（AMI）', value: 'ami-0ddddddddddddddd1 · al2023 · x86_64 · Linux/UNIX' },
        { label: '子网', value: 'subnet-0fffffffffffffff1（ap-northeast-1a · vpc-1）' },
        { label: '安全组', value: 'VPC 默认安全组' },
        { label: '密钥对', value: 'me' },
        { label: '标签', value: 'Name=tmp-1' },
        { label: '预估月费', value: '约 $7.59/月', note: '按需参考价，us-east-1 Linux，不含 EBS 和流量' }
      ]
    })
    expect(plan.consequences.map((c) => c.kind)).toEqual(['cost', 'dependency'])
    expect(runInstances.request!(p, {} as never)).toEqual({
      ImageId: 'ami-0ddddddddddddddd1',
      InstanceType: 't3.micro',
      MinCount: 1,
      MaxCount: 1,
      SubnetId: 'subnet-0fffffffffffffff1',
      KeyName: 'me',
      TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: 'tmp-1' }] }],
      ClientToken: 'p-0123456789ab'
    })
    expect((await planOf(runInstances, { ImageId: 'ami-0ddddddddddddddd1', InstanceType: 't3.micro', Count: 4 })).plan.risk).toBe('high')
    expect((await planOf(runInstances, { ImageId: 'ami-0ddddddddddddddd1', InstanceType: 'p3.2xlarge' })).plan).toMatchObject({ risk: 'high', reasons: expect.arrayContaining(['单价高：约 $3.06/小时']) })
    const unknown = (await planOf(runInstances, { ImageId: 'ami-0ddddddddddddddd1', InstanceType: 'x9.huge' })).plan
    expect(unknown.risk).toBe('high')
    expect(unknown.change.fields?.at(-1)).toEqual({ label: '预估月费', value: '未知（实例类型不在参考价表里）' })
    await expect(planOf(runInstances, { ImageId: 'ami-0999999999999999a', InstanceType: 't3.micro' })).rejects.toThrow('找不到 AMI')
  })
})
