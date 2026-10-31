import { SERVICES } from '../shared/catalog'
import type { RecentResource } from '../shared/types'

export type ParsedResource = Omit<RecentResource, 'key' | 'accountId' | 'lastVisited' | 'pinned'>

const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d$/

const isConsoleHost = (host: string): boolean =>
  host === 'console.aws.amazon.com' || host.endsWith('.console.aws.amazon.com')

function hostRegion(hostname: string): string | null {
  const first = hostname.split('.')[0]
  return REGION_RE.test(first) ? first : null
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Console route segments that name a page, not a resource. */
const RESERVED_NAMES = new Set(['create', 'new', 'list', 'home', 'index'])

/**
 * Pull `<type>/<name>` out of an ARN found anywhere in the URL. Some consoles
 * (MSK, OpenSearch) identify a resource by its full ARN in the hash or a query
 * param, percent-encoded to a varying depth.
 */
function arnResource(url: string, service: string, type: string): string | null {
  const re = new RegExp(`arn:[^:]*:${service}:[^:]*:[^:]*:${type}(?:/|%2F)([^/?&;"%]+)`, 'i')
  let s = url
  for (let i = 0; i < 3; i++) {
    const m = s.match(re)
    if (m) return m[1]
    const next = safeDecode(s)
    if (next === s) break
    s = next
  }
  return null
}

/** CloudWatch double-encodes path chars using $ instead of % (e.g. / -> $252F). */
function decodeCloudWatch(s: string): string {
  try {
    return decodeURIComponent(decodeURIComponent(s.replace(/\$/g, '%')))
  } catch {
    return s
  }
}

/**
 * Best-effort extraction of a concrete resource (bucket, function, table...)
 * from an AWS console URL. Returns null for anything that is not a resource
 * detail page we recognize.
 */
export function parseConsoleUrl(raw: string): ParsedResource | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const host = u.hostname
  if (!isConsoleHost(host)) return null

  const region = u.searchParams.get('region') || hostRegion(host) || 'global'
  const path = u.pathname
  const hash = u.hash.replace(/^#/, '')

  const R = (service: string, serviceLabel: string, resourceType: string, name: string): ParsedResource => ({
    service,
    serviceLabel,
    region,
    resourceType,
    name,
    url: raw
  })

  let m: RegExpMatchArray | null

  if ((m = path.match(/^\/s3\/buckets\/([^/?]+)/))) return R('s3', 'S3', 'Bucket', safeDecode(m[1]))

  if (path.startsWith('/lambda/') && (m = hash.match(/^\/functions\/([^/?]+)/)))
    return R('lambda', 'Lambda', 'Function', safeDecode(m[1]))

  if (path.startsWith('/dynamodbv2/') && (m = hash.match(/table\?(?:[^#]*&)?name=([^&]+)/)))
    return R('dynamodb', 'DynamoDB', 'Table', safeDecode(m[1]))

  if (path.includes('/ec2/') && (m = hash.match(/InstanceDetails:instanceId=([^;&]+)/)))
    return R('ec2', 'EC2', 'Instance', safeDecode(m[1]))

  // Security groups live in both the EC2 and the VPC console, under a
  // #SecurityGroup(s): route. Recording them under one service id means the
  // same group reached from either console dedupes to a single entry.
  if (path.includes('/ec2/') || path.startsWith('/vpcconsole/')) {
    if (/^SecurityGroups?:/.test(hash) && (m = hash.match(/\b(sg-[0-9a-f]{8,17})\b/)))
      return R('ec2', 'EC2', 'Security group', m[1])
  }

  if (path.startsWith('/cloudwatch/') && (m = hash.match(/logsV2:log-groups\/log-group\/([^/?]+)/)))
    return R('cloudwatch-logs', 'CloudWatch Logs', 'Log group', decodeCloudWatch(m[1]))

  if (path.startsWith('/cloudformation/') && (m = hash.match(/stackId=([^&]+)/))) {
    const arn = safeDecode(m[1])
    return R('cloudformation', 'CloudFormation', 'Stack', arn.split('/')[1] || arn)
  }

  if (path.startsWith('/sqs/') && (m = hash.match(/\/queues\/([^?]+)/))) {
    const queueUrl = safeDecode(m[1])
    return R('sqs', 'SQS', 'Queue', queueUrl.split('/').pop() || queueUrl)
  }

  if (path.startsWith('/sns/') && (m = hash.match(/\/topic\/([^?]+)/))) {
    const arn = safeDecode(m[1])
    return R('sns', 'SNS', 'Topic', arn.split(':').pop() || arn)
  }

  if ((m = path.match(/^\/ecs\/v2\/clusters\/([^/]+)\/services\/([^/?]+)/)))
    return R('ecs', 'ECS', 'Service', `${safeDecode(m[1])}/${safeDecode(m[2])}`)

  if ((m = path.match(/^\/ecs\/v2\/clusters\/([^/?]+)/))) return R('ecs', 'ECS', 'Cluster', safeDecode(m[1]))

  if ((m = path.match(/^\/eks\/clusters\/([^/]+)\/nodegroups\/([^/?]+)/)))
    return R('eks', 'EKS', 'Node group', `${safeDecode(m[1])}/${safeDecode(m[2])}`)

  if ((m = path.match(/^\/eks\/clusters\/([^/?]+)/))) return R('eks', 'EKS', 'Cluster', safeDecode(m[1]))

  // Legacy hash-routed EKS console (redirects to the path-routed form above).
  if (path.startsWith('/eks/') && (m = hash.match(/\/clusters\/([^/?]+)/)))
    return R('eks', 'EKS', 'Cluster', safeDecode(m[1]))

  if (path.startsWith('/iam')) {
    if ((m = hash.match(/\/roles\/details\/([^/?]+)/))) return R('iam', 'IAM', 'Role', safeDecode(m[1]))
    if ((m = hash.match(/\/users\/details\/([^/?]+)/))) return R('iam', 'IAM', 'User', safeDecode(m[1]))
  }

  if (path.startsWith('/secretsmanager/secret')) {
    const name = u.searchParams.get('name')
    if (name) return R('secretsmanager', 'Secrets Manager', 'Secret', name)
  }

  if (path.startsWith('/rds/') && (m = hash.match(/database:id=([^;&]+)/)))
    return R('rds', 'RDS', 'Database', safeDecode(m[1]))

  if (path.startsWith('/states/') && (m = hash.match(/\/statemachines\/view\/([^?]+)/))) {
    const arn = safeDecode(m[1])
    return R('stepfunctions', 'Step Functions', 'State machine', arn.split(':').pop() || arn)
  }

  if ((m = path.match(/^\/ecr\/repositories\/(?:private|public)\/[^/]+\/([^/?]+)/)))
    return R('ecr', 'ECR', 'Repository', safeDecode(m[1]))

  if ((m = path.match(/^\/apigateway\/main\/apis\/([^/?]+)/))) return R('apigateway', 'API Gateway', 'API', m[1])

  if ((m = path.match(/^\/codesuite\/codepipeline\/pipelines\/([^/?]+)/)))
    return R('codepipeline', 'CodePipeline', 'Pipeline', safeDecode(m[1]))

  if (path.startsWith('/kinesis/') && (m = hash.match(/\/streams\/details\/([^/?]+)/)))
    return R('kinesis', 'Kinesis', 'Stream', safeDecode(m[1]))

  // MSK identifies a cluster by ARN (arn:aws:kafka:…:cluster/<name>/<uuid>);
  // provisioned and serverless clusters share the same route.
  if (path.startsWith('/msk/')) {
    const arnName = arnResource(raw, 'kafka', 'cluster')
    if (arnName) return R('msk', 'MSK', 'Cluster', arnName)
    if ((m = hash.match(/\/cluster\/([^/?]+)/))) {
      const name = safeDecode(m[1])
      if (!RESERVED_NAMES.has(name)) return R('msk', 'MSK', 'Cluster', name)
    }
  }

  // OpenSearch: /aos/ is the current console, /es/ the legacy Elasticsearch one.
  if (path.startsWith('/aos/') || path.startsWith('/es/')) {
    const h = safeDecode(hash)

    const collection = arnResource(raw, 'aoss', 'collection')
    if (collection) return R('opensearch-serverless', 'OpenSearch Serverless', 'Collection', collection)
    if ((m = h.match(/collections\/([^/?&]+)/)) && !RESERVED_NAMES.has(m[1]))
      return R('opensearch-serverless', 'OpenSearch Serverless', 'Collection', m[1])

    const domain = arnResource(raw, 'es', 'domain')
    if (domain) return R('opensearch', 'OpenSearch', 'Domain', domain)
    if ((m = h.match(/domains\/([^/?&]+)/)) && !RESERVED_NAMES.has(m[1]))
      return R('opensearch', 'OpenSearch', 'Domain', m[1])
    // Legacy console: #domain:resource=my-domain;action=dashboard
    if ((m = h.match(/domain:resource=([^;&]+)/))) return R('opensearch', 'OpenSearch', 'Domain', m[1])
  }

  return null
}

/** Catalog label per console path segment ("vpcconsole" -> "VPC"); the first service listed wins. */
const SERVICE_LABELS = new Map<string, string>()
for (const s of [...SERVICES].reverse()) {
  SERVICE_LABELS.set(new URL(s.url('us-east-1')).pathname.split('/')[1], s.label)
}

/** Path segments that are console plumbing, not part of a page's identity. */
const NOISE_SEGMENTS = /^(home|v\d)$/

/**
 * Fallback for console pages `parseConsoleUrl` has no rule for (Glue jobs,
 * alarms, list pages…): recorded by service + route so the visit still shows
 * up in recents. Filter state is dropped from the route — `#Instances:state=running`
 * and `#Instances:` are the same page.
 */
export function parseConsolePage(raw: string): ParsedResource | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || !isConsoleHost(u.hostname)) return null
  const [service, ...rest] = u.pathname.split('/').filter(Boolean)
  // The console home is where every login lands; recording it is noise.
  if (!service || service === 'console') return null

  const hashRoute = u.hash
    .replace(/^#\/?/, '')
    .split(/[?;]/)[0]
    .replace(/:[^/]*=.*$/, '')
    .replace(/:$/, '')
  const route = [...rest.filter((s) => !NOISE_SEGMENTS.test(s)), ...hashRoute.split('/')]
    .filter(Boolean)
    .map(safeDecode)
    .join('/')

  return {
    service,
    serviceLabel: SERVICE_LABELS.get(service) ?? service,
    region: u.searchParams.get('region') || hostRegion(u.hostname) || 'global',
    resourceType: '页面',
    name: (route || '首页').slice(0, 120),
    url: raw,
    isPage: true
  }
}
