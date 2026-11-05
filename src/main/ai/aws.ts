import type { AwsCredentials } from '../credentialCommand'
import { classifyAction } from './classify'
import { nameProblem } from './classify'
import { cliCall, cliOperation, findAwsCli, nonApiCliReason, stopAccountCli } from './awsCli'

/**
 * SDK v3 clients for the assistant's read tools, approved calls and changes the user confirmed (changes/engine.ts is
 * the only caller that sends writes). Each service module loads on first use (main startup stays as is),
 * clients are cached per (account, service, region), and credentials come through a provider function, so the SDK
 * re-asks the app's credential pipeline (federation.ts, in-memory cache) when they near expiry. Only the account's
 * own credentials: no client gets a default provider chain (~/.aws, env).
 */

type SdkModule = Record<string, any>

/**
 * Static registry: adding a service is one line plus its pinned @aws-sdk/client-* dependency. Keys are IAM prefixes
 * (apigatewayv2 aside: v1 and v2 share the `apigateway` prefix). The second group is only reached through an
 * approval (or a confirmed generic change): a curated set of common services, not the whole SDK.
 */
export const SDK: Record<string, { load: () => Promise<SdkModule>; client: string; global?: boolean }> = {
  ec2: { load: () => import('@aws-sdk/client-ec2'), client: 'EC2Client' },
  s3: { load: () => import('@aws-sdk/client-s3'), client: 'S3Client' },
  lambda: { load: () => import('@aws-sdk/client-lambda'), client: 'LambdaClient' },
  rds: { load: () => import('@aws-sdk/client-rds'), client: 'RDSClient' },
  cloudwatch: { load: () => import('@aws-sdk/client-cloudwatch'), client: 'CloudWatchClient' },
  logs: { load: () => import('@aws-sdk/client-cloudwatch-logs'), client: 'CloudWatchLogsClient' },
  ecs: { load: () => import('@aws-sdk/client-ecs'), client: 'ECSClient' },
  dynamodb: { load: () => import('@aws-sdk/client-dynamodb'), client: 'DynamoDBClient' },
  cloudformation: { load: () => import('@aws-sdk/client-cloudformation'), client: 'CloudFormationClient' },
  autoscaling: { load: () => import('@aws-sdk/client-auto-scaling'), client: 'AutoScalingClient' },
  tag: { load: () => import('@aws-sdk/client-resource-groups-tagging-api'), client: 'ResourceGroupsTaggingAPIClient' },
  iam: { load: () => import('@aws-sdk/client-iam'), client: 'IAMClient', global: true },
  sts: { load: () => import('@aws-sdk/client-sts'), client: 'STSClient', global: true },
  ce: { load: () => import('@aws-sdk/client-cost-explorer'), client: 'CostExplorerClient', global: true },

  ssm: { load: () => import('@aws-sdk/client-ssm'), client: 'SSMClient' },
  secretsmanager: { load: () => import('@aws-sdk/client-secrets-manager'), client: 'SecretsManagerClient' },
  kms: { load: () => import('@aws-sdk/client-kms'), client: 'KMSClient' },
  sns: { load: () => import('@aws-sdk/client-sns'), client: 'SNSClient' },
  sqs: { load: () => import('@aws-sdk/client-sqs'), client: 'SQSClient' },
  route53: { load: () => import('@aws-sdk/client-route-53'), client: 'Route53Client', global: true },
  cloudfront: { load: () => import('@aws-sdk/client-cloudfront'), client: 'CloudFrontClient', global: true },
  elasticloadbalancing: { load: () => import('@aws-sdk/client-elastic-load-balancing-v2'), client: 'ElasticLoadBalancingV2Client' },
  acm: { load: () => import('@aws-sdk/client-acm'), client: 'ACMClient' },
  eks: { load: () => import('@aws-sdk/client-eks'), client: 'EKSClient' },
  ecr: { load: () => import('@aws-sdk/client-ecr'), client: 'ECRClient' },
  apigateway: { load: () => import('@aws-sdk/client-api-gateway'), client: 'APIGatewayClient' },
  apigatewayv2: { load: () => import('@aws-sdk/client-apigatewayv2'), client: 'ApiGatewayV2Client' },
  events: { load: () => import('@aws-sdk/client-eventbridge'), client: 'EventBridgeClient' },
  states: { load: () => import('@aws-sdk/client-sfn'), client: 'SFNClient' },
  cloudtrail: { load: () => import('@aws-sdk/client-cloudtrail'), client: 'CloudTrailClient' },
  elasticache: { load: () => import('@aws-sdk/client-elasticache'), client: 'ElastiCacheClient' },
  kinesis: { load: () => import('@aws-sdk/client-kinesis'), client: 'KinesisClient' },
  guardduty: { load: () => import('@aws-sdk/client-guardduty'), client: 'GuardDutyClient' },
  organizations: { load: () => import('@aws-sdk/client-organizations'), client: 'OrganizationsClient', global: true }
}

