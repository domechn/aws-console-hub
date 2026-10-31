/**
 * Test support (imported by *.test.ts only): a scriptable fake of the AWS call the engine uses, which records every
 * call and says which ones were writes. EC2-style DryRun requests answer DryRunOperation unless a test says otherwise.
 */
import { classifyAction } from '../classify'

export const AWS_ACCOUNT = '123456789012'

export interface FakeCall {
  accountId: string
  service: string
  action: string
  params: Record<string, any>
  region: string
}

type Handler = (params: Record<string, any>, region: string) => unknown

export const awsErr = (name: string, message = name): Error => Object.assign(new Error(message), { name })

/** A write is anything that is not a read, a DryRun, the caller-identity check, or a change-set plan call. */
export const isWrite = (c: FakeCall): boolean =>
  c.params.DryRun !== true &&
  classifyAction(c.service, c.action).class !== 'read' &&
  !['ec2:DescribeInstanceAttribute', 'tag:GetResources', 'iam:SimulatePrincipalPolicy', 'cloudformation:CreateChangeSet', 'cloudformation:DeleteChangeSet'].includes(`${c.service}:${c.action}`)

export function fakeAws(handlers: Record<string, Handler>) {
  const calls: FakeCall[] = []
  const aws = async (accountId: string, service: string, action: string, params: Record<string, unknown>, region: string): Promise<unknown> => {
    // A copy: what was sent, even if the caller mutates its object later.
    const c: FakeCall = { accountId, service, action, params: structuredClone(params) as Record<string, any>, region }
    calls.push(c)
    const key = `${service}:${action}`
    if (c.params.DryRun === true) {
      const h = handlers[`${key}#dryrun`]
      if (h) return h(c.params, region)
      throw awsErr('DryRunOperation', 'Request would have succeeded, but DryRun flag is set.')
    }
    const h = handlers[key]
    if (h) return h(c.params, region)
    if (key === 'sts:GetCallerIdentity') return { Account: AWS_ACCOUNT, Arn: `arn:aws:sts::${AWS_ACCOUNT}:assumed-role/Admin/me` }
    throw awsErr('NotFaked', `no fake for ${key}`)
  }
  return {
    aws,
    calls,
    writes: () => calls.filter(isWrite),
    of: (service: string, action: string) => calls.filter((c) => c.service === service && c.action === action)
  }
}

