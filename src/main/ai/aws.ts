import type { AwsCredentials } from '../credentialCommand'
import { classifyAction } from './classify'

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

/** The services a call can go to at all (tool descriptions; "暂不支持" for the rest). */
export const AWS_SERVICES = Object.keys(SDK)

export const AWS_CALL_TIMEOUT_MS = 20_000
/** Confirmed changes (anything not a plain read): RDS / volume modifications and CloudFormation can take a while to answer. */
export const AWS_WRITE_TIMEOUT_MS = 60_000

/** One AWS API call for an account. Tools get this, bound to their conversation's account. */
export type AwsCall = (service: string, action: string, params: Record<string, unknown>, region: string, signal?: AbortSignal) => Promise<unknown>

/** Why `service:action` can't be called (no client, no such command), or null. Loads the module, never calls AWS. */
export type AwsSupports = (service: string, action: string) => Promise<string | null>
export type AwsInputMembers = (service: string, action: string) => Promise<string[] | null>

export class AwsClients {
  private clients = new Map<string, { send(command: unknown, options?: unknown): Promise<unknown> }>()

  constructor(private credentials: (accountId: string) => Promise<AwsCredentials>) {}

  /** Asked before an approval card is shown: no card for a call that could never run. */
  async supports(service: string, action: string): Promise<string | null> {
    const def = Object.hasOwn(SDK, service) ? SDK[service] : undefined
    if (!def) return `暂不支持执行 ${service}（应用支持的服务：${AWS_SERVICES.join(' ')}）`
    const mod = await def.load()
    return typeof mod[`${action}Command`] === 'function' ? null : `${service} 没有 ${action} 这个操作`
  }

  /**
   * The input member names of `service:action` from the SDK's schema (`<Action>Request$`), or null when unknown.
   * Generic EC2 changes DryRun only when the operation has a DryRun member: the serializer drops unknown members,
   * so a "DryRun" of ReleaseHosts would release the hosts.
   */
  async inputMembers(service: string, action: string): Promise<string[] | null> {
    const def = Object.hasOwn(SDK, service) ? SDK[service] : undefined
    if (!def) return null
    const schema = (await def.load())[`${action}Request$`]
    return Array.isArray(schema) && Array.isArray(schema[4]) ? (schema[4] as string[]) : null
  }

  async call(accountId: string, service: string, action: string, params: Record<string, unknown>, region: string, signal?: AbortSignal): Promise<unknown> {
    const def = Object.hasOwn(SDK, service) ? SDK[service] : undefined
    if (!def) throw new Error(`暂不支持执行 ${service}`)
    const mod = await def.load()
    const Command = mod[`${action}Command`]
    if (typeof Command !== 'function') throw new Error(`${service} 没有 ${action} 这个操作`)
    // Global services: their endpoints live in us-east-1, whatever region the user is in.
    const at = def.global ? 'us-east-1' : region
    const key = `${accountId}|${service}|${at}`
    let client = this.clients.get(key)
    if (!client) {
      client = new mod[def.client]({
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

  /** The account's login changed or it was removed: its clients (and the credentials they hold) go. */
  forget(accountId: string): void {
    for (const key of this.clients.keys()) if (key.startsWith(`${accountId}|`)) this.clients.delete(key)
  }
}