/** Bundled SDK services; other service names use AWS CLI. */
export const AWS_SERVICES = Object.keys(SDK)
/** Prevent a differently cased SDK action from escaping to the equivalent CLI operation. */
export async function exactAwsAction(service: string, action: string): Promise<string | null> {
  const def = Object.hasOwn(SDK, service) ? SDK[service] : undefined
  if (!def) return null
  const mod = await def.load()
  if (typeof mod[`${action}Command`] === 'function') return null
  const operation = cliOperation(action)
  const exact = Object.keys(mod).find((key) =>
    key.endsWith('Command') && typeof mod[key] === 'function' &&
    cliOperation(key.slice(0, -'Command'.length)) === operation
  )
  return exact ? `操作名称 ${action} 不受支持；请使用 ${exact.slice(0, -'Command'.length)}` : null
}
/** Smithy operation schemas carry input members even when the input shape has no Request suffix. */
function commandMembers(mod: SdkModule, action: string): string[] | null {
  const op = mod[`${action}$`]
  const schema = typeof op?.[4] === 'function' ? op[4]() : null
  if (schema === 'unit') return []
  if (Array.isArray(schema?.[4])) return schema[4]
  for (const suffix of ['Request$', 'Input$', 'Message$']) {
    const shape = mod[`${action}${suffix}`]
    if (Array.isArray(shape?.[4])) return shape[4]
  }
  return null
}
export async function usesAwsCli(service: string, action: string, _params: Record<string, unknown> = {}): Promise<boolean> {
  const def = Object.hasOwn(SDK, service) ? SDK[service] : undefined
  if (!def) return true
  const mod = await def.load()
  if (typeof mod[`${action}Command`] !== 'function') {
    const casing = await exactAwsAction(service, action)
    if (casing) throw new Error(casing)
    return true
  }
  return false
}

/** SDK serializers discard unknown top-level members; refuse them before any call. Nested values are valid. */
export function unknownAwsParams(params: Record<string, unknown>, members: string[] | null): string | null {
  if (!members) return Object.keys(params).length ? '无法校验操作参数：缺少 SDK 输入结构' : null
  const unknown = Object.keys(params).filter((key) => !members.includes(key))
  return unknown.length ? `未知参数 ${unknown.join('、')}；可用：${members.join('、') || '无'}` : null
}

export const AWS_CALL_TIMEOUT_MS = 20_000
/** Confirmed changes (anything not a plain read): RDS / volume modifications and CloudFormation can take a while to answer. */
export const AWS_WRITE_TIMEOUT_MS = 60_000

/** One AWS API call for an account. Tools get this, bound to their conversation's account. */
export type AwsCall = (service: string, action: string, params: Record<string, unknown>, region: string, signal?: AbortSignal) => Promise<unknown>

