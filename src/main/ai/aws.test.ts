import { describe, expect, it } from 'vitest'
import { AWS_SERVICES, AwsClients, SDK } from './aws'

describe('AWS client registry', () => {
  it('every service loads its pinned package and exports the client it names', async () => {
    for (const service of AWS_SERVICES) {
      const mod = await SDK[service].load()
      expect(typeof mod[SDK[service].client], service).toBe('function')
    }
  }, 60_000)

  it('supports: unknown services and commands are named before any card or call; never touches credentials', async () => {
    const clients = new AwsClients(async () => {
      throw new Error('credentials must not be asked for')
    })
    expect(await clients.supports('sqs', 'ListQueues')).toBeNull()
    expect(await clients.supports('elasticloadbalancing', 'DescribeLoadBalancers')).toBeNull()
    expect(await clients.supports('made-up', 'ListThings')).toContain('暂不支持执行 made-up')
    expect(await clients.supports('constructor', 'X')).toContain('暂不支持执行')
    expect(await clients.supports('sqs', 'NoSuchThing')).toBe('sqs 没有 NoSuchThing 这个操作')
    await expect(clients.call('acc', 'made-up', 'ListThings', {}, 'us-east-1')).rejects.toThrow('暂不支持执行 made-up')
    // From the SDK's input schema: ReleaseHosts has no DryRun member (a "DryRun" would really release the hosts).
    expect(await clients.inputMembers('ec2', 'ReleaseHosts')).toEqual(['HostIds'])
    expect(await clients.inputMembers('ec2', 'DeleteVpc')).toContain('DryRun')
    expect(await clients.inputMembers('ec2', 'NoSuchThing')).toBeNull()
    expect(await clients.inputMembers('made-up', 'X')).toBeNull()
  })
})
