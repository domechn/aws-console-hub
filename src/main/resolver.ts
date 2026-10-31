import { EC2Client, DescribeTagsCommand, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2'
import type { AwsCredentials } from './credentialCommand'
import type { RecentResource } from '../shared/types'

/**
 * Best-effort resolution of opaque resource ids into human-readable names.
 *
 * The URL parser can only extract what the console puts in the URL, which for
 * EC2 resources is an id like i-0abc… — meaningless in the recents list. One
 * ec2:DescribeTags call covers Name tags for every EC2 resource type; security
 * groups get ec2:DescribeSecurityGroups instead, since their readable name is
 * the GroupName rather than a tag. Failures (missing permission, no Name tag,
 * deleted resource) just mean the id keeps being shown.
 */

const EC2_ID_RE = /^(i|vol|snap|sg|eni|subnet|vpc|igw|nat|rtb|eipalloc|ami)-[0-9a-f]{8,17}$/
const SG_ID_RE = /^sg-[0-9a-f]{8,17}$/

/** Whether this resource's name is an opaque id worth resolving. */
export function needsDisplayName(r: RecentResource): boolean {
  return !r.displayName && r.service === 'ec2' && EC2_ID_RE.test(r.name)
}

export async function resolveDisplayName(
  creds: AwsCredentials,
  r: RecentResource
): Promise<string | null> {
  if (!needsDisplayName(r)) return null

  const ec2 = new EC2Client({
    region: r.region === 'global' ? 'us-east-1' : r.region,
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken
    }
  })
  // A security group's readable name is usually its GroupName, not a Name tag,
  // and one call returns both.
  if (SG_ID_RE.test(r.name)) {
    const groups = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [r.name] }))
    const sg = groups.SecurityGroups?.[0]
    const tag = sg?.Tags?.find((t) => t.Key === 'Name')?.Value?.trim()
    return tag || sg?.GroupName?.trim() || null
  }

  const result = await ec2.send(
    new DescribeTagsCommand({
      Filters: [
        { Name: 'resource-id', Values: [r.name] },
        { Name: 'key', Values: ['Name'] }
      ]
    })
  )
  const value = result.Tags?.[0]?.Value?.trim()
  return value || null
}