/** Whether the names can be passed to an AWS executor. */
export type AwsSupports = (service: string, action: string) => Promise<string | null>
export type AwsInputMembers = (service: string, action: string) => Promise<string[] | null>
export const inputMembers: AwsInputMembers = async (service, action) => {
  const def = Object.hasOwn(SDK, service) ? SDK[service] : undefined
  return def ? commandMembers(await def.load(), action) : null
}

export class AwsClients {
  private clients = new Map<string, { send(command: unknown, options?: unknown): Promise<unknown> }>()

  constructor(private credentials: (accountId: string) => Promise<AwsCredentials>, private cliPath: () => string | null = () => null) {}

  /** Well-formed names can reach SDK or CLI; the CLI reports unavailable commands after approval. */
  async supports(service: string, action: string): Promise<string | null> {
    return nameProblem(service, action) ?? nonApiCliReason(service, action) ?? await exactAwsAction(service, action)
  }

  /**
   * The input member names of `service:action` from the SDK's operation schema, or null when unknown.
   * Generic EC2 changes DryRun only when the operation has a DryRun member: the serializer drops unknown members,
   * so a "DryRun" of ReleaseHosts would release the hosts.
   */
  async inputMembers(service: string, action: string): Promise<string[] | null> {
    return inputMembers(service, action)
  }

  async call(accountId: string, service: string, action: string, params: Record<string, unknown>, region: string, signal?: AbortSignal): Promise<unknown> {
    const invalid = nameProblem(service, action)
    if (invalid) throw new Error(invalid)
    const refused = nonApiCliReason(service, action)
    if (refused) throw new Error(refused)
    const casing = await exactAwsAction(service, action)
    if (casing) throw new Error(casing)
    const def = Object.hasOwn(SDK, service) ? SDK[service] : undefined
    const mod = def ? await def.load() : null
    const Command = mod?.[`${action}Command`]
    const members = mod ? commandMembers(mod, action) : null
    if (typeof Command !== 'function') {
      return this.callCli(accountId, service, action, params, region, signal)
    }
    const unknown = unknownAwsParams(params, members)
    if (unknown) throw new Error(unknown)
    // Global services: their endpoints live in us-east-1, whatever region the user is in.
    const at = def!.global ? 'us-east-1' : region
    const key = `${accountId}|${service}|${at}`
    let client = this.clients.get(key)
    if (!client) {
      client = new mod![def!.client]({
        region: at,
        maxAttempts: 2,
        credentials: async () => {
          const c = await this.credentials(accountId)
          return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: new Date(c.Expiration) }
        }
      }) as { send(command: unknown, options?: unknown): Promise<unknown> }
      this.clients.set(key, client)
    }
    const read = ['read', 'sensitive'].includes(classifyAction(service, action).class)
    const timeout = AbortSignal.timeout(read ? AWS_CALL_TIMEOUT_MS : AWS_WRITE_TIMEOUT_MS)
    return client.send(new Command(params), { abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  }

  async callCli(accountId: string, service: string, action: string, params: Record<string, unknown>, region: string, signal?: AbortSignal): Promise<unknown> {
    const invalid = nameProblem(service, action)
    if (invalid) throw new Error(invalid)
    const refused = nonApiCliReason(service, action)
    if (refused) throw new Error(refused)
    const casing = await exactAwsAction(service, action)
    if (casing) throw new Error(casing)
    const read = ['read', 'sensitive'].includes(classifyAction(service, action).class)
    return cliCall(findAwsCli(this.cliPath()), await this.credentials(accountId), service, action, params, region, read ? AWS_CALL_TIMEOUT_MS : AWS_WRITE_TIMEOUT_MS, signal, undefined, accountId)
  }

  /** The account's login changed or it was removed: its clients (and the credentials they hold) go. */
  forget(accountId: string): void {
    stopAccountCli(accountId)
    for (const key of this.clients.keys()) if (key.startsWith(`${accountId}|`)) this.clients.delete(key)
  }
}
