import { describe, expect, it } from 'vitest'
import { parseConsolePage, parseConsoleUrl } from './parser'

const pick = (url: string) => {
  const r = parseConsoleUrl(url)
  return r && { service: r.service, region: r.region, resourceType: r.resourceType, name: r.name }
}

describe('parseConsoleUrl', () => {
  it('ignores non-console and unparseable URLs', () => {
    expect(parseConsoleUrl('https://evil.example.com/s3/buckets/x')).toBeNull()
    expect(parseConsoleUrl('https://console.aws.amazon.com.evil.com/s3/buckets/x')).toBeNull()
    expect(parseConsoleUrl('not a url')).toBeNull()
    expect(parseConsoleUrl('https://us-east-1.console.aws.amazon.com/console/home')).toBeNull()
  })

  it('takes the region from the query, then the host, else global', () => {
    expect(pick('https://s3.console.aws.amazon.com/s3/buckets/my-bucket?region=eu-west-1')).toEqual({
      service: 's3',
      region: 'eu-west-1',
      resourceType: 'Bucket',
      name: 'my-bucket'
    })
    expect(pick('https://ap-southeast-2.console.aws.amazon.com/lambda/home#/functions/fn%20a')?.region).toBe(
      'ap-southeast-2'
    )
    expect(pick('https://console.aws.amazon.com/iam/home#/roles/details/Admin')).toEqual({
      service: 'iam',
      region: 'global',
      resourceType: 'Role',
      name: 'Admin'
    })
  })

  it('decodes names', () => {
    expect(pick('https://us-east-1.console.aws.amazon.com/lambda/home#/functions/fn%20a')?.name).toBe('fn a')
    expect(
      pick(
        'https://us-east-1.console.aws.amazon.com/cloudwatch/home#logsV2:log-groups/log-group/$252Faws$252Flambda$252Ffn'
      )?.name
    ).toBe('/aws/lambda/fn')
  })

  it('dedupes security groups across the EC2 and VPC consoles', () => {
    const ec2 = pick('https://us-east-1.console.aws.amazon.com/ec2/home#SecurityGroup:groupId=sg-0123456789abcdef0')
    const vpc = pick('https://us-east-1.console.aws.amazon.com/vpcconsole/home#SecurityGroups:sg-0123456789abcdef0')
    expect(ec2).toEqual({ service: 'ec2', region: 'us-east-1', resourceType: 'Security group', name: 'sg-0123456789abcdef0' })
    expect(vpc).toEqual(ec2)
  })

  it('pulls MSK and OpenSearch names out of encoded ARNs', () => {
    const arn = encodeURIComponent('arn:aws:kafka:us-east-1:123456789012:cluster/my-cluster/abc-123')
    expect(pick(`https://us-east-1.console.aws.amazon.com/msk/home#/cluster/${arn}/view`)?.name).toBe('my-cluster')
    expect(pick('https://us-east-1.console.aws.amazon.com/aos/home#opensearch/domains/search-logs')?.name).toBe(
      'search-logs'
    )
  })

  it('falls back to a page entry for routes without a resource rule', () => {
    const page = (url: string) => {
      const r = parseConsolePage(url)
      return r && { service: r.service, serviceLabel: r.serviceLabel, region: r.region, name: r.name }
    }
    expect(page('https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#Instances:instanceState=running')).toEqual({
      service: 'ec2',
      serviceLabel: 'EC2',
      region: 'us-east-1',
      name: 'Instances'
    })
    // Same page with and without filter state dedupes to one name.
    expect(page('https://us-east-1.console.aws.amazon.com/ec2/home#Instances:')?.name).toBe('Instances')
    expect(page('https://eu-west-1.console.aws.amazon.com/cloudwatch/home#alarmsV2:alarm/High%20CPU?x=1')?.name).toBe(
      'alarmsV2:alarm/High CPU'
    )
    expect(page('https://us-east-1.console.aws.amazon.com/ecs/v2/task-definitions/web/3?region=us-east-1')).toMatchObject({
      serviceLabel: 'ECS',
      name: 'task-definitions/web/3'
    })
    expect(page('https://us-east-1.console.aws.amazon.com/vpcconsole/home')).toMatchObject({ serviceLabel: 'VPC', name: '首页' })
    expect(parseConsolePage('https://us-east-1.console.aws.amazon.com/console/home?region=us-east-1')).toBeNull()
    expect(parseConsolePage('https://signin.aws.amazon.com/signin')).toBeNull()
  })

  it('skips route names that are pages, not resources', () => {
    expect(parseConsoleUrl('https://us-east-1.console.aws.amazon.com/msk/home#/cluster/create')).toBeNull()
    expect(parseConsoleUrl('https://us-east-1.console.aws.amazon.com/aos/home#opensearch/domains/create')).toBeNull()
  })
})
