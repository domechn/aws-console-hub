/**
 * How much a given AWS API call needs from the user (docs/plans/ai-approval.md). Pure.
 *
 * Tier A runs without asking: plain reads (Describe / List / Get…) on READ_SERVICES that are not sensitive, and the
 * write adapters (which have their own two-step confirmation). Tier B asks first: reads elsewhere, sensitive reads,
 * names that don't say what they do, writes without an adapter. Tier C is a strong approval (typed confirmation,
 * red banner, never "always allow"): the danger table below. Only malformed names are refused outright.
 */

import { cliOperation } from './awsCli'
import { serviceNameProblem } from './serviceNames'

export type ActionClass = 'read' | 'sensitive' | 'unknown' | 'write' | 'invalid'
export type Tier = 'A' | 'B' | 'C'

/** Services whose plain reads run without asking. Cost Explorer is left to `cost_summary` (each request is billed). */
export const READ_SERVICES = ['ec2', 's3', 'lambda', 'rds', 'cloudwatch', 'logs', 'ecs', 'dynamodb', 'cloudformation', 'iam', 'sts', 'autoscaling'] as const
export type ReadService = (typeof READ_SERVICES)[number]

/** Reads that return secrets, credentials, data contents or code. They ask every time (no "always allow"). */
const SENSITIVE: Record<string, string> = {
  'secretsmanager:GetSecretValue': '会返回密钥明文',
  'secretsmanager:BatchGetSecretValue': '会返回密钥明文',
  'secretsmanager:GetRandomPassword': '会生成密码',
  'ssm:GetParameter': '可能返回解密后的 SecureString',
  'ssm:GetParameters': '可能返回解密后的 SecureString',
  'ssm:GetParametersByPath': '可能返回解密后的 SecureString',
  'ssm:GetParameterHistory': '可能返回解密后的 SecureString',
  'kms:Decrypt': '会返回解密后的数据',
  'kms:GenerateDataKey': '会返回数据密钥明文',
  'kms:GenerateDataKeyPair': '会返回私钥明文',
  'kms:GenerateRandom': '会生成随机密钥材料',
  'ec2:GetPasswordData': '会返回 Windows 管理员密码',
  'ec2:GetConsoleOutput': '控制台输出里常有密钥和启动脚本',
  'ec2:GetConsoleScreenshot': '会返回实例屏幕截图',
  'ec2:DescribeInstanceAttribute': '可读出 userData（启动脚本里常有密钥）',
  'ec2:GetLaunchTemplateData': '会返回 userData',
  'ecr:GetAuthorizationToken': '会返回仓库登录凭证',
  'ecr:GetDownloadUrlForLayer': '会返回镜像层的下载链接',
  'sts:GetSessionToken': '会签发新凭证',
  'sts:GetFederationToken': '会签发新凭证',
  'sts:AssumeRole': '会签发新凭证',
  'sts:AssumeRoleWithSAML': '会签发新凭证',
  'sts:AssumeRoleWithWebIdentity': '会签发新凭证',
  'sts:AssumeRoot': '会签发新凭证',
  'iam:GetCredentialReport': '会返回全部用户的凭证报告',
  'iam:GenerateCredentialReport': '会生成凭证报告',
  's3:GetObject': '会读取对象内容',
  's3:GetObjectTorrent': '会读取对象内容',
  's3:SelectObjectContent': '会读取对象内容',
  'lambda:GetFunction': '会返回代码包下载链接（只看配置请用 GetFunctionConfiguration）',
  'lambda:GetLayerVersion': '会返回代码包下载链接',
  'lambda:GetLayerVersionByArn': '会返回代码包下载链接',
  'dynamodb:Scan': '会读取表数据',
  'dynamodb:Query': '会读取表数据',
  'dynamodb:GetItem': '会读取表数据',
  'dynamodb:BatchGetItem': '会读取表数据',
  // ExecuteStatement / BatchExecuteStatement (PartiQL) can write: classed as writes by name; aws_read lets a
  // SELECT-only request through as a sensitive read.
  'logs:GetLogEvents': '会读取日志内容（query_logs 有时间和条数限额，不用审批）',
  'logs:FilterLogEvents': '会读取日志内容（query_logs 有时间和条数限额，不用审批）',
  'logs:GetLogRecord': '会读取日志内容',
  'logs:GetQueryResults': '会读取日志内容',
  'logs:StartLiveTail': '会读取日志内容',
  'rds:DownloadDBLogFilePortion': '会读取数据库日志内容',
  'sqs:ReceiveMessage': '会读取队列消息（消息会暂时对其他消费者不可见）',
  'kinesis:GetRecords': '会读取流里的数据',
  'apigateway:GetApiKeys': '可能返回 API key 明文（includeValues）',
  'apigateway:GetApiKey': '可能返回 API key 明文（includeValue）',
  'ssm:GetCommandInvocation': '会返回命令在实例上的输出',
  'states:GetExecutionHistory': '会返回执行的输入和输出数据',
  'ec2:GetVpnConnectionDeviceSampleConfiguration': '会返回 VPN 预共享密钥',
  's3control:GetDataAccess': '会返回临时访问凭证',
  'lightsail:GetInstanceAccessDetails': '会返回实例登录凭证',
  'lightsail:GetRelationalDatabaseMasterUserPassword': '会返回数据库密码',
  'lightsail:GetKeyPair': '会返回密钥材料',
  'lightsail:GetKeyPairs': '会返回密钥材料',
  'lightsail:DownloadDefaultKeyPair': '会返回私钥',
  'glue:GetConnection': '可能返回连接密码',
  'glue:GetConnections': '可能返回连接密码',
  'appsync:ListApiKeys': '可能返回 API key',
  'dynamodbstreams:GetRecords': '会读取流里的数据',
  'codecommit:GetFile': '会读取文件内容',
  'codecommit:GetBlob': '会读取文件内容',
  'redshift:GetClusterCredentials': '会返回数据库凭证',
  'redshift:GetClusterCredentialsWithIAM': '会返回数据库凭证'
}

