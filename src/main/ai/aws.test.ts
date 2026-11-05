import { describe, expect, it } from 'vitest'
import { AWS_SERVICES, AwsClients, SDK, usesAwsCli } from './aws'

describe('AWS client registry', () => {
  it('uses bundled schemas and SDK routing for every exported command', async () => {
    const clients = new AwsClients(async () => { throw new Error('no credentials') })
    for (const service of AWS_SERVICES) {
      const mod = await SDK[service].load()
      for (const key of Object.keys(mod).filter((name) => /^[A-Z][A-Za-z0-9]+Command$/.test(name) && typeof mod[name] === 'function')) {
        const action = key.slice(0, -'Command'.length)
        const members = await clients.inputMembers(service, action)
        expect(members, `${service}:${action}`).not.toBeNull()
        expect(await usesAwsCli(service, action, {}), `${service}:${action}`).toBe(false)
        if (members?.length) expect(await usesAwsCli(service, action, { [members[0]]: 'test' }), `${service}:${action}`).toBe(false)
      }
    }
    for (const [service, action, params] of [
      ['dynamodb', 'DescribeTable', { TableName: 't' }],
      ['rds', 'StopDBInstance', { DBInstanceIdentifier: 'db' }],
      ['cloudformation', 'DescribeStacks', { StackName: 's' }],
      ['states', 'ListStateMachines', { maxResults: 1 }],
      ['kinesis', 'ListStreams', { Limit: 1 }]
    ] as const) expect(await usesAwsCli(service, action, params)).toBe(false)
  }, 60_000)
  it('every service loads its pinned package and exports the client it names', async () => {
    for (const service of AWS_SERVICES) {
      const mod = await SDK[service].load()
      expect(typeof mod[SDK[service].client], service).toBe('function')
    }
  }, 60_000)

  it('supports any well-formed service and command without touching credentials', async () => {
    const clients = new AwsClients(async () => {
      throw new Error('credentials must not be asked for')
    })
    expect(await clients.supports('sqs', 'ListQueues')).toBeNull()
    expect(await clients.supports('elasticloadbalancing', 'DescribeLoadBalancers')).toBeNull()
    expect(await clients.supports('made-up', 'ListThings')).toBeNull()
    expect(await clients.supports('constructor', 'X')).toContain('无效')
    expect(await clients.supports('sqs', 'NoSuchThing')).toBeNull()
    // From the SDK's input schema: ReleaseHosts has no DryRun member (a "DryRun" would really release the hosts).
    expect(await clients.inputMembers('ec2', 'ReleaseHosts')).toEqual(['HostIds'])
    expect(await clients.inputMembers('ec2', 'DeleteVpc')).toContain('DryRun')
    expect(await clients.inputMembers('ec2', 'NoSuchThing')).toBeNull()
    expect(await clients.inputMembers('made-up', 'X')).toBeNull()
  })
  it('keeps nested params on SDK, refuses unknown top-level params, and leaves budgets on CLI', async () => {
    const clients = new AwsClients(async () => { throw new Error('credentials should not load') }, () => '/missing/aws')
    expect(await usesAwsCli('ec2', 'CreateVpc', { TagSpecifications: [{ ResourceType: 'vpc' }] })).toBe(false)
    expect(await usesAwsCli('sns', 'Publish', { Typo: true })).toBe(false)
    await expect(clients.call('a', 'sns', 'Publish', { Typo: true }, 'us-east-1')).rejects.toThrow(/未知参数 Typo；可用：.*Message/)
    expect(await usesAwsCli('budgets', 'CreateBudget')).toBe(true)
  })
  it('refuses a CLI-equivalent casing of a bundled command before loading credentials', async () => {
    const clients = new AwsClients(async () => { throw new Error('credentials loaded') }, () => '/missing/aws')
    await expect(usesAwsCli('ec2', 'ModifyVPCAttribute')).rejects.toThrow('请使用 ModifyVpcAttribute')
    expect(await clients.supports('ec2', 'ModifyVPCAttribute')).toContain('请使用 ModifyVpcAttribute')
    await expect(clients.call('a', 'ec2', 'ModifyVPCAttribute', { VpcId: 'vpc-1' }, 'us-east-1')).rejects.toThrow('请使用 ModifyVpcAttribute')
  })
})