/** A small EC2 world: instances by id, their attributes, EIPs, tags, one security group. Mutable, like AWS. */
export function ec2World() {
  const instances: Record<string, any> = {
    'i-0aaaaaaaaaaaaaaa1': {
      InstanceId: 'i-0aaaaaaaaaaaaaaa1',
      State: { Name: 'running' },
      InstanceType: 't3.large',
      RootDeviceType: 'ebs',
      PublicIpAddress: '3.3.3.3',
      Tags: [{ Key: 'Name', Value: 'web-1' }],
      BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeId: 'vol-0aaaaaaaaaaaaaaa1', DeleteOnTermination: true } }]
    },
    'i-0bbbbbbbbbbbbbbb2': {
      InstanceId: 'i-0bbbbbbbbbbbbbbb2',
      State: { Name: 'stopped' },
      InstanceType: 'm5.large',
      RootDeviceType: 'ebs',
      Tags: [
        { Key: 'Name', Value: 'db-2' },
        { Key: 'env', Value: 'prod' }
      ],
      BlockDeviceMappings: [
        { DeviceName: '/dev/xvda', Ebs: { VolumeId: 'vol-0bbbbbbbbbbbbbbb1', DeleteOnTermination: true } },
        { DeviceName: '/dev/sdf', Ebs: { VolumeId: 'vol-0bbbbbbbbbbbbbbb2', DeleteOnTermination: false } }
      ]
    }
  }
  const protectedIds = new Set<string>()
  const eips: { PublicIp: string; InstanceId: string }[] = []
  const groups: Record<string, any> = {
    'sg-0ccccccccccccccc1': {
      GroupId: 'sg-0ccccccccccccccc1',
      GroupName: 'web',
      VpcId: 'vpc-1',
      IpPermissions: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }],
      IpPermissionsEgress: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }],
      Tags: []
    }
  }
  const tags = (): { ResourceId: string; Key: string; Value: string }[] =>
    Object.values(instances).flatMap((i) => (i.Tags ?? []).map((t: any) => ({ ResourceId: i.InstanceId, Key: t.Key, Value: t.Value })))
  const handlers: Record<string, Handler> = {
    'ec2:DescribeInstances': (p) => ({ Reservations: [{ Instances: (p.InstanceIds ?? Object.keys(instances)).map((id: string) => instances[id]).filter(Boolean) }] }),
    'ec2:DescribeAddresses': (p) => ({ Addresses: eips.filter((e) => p.Filters[0].Values.includes(e.InstanceId)) }),
    'ec2:DescribeInstanceAttribute': (p) => ({ DisableApiTermination: { Value: protectedIds.has(p.InstanceId) } }),
    'ec2:DescribeTags': (p) => ({ Tags: tags().filter((t) => p.Filters[0].Values.includes(t.ResourceId)) }),
    'ec2:DescribeSecurityGroups': (p) => ({ SecurityGroups: p.GroupIds.map((id: string) => groups[id]).filter(Boolean) }),
    'ec2:DescribeNetworkInterfaces': () => ({ NetworkInterfaces: [{}, {}, {}] }),
    'ec2:StartInstances': (p) => {
      for (const id of p.InstanceIds) instances[id].State = { Name: 'pending' }
      return { $metadata: { requestId: 'req-start' } }
    },
    'ec2:StopInstances': (p) => {
      for (const id of p.InstanceIds) instances[id].State = { Name: 'stopping' }
      return { $metadata: { requestId: 'req-stop' } }
    },
    'ec2:RebootInstances': () => ({ $metadata: { requestId: 'req-reboot' } }),
    'ec2:TerminateInstances': (p) => {
      for (const id of p.InstanceIds) instances[id].State = { Name: 'shutting-down' }
      return { $metadata: { requestId: 'req-terminate' } }
    },
    'ec2:ModifyInstanceAttribute': (p) => {
      instances[p.InstanceId].InstanceType = p.InstanceType.Value
      return { $metadata: { requestId: 'req-modify' } }
    },
    'ec2:CreateTags': () => ({ $metadata: { requestId: 'req-tags' } }),
    'ec2:DeleteTags': () => ({ $metadata: { requestId: 'req-untag' } }),
    'ec2:AuthorizeSecurityGroupIngress': () => ({ $metadata: { requestId: 'req-auth' } }),
    'ec2:RevokeSecurityGroupIngress': () => ({ $metadata: { requestId: 'req-revoke' } }),
    'ec2:DescribeImages': (p) => ({
      Images: p.ImageIds[0] === 'ami-0ddddddddddddddd1' ? [{ ImageId: 'ami-0ddddddddddddddd1', Name: 'al2023', State: 'available', OwnerId: '137112412989', ImageOwnerAlias: 'amazon', Architecture: 'x86_64', PlatformDetails: 'Linux/UNIX', Public: true }] : []
    }),
    'ec2:DescribeSubnets': (p) => ({ Subnets: [{ SubnetId: p.SubnetIds[0], AvailabilityZone: 'ap-northeast-1a', VpcId: 'vpc-1', MapPublicIpOnLaunch: false }] }),
    'ec2:DescribeInstanceTypes': (p) => ({ InstanceTypes: [{ InstanceType: p.InstanceTypes[0], VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 8192 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } }] }),
    'ec2:DescribeKeyPairs': () => ({ KeyPairs: [{ KeyName: 'me' }] }),
    'ec2:RunInstances': (p) => ({ $metadata: { requestId: 'req-run' }, Instances: [{ InstanceId: 'i-0eeeeeeeeeeeeeee1', State: { Name: 'pending' } }], echo: p })
  }
  return { instances, protectedIds, eips, groups, handlers }
}