const READ_PREFIXES = /^(?:describe|list|get|head|lookup|search|batch-get)-/
/** Verbs that change something. A name with neither a read prefix nor one of these is "unknown". */
const WRITE_VERBS =
  /^(?:Create|Delete|Put|Update|Modify|Set|Add|Remove|Attach|Detach|Associate|Disassociate|Enable|Disable|Authorize|Revoke|Tag|Untag|Register|Deregister|Import|Export|Copy|Restore|Reset|Replace|Release|Allocate|Accept|Reject|Cancel|Purge|Change|Schedule|Rotate|Start|Stop|Reboot|Terminate|Run|Send|Publish|Invoke|Execute|Upload|Apply|Initiate|Complete|Abort|Upgrade|Promote|Failover|Invite|Leave|Close|Move|Merge|Confirm|Request|Issue|Renew|Retry|Resume|Suspend|Pause|Subscribe|Unsubscribe|Encrypt|ReEncrypt|Sign|Generate|Assume|Archive|Unarchive|Assign|Unassign|Activate|Deactivate|Provision|Deprovision|Recover|Resync|Reload|Refresh|Rebuild|Resize|Increase|Decrease|Grant|Retire|Batch|Notify|Signal|Respond|Submit|Transfer|Purchase|Lock|Unlock|Share|Unshare|Mark|Test|Install|Uninstall|Deploy|Rollback|Swap|Unmonitor|Monitor|Opt|Detect|Commit|Flush|Poll|Wipe|Clear|Backtrack|Write|Rerun|Redrive|Rescind|Restart|Revert|Undo|Override|Force|Scale|Halt|Kill|Shutdown|Evict|Expire|Hibernate|Disconnect|Connect|Link|Unlink|Join|Reserve|Ingest|Transact|Withdraw|Advertise|Rename|Enter|Exit|Split|Switchover|Continue|Label|Deprecate|Unlabel|Rotate)(?:[A-Z]|$)/i

/**
 * Tier C (strong approval): what M3/M4 refused outright. Whole services, then single actions. The text is the
 * operation's category, a neutral tag for the card's banner: what the app knows from the name, never a predicted
 * effect (that is the impact analysis's job, against the real current state).
 */
const DANGER_SERVICES: Record<string, string> = {
  organizations: '组织级操作',
  account: '账号级操作',
  sso: 'SSO 登录配置',
  'sso-admin': 'SSO 权限集',
  identitystore: '身份目录（用户和组）',
  cloudtrail: '审计日志（CloudTrail）配置',
  guardduty: '威胁检测（GuardDuty）配置',
  config: '配置记录（AWS Config）',
  securityhub: 'Security Hub 配置',
  'access-analyzer': 'IAM Access Analyzer 配置',
  macie2: 'Macie 配置',
  inspector2: 'Inspector 配置',
  detective: 'Detective 配置',
  fms: 'Firewall Manager 配置',
  kms: 'KMS 密钥操作',
  secretsmanager: 'Secrets Manager 写操作',
  'ec2-instance-connect': '实例登录密钥推送',
  'ssm-guiconnect': '远程桌面会话',
  s3control: 'S3 账号级访问控制',
  backup: '备份与恢复点配置',
  ram: '资源共享配置',
  waf: 'Web 应用防火墙配置',
  wafv2: 'Web 应用防火墙配置',
  'waf-regional': 'Web 应用防火墙配置',
  shield: 'Shield 防护配置',
  route53domains: '域名注册与转移',
  ses: '邮件身份配置',
  sesv2: '邮件身份配置',
  directconnect: 'Direct Connect 网络配置'
}

const POLICY = '资源策略类变更'
const ACL = 'ACL 类变更'
const SHARING = '共享属性类变更（快照 / AMI）'
const PASS_ROLE = '给资源指定 IAM 角色（iam:PassRole 类）'

const DANGER_ACTIONS: Record<string, string> = {
  'lambda:UpdateFunctionCode': '替换函数代码',
  'lambda:CreateFunction': '创建函数（iam:PassRole 类）',
  'lambda:AddPermission': POLICY,
  'lambda:CreateFunctionUrlConfig': '函数 URL 配置',
  'lambda:UpdateFunctionUrlConfig': '函数 URL 配置',
  's3:PutBucketPolicy': POLICY,
  's3:DeleteBucketPolicy': POLICY,
  's3:PutBucketAcl': ACL,
  's3:PutObjectAcl': ACL,
  's3:PutPublicAccessBlock': '公开访问阻止设置',
  's3:DeletePublicAccessBlock': '公开访问阻止设置',
  's3:PutBucketOwnershipControls': '对象所有权设置（ACL 相关）',
  's3:DeleteObject': '删除对象（数据面）',
  's3:DeleteObjects': '批量删除对象（数据面）',
  's3:PutObject': '写入对象（数据面）',
  's3:PutBucketLifecycleConfiguration': '生命周期规则',
  's3:PutBucketReplication': '复制规则',
  'ec2:ModifySnapshotAttribute': SHARING,
  'ec2:ModifyImageAttribute': SHARING,
  'ec2:CreateKeyPair': '创建密钥对（响应含私钥）',
  'ec2:AssociateIamInstanceProfile': PASS_ROLE,
  'ec2:ReplaceIamInstanceProfileAssociation': PASS_ROLE,
  'ec2:ModifyInstanceMetadataOptions': '实例元数据服务设置',
  'ec2:DisableEbsEncryptionByDefault': '默认加密设置',
  'ec2:EnableSerialConsoleAccess': '串口控制台设置',
  'ec2:ExportImage': '镜像导出',
  'ec2:CreateVpcPeeringConnection': 'VPC 对等连接',
  'ec2:AcceptVpcPeeringConnection': 'VPC 对等连接',
  'ec2:DeleteVpc': 'VPC 网络删除',
  'ec2:DeleteSubnet': '子网删除',
  'ec2:DeleteRouteTable': '路由表删除',
  'ec2:DeleteInternetGateway': '互联网网关删除',
  'ec2:DeleteNatGateway': 'NAT 网关删除',
  'ec2:DeleteNetworkInterface': '网络接口删除',
  'rds:ModifyDBSnapshotAttribute': SHARING,
  'rds:ModifyDBClusterSnapshotAttribute': SHARING,
  'cloudformation:ExecuteChangeSet': '执行 change set（卡片上看不到它的内容；可改用 CreateChangeSet 提案，应用会先展示变更内容）',
  'cloudformation:DeleteStack': '删除 stack',
  'cloudformation:SetStackPolicy': 'stack 策略',
  'cloudformation:UpdateTerminationProtection': '终止保护设置'
}

/** Resource-policy grants on any service (sqs / sns AddPermission, events PutPermission…). */
const PERMISSION_GRANT = /^(?:AddPermission|PutPermission|PutResourcePolicy|PutPolicy|SetRepositoryPolicy|PutRepositoryPolicy|PutRegistryPolicy)$/i

/** IAM writes that grant or move privileges. Other IAM writes (tags, descriptions…) are tier B. */
const IAM_ESCALATION =
  /^(?:(?:Put|Attach|Detach|Delete)\w*Policy|\w*PermissionsBoundary|(?:Create|Update)AccessKey|\w*LoginProfile|UpdateAssumeRolePolicy|CreatePolicyVersion|SetDefaultPolicyVersion|AddUserToGroup|AddRoleToInstanceProfile|CreateRole|CreateUser|DeleteRole|DeleteUser|PassRole|CreateInstanceProfile|CreateServiceSpecificCredential|ResetServiceSpecificCredential|Upload(?:SSHPublicKey|SigningCertificate|ServerCertificate)|\w*MFADevice|\w*SAMLProvider|\w*OpenIDConnectProvider\w*|UpdateRole)$/i

export interface Classification {
  class: ActionClass
  /** null: malformed, never runs. */
  tier: Tier | null
  /** Why the user is asked (shown on the card); '' for tier A. */
  reason: string
  /** Tier C: the danger, for the red banner. */
  danger?: string
}

const NAME = { service: /^[a-z0-9][a-z0-9-]{1,39}$/, action: /^[A-Z][A-Za-z0-9]{2,80}$/ }
export const validNames = (service: unknown, action: unknown): boolean =>
  typeof service === 'string' && typeof action === 'string' && NAME.service.test(service) && !serviceNameProblem(service) && NAME.action.test(action) && action !== 'Command'

export const nameProblem = (service: unknown, action: unknown): string | null => {
  if (typeof service === 'string') {
    const alias = serviceNameProblem(service)
    if (alias) return alias
  }
  if (!validNames(service, action)) return '无效的 service 或 action 名称：action 必须以大写字母开头（PascalCase）'
  const canonical = CANONICAL_ACTIONS[`${service as string}:${(action as string).toLowerCase()}`]
  return canonical && action !== canonical ? `操作名称 ${action as string} 不受支持；请使用 ${canonical}` : null
}

// CLI operation identity is kebab case. Acronym capitalization may vary; lower-case first letters are invalid.
const kebabTable = (table: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(table).map(([key, value]) => {
    const [service, action] = key.split(':')
    return [`${service}:${cliOperation(action)}`, value]
  }))
const SENSITIVE_CLI = kebabTable(SENSITIVE)
const DANGER_ACTIONS_CLI = kebabTable(DANGER_ACTIONS)
const CANONICAL_ACTIONS = Object.fromEntries(
  [...Object.keys(SENSITIVE), ...Object.keys(DANGER_ACTIONS)].map((key) => {
    const [service, action] = key.split(':')
    return [`${service}:${action.toLowerCase()}`, action]
  })
)

/** Tier C danger of a write, or null. */
export function dangerOf(service: string, action: string): string | null {
  if (service === 'iam' && IAM_ESCALATION.test(action)) return 'IAM 权限类变更（策略、访问密钥、登录配置、信任关系、角色）'
  const named = DANGER_SERVICES[service] ?? DANGER_ACTIONS_CLI[`${service}:${cliOperation(action)}`]
  if (named) return named
  return PERMISSION_GRANT.test(action) ? POLICY : null
}

/** `action` is the API name as in the SDK (`DescribeInstances`), `service` the app's SDK key / IAM prefix (`ec2`). */
export function classifyAction(service: string, action: string): Classification {
  const invalid = nameProblem(service, action)
  if (invalid) return { class: 'invalid', tier: null, reason: invalid }
  const operation = cliOperation(action)
  const sensitive = SENSITIVE_CLI[`${service}:${operation}`] ?? (/^(?:get|batch-get)-.*(?:secret|password|credential|token|private-key|key-material|log-events|object-content)/.test(operation) ? '可能返回敏感内容' : undefined)
  if (sensitive) return { class: 'sensitive', tier: 'B', reason: `敏感读取：${sensitive}` }
  const listed = (READ_SERVICES as readonly string[]).includes(service)
  if (READ_PREFIXES.test(operation) || (service === 'logs' && /^filter-/.test(operation))) {
    if (listed && (service !== 'sts' || operation === 'get-caller-identity')) return { class: 'read', tier: 'A', reason: '' }
    return {
      class: 'read',
      tier: 'B',
      reason: listed ? `${service} 只有 GetCallerIdentity 默认自动允许，其他调用需要你确认` : `${service} 不在默认自动允许的服务里，需要你确认`
    }
  }
  // Before the verb check: a dangerous name with an unusual verb (iam:PassRole) is still a dangerous write.
  const danger = dangerOf(service, action)
  if (danger) return { class: 'write', tier: 'C', reason: `需要强确认的类别：${danger}`, danger }
  if (WRITE_VERBS.test(action)) return { class: 'write', tier: 'B', reason: '没有专用适配器，应用无法预知影响' }
  return { class: 'unknown', tier: 'B', reason: `无法从名称判断 ${action} 是不是只读操作，可能有副作用` }
}

/** Keys that hand an IAM role to a resource (iam:PassRole), at any depth, any case (ECS / EKS / SFN are camelCase). */
const PASS_ROLE_KEY = /^(?:IamInstanceProfile|Role|RoleArn|ExecutionRoleArn|TaskRoleArn|ServiceRole|ServiceRoleArn|IamRoleArn|IamRole|InstanceRoleArn|JobRoleArn|NodeRole|PodExecutionRoleArn)$/i
/** Keys that carry a resource policy (who may access the resource), at any depth. */
export const POLICY_KEY = /^(?:Policy|PolicyDocument|ResourcePolicy|AccessPolicies|KeyPolicy|PolicyText)$/i

function keysOf(v: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || !v || typeof v !== 'object') return out
  for (const [k, x] of Object.entries(v)) {
    if (!Array.isArray(v)) out.add(k)
    keysOf(x, out, depth + 1)
  }
  return out
}

export interface WriteTier {
  tier: 'B' | 'C'
  /** Tier C: every danger found (action table, then params). */
  dangers: string[]
  /** The name says it deletes, stops or rewrites access: the card says so and the risk is "destructive". */
  destructive: boolean
}

/**
 * The tier of a write without an adapter, from its name and its params. `ownRole`: the role the app signs in with
 * (changing it can lock the app out or widen what the assistant can do).
 */
export function writeTier(service: string, action: string, params: Record<string, unknown>, ownRole?: string): WriteTier {
  const dangers: string[] = []
  const named = dangerOf(service, action)
  if (named) dangers.push(named)
  const keys = keysOf(params)
  if (service !== 'iam' && [...keys].some((k) => PASS_ROLE_KEY.test(k))) dangers.push(`参数里有 IAM 角色：${PASS_ROLE}`)
  if ([...keys].some((k) => POLICY_KEY.test(k)) || params.AttributeName === 'Policy') dangers.push(`参数里有策略文档：${POLICY}`)
  const caps = JSON.stringify(params.Capabilities ?? '')
  if (/CAPABILITY_(?:NAMED_)?IAM/.test(caps)) dangers.push('CloudFormation 授予 CAPABILITY_IAM（模板可含 IAM 资源）')
  if (ownRole && service === 'iam' && (params.RoleName === ownRole || params.RoleName === ownRole.split('/').pop())) dangers.push(`修改本应用登录用的角色（${ownRole}）`)
  const destructive = /^(?:Delete|Terminate|Remove|Purge|Destroy|Deregister|Disable|Revoke|Detach|Disassociate|Cancel|Stop|Reset|Leave|Close)[A-Z]|^Put\w*Policy$/i.test(action)
  return { tier: dangers.length ? 'C' : 'B', dangers: [...new Set(dangers)], destructive }
}
