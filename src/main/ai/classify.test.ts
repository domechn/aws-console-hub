import { describe, expect, it } from 'vitest'
import { classifyAction, READ_SERVICES, writeTier } from './classify'
import { CLI_TO_CANONICAL } from './serviceNames'

/** Everything M3 / M4 refused outright as a change (registry.test.ts's old FORBIDDEN list), with its new tier. */
const OLD_FORBIDDEN: [string, 'B' | 'C'][] = [
  // IAM privilege escalation, including the app's own role
  ...['PutRolePolicy', 'PutUserPolicy', 'PutGroupPolicy', 'AttachRolePolicy', 'AttachUserPolicy', 'AttachGroupPolicy', 'CreateAccessKey', 'UpdateAssumeRolePolicy',
    'CreatePolicyVersion', 'SetDefaultPolicyVersion', 'AddUserToGroup', 'CreateLoginProfile', 'UpdateLoginProfile', 'CreateRole', 'DeleteRole', 'PassRole',
    'CreateInstanceProfile', 'AddRoleToInstanceProfile', 'DeleteRolePolicy', 'CreateUser'].map((a): [string, 'C'] => [`iam:${a}`, 'C']),
  // audit and detection
  ...['cloudtrail:StopLogging', 'cloudtrail:DeleteTrail', 'cloudtrail:UpdateTrail', 'cloudtrail:PutEventSelectors', 'guardduty:DeleteDetector', 'guardduty:UpdateDetector',
    'guardduty:ArchiveFindings', 'config:StopConfigurationRecorder', 'config:DeleteConfigurationRecorder', 'config:DeleteDeliveryChannel', 'securityhub:DisableSecurityHub',
    'access-analyzer:DeleteAnalyzer'].map((k): [string, 'C'] => [k, 'C']),
  // account and organization
  ...['organizations:LeaveOrganization', 'organizations:CreateAccount', 'account:CloseAccount', 'sso:Logout', 'sso-admin:CreatePermissionSet'].map((k): [string, 'C'] => [k, 'C']),
  // keys and secrets
  ...['kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy', 'kms:CreateGrant', 'secretsmanager:DeleteSecret', 'secretsmanager:PutSecretValue'].map((k): [string, 'C'] => [k, 'C']),
  // remote execution: tier B by decision (the user approves each one with typed confirmation); instance-connect stays C
  ['ssm:SendCommand', 'B'],
  ['ssm:StartSession', 'B'],
  ['ssm:PutParameter', 'B'],
  ['lambda:Invoke', 'B'],
  ['ec2-instance-connect:SendSSHPublicKey', 'C'],
  ['lambda:UpdateFunctionCode', 'C'],
  ['lambda:CreateFunction', 'C'],
  // exposure
  ...['s3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:PutBucketAcl', 's3:PutPublicAccessBlock', 's3:DeletePublicAccessBlock', 's3:DeleteObjects', 'ec2:ModifySnapshotAttribute',
    'ec2:ModifyImageAttribute', 'ec2:CreateKeyPair', 'ec2:AssociateIamInstanceProfile', 'ec2:ModifyInstanceMetadataOptions', 'rds:ModifyDBSnapshotAttribute', 'lambda:AddPermission',
    'lambda:CreateFunctionUrlConfig'].map((k): [string, 'C'] => [k, 'C']),
  // cloudformation outside the change-set flow
  ['cloudformation:ExecuteChangeSet', 'C'],
  ['cloudformation:DeleteStack', 'C']
]

/** Everything M1–M4 refused as a sensitive read: now a tier B read that asks every time. */
const OLD_SENSITIVE = [
  'secretsmanager:GetSecretValue', 'secretsmanager:BatchGetSecretValue', 'ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'ssm:GetParameterHistory',
  'kms:Decrypt', 'kms:GenerateDataKey', 'ec2:GetPasswordData', 'ec2:GetConsoleOutput', 'ec2:GetConsoleScreenshot', 'ec2:DescribeInstanceAttribute', 'ec2:GetLaunchTemplateData',
  'ecr:GetAuthorizationToken', 'sts:GetSessionToken', 'sts:GetFederationToken', 'sts:AssumeRole', 'sts:AssumeRoleWithSAML', 'sts:AssumeRoleWithWebIdentity',
  'iam:GetCredentialReport', 'iam:GenerateCredentialReport', 's3:GetObject', 's3:GetObjectTorrent', 's3:SelectObjectContent', 'lambda:GetFunction', 'lambda:GetLayerVersion',
  'lambda:GetLayerVersionByArn', 'dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:BatchGetItem',
  'logs:GetLogEvents', 'logs:FilterLogEvents', 'logs:GetLogRecord', 'logs:GetQueryResults', 'logs:StartLiveTail'
]

const split = (key: string): [string, string] => key.split(':') as [string, string]

describe('classifyAction: tiers', () => {
  it('refuses noncanonical spellings of sensitive and danger actions', () => {
    expect(classifyAction('ec2', 'GetpasswordData')).toMatchObject({ class: 'invalid', reason: expect.stringContaining('请使用 GetPasswordData') })
    expect(classifyAction('rds', 'ModifyDbSnapshotAttribute')).toMatchObject({ class: 'invalid', reason: expect.stringContaining('请使用 ModifyDBSnapshotAttribute') })
  })
  it('classifies credential-returning reads and waf-regional writes', () => {
    for (const key of ['s3control:GetDataAccess', 'lightsail:GetInstanceAccessDetails', 'glue:GetConnection', 'appsync:ListApiKeys', 'dynamodbstreams:GetRecords', 'codecommit:GetBlob', 'redshift:GetClusterCredentials']) {
      expect(classifyAction(...split(key)).class, key).toBe('sensitive')
    }
    expect(classifyAction('waf-regional', 'DeleteWebACL').tier).toBe('C')
  })
  it('rejects every CLI spelling before classification', () => {
    for (const [alias, canonical] of Object.entries(CLI_TO_CANONICAL)) {
      expect(classifyAction(alias, 'ListThings')).toMatchObject({ class: 'invalid', tier: null, reason: expect.stringContaining(`请使用 ${canonical}`) })
    }
  })

  it.each([
    's3:PutBucketAcl', 's3:DeleteBucketPolicy', 's3:DeletePublicAccessBlock',
    'config:DeleteConfigRule', 'access-analyzer:DeleteAnalyzer', 's3control:DeleteAccessPoint',
    'wafv2:DeleteWebACL', 'backup:DeleteRecoveryPoint', 'ram:DeleteResourceShare',
    'shield:DeleteProtection', 'route53domains:TransferDomain'
  ])('%s requires tier C', (key) => {
    expect(classifyAction(...split(key))).toMatchObject({ class: 'write', tier: 'C' })
  })

  it.each(['config:DescribeConfigRules', 'access-analyzer:ListAnalyzers', 'wafv2:GetWebACL', 'backup:ListBackupVaults'])('%s stays a read', (key) => {
    expect(classifyAction(...split(key)).class).toBe('read')
  })
  it.each([
    ['ec2', 'DescribeInstances'],
    ['ec2', 'DescribeSecurityGroups'],
    ['s3', 'ListBuckets'],
    ['s3', 'GetBucketPolicy'],
    ['s3', 'HeadBucket'],
    ['lambda', 'GetFunctionConfiguration'],
    ['lambda', 'ListFunctions'],
    ['rds', 'DescribeDBInstances'],
    ['cloudwatch', 'GetMetricData'],
    ['cloudwatch', 'DescribeAlarms'],
    ['logs', 'DescribeLogGroups'],
    ['logs', 'FilterSomething'],
    ['ecs', 'ListClusters'],
    ['dynamodb', 'DescribeTable'],
    ['dynamodb', 'ListTables'],
    ['cloudformation', 'DescribeStacks'],
    ['iam', 'ListRoles'],
    ['iam', 'GetRole'],
    ['sts', 'GetCallerIdentity'],
    ['ec2', 'SearchTransitGatewayRoutes'],
    ['iam', 'BatchGetFoo']
  ])('%s:%s is tier A (runs without asking)', (service, action) => {
    expect(classifyAction(service, action)).toEqual({ class: 'read', tier: 'A', reason: '' })
  })

  it.each(OLD_SENSITIVE)('old sensitive %s is a tier B sensitive read', (key) => {
    const c = classifyAction(...split(key))
    expect(c).toMatchObject({ class: 'sensitive', tier: 'B', reason: expect.stringContaining('敏感读取') })
  })

  it.each([
    ['organizations', 'ListAccounts'],
    ['secretsmanager', 'ListSecrets'],
    ['ssm', 'DescribeParameters'],
    ['ce', 'GetCostAndUsage'],
    ['cloudtrail', 'LookupEvents'],
    ['sqs', 'ListQueues'],
    ['sts', 'GetAccessKeyInfo'],
    ['ec2', 'FilterSomething']
  ])('%s:%s (a read outside the default allowlist) is tier B', (service, action) => {
    expect(classifyAction(service, action)).toMatchObject({ class: expect.stringMatching(/^(read|unknown)$/), tier: 'B' })
  })

  it.each([
    ['ec2', 'Fetch'],
    ['ec2', 'Read'],
    ['ec2', 'Getinstances'],
    ['sts', 'DecodeAuthorizationMessage']
  ])('unrecognised name %s:%s is tier B "unknown" (may not be a read)', (service, action) => {
    expect(classifyAction(service, action)).toMatchObject({ class: 'unknown', tier: 'B', reason: expect.stringContaining('可能有副作用') })
  })

  it.each([
    ['ec2', 'TerminateInstances'],
    ['ec2', 'StopInstances'],
    ['ec2', 'RunInstances'],
    ['ec2', 'CreateTags'],
    ['s3', 'DeleteBucket'],
    ['lambda', 'UpdateFunctionConfiguration'],
    ['rds', 'DeleteDBInstance'],
    ['dynamodb', 'PutItem'],
    ['logs', 'StartQuery'],
    ['sns', 'Publish'],
    ['sqs', 'DeleteQueue'],
    ['iam', 'TagRole'],
    ['iam', 'UpdateRoleDescription'],
    ['apigateway', 'FlushStageCache'],
    ['s3', 'WriteGetObjectResponse'],
    ['rds', 'BacktrackDBCluster'],
    ['ecr', 'BatchDeleteImage'],
    // PartiQL can write (aws_read lets SELECT-only requests through as sensitive reads).
    ['dynamodb', 'ExecuteStatement'],
    ['dynamodb', 'BatchExecuteStatement'],
    ['dynamodb', 'TransactWriteItems']
  ])('write %s:%s without a danger is tier B', (service, action) => {
    expect(classifyAction(service, action)).toMatchObject({ class: 'write', tier: 'B' })
  })

  it.each(OLD_FORBIDDEN)('old forbidden %s is now tier %s, never refused', (key, tier) => {
    const c = classifyAction(...split(key))
    expect(c.tier).toBe(tier)
    expect(c.class).toEqual(tier === 'C' ? 'write' : expect.stringMatching(/^(write|sensitive)$/))
    if (tier === 'C') expect(c.danger).toBeTruthy()
  })

  it.each([
    ['EC2', 'DescribeInstances'],
    ['ec2', 'Describe Instances'],
    ['ec2', 'DescribeInstances;rm'],
    ['', ''],
    ['ec2', 'Command'],
    ['ec2/../iam', 'X'],
    ['ec2', 'describeInstances'],
    ['ec2', 'stopInstances']
  ])('only malformed names are refused outright: %s:%s', (service, action) => {
    expect(classifyAction(service, action)).toMatchObject({ class: 'invalid', tier: null })
  })

  it('refuses noncanonical spellings of classified actions', () => {
    for (const action of ['StopLogging', 'STOPLOGGING']) expect(classifyAction('cloudtrail', action)).toMatchObject({ class: 'write', tier: 'C' })
    expect(classifyAction('cloudtrail', 'stopLogging')).toMatchObject({ class: 'invalid', tier: null, reason: expect.stringContaining('PascalCase') })
    expect(classifyAction('secretsmanager', 'GetSecretValue').class).toBe('sensitive')
    expect(classifyAction('secretsmanager', 'GetSecretVALUE').class).toBe('invalid')
    expect(classifyAction('apigateway', 'GetAPIKeys').class).toBe('invalid')
    expect(classifyAction('apigateway', 'GetApiKEYS').class).toBe('invalid')
    expect(classifyAction('ec2', 'CreateKEYPair').tier).toBeNull()
    expect(classifyAction('s3', 'PutBucketACL').tier).toBeNull()
    expect(classifyAction('iam', 'CreateAccessKEY').tier).toBe('C')
    expect(classifyAction('ec2', 'GETInstances').tier).toBe(classifyAction('ec2', 'GetInstances').tier)
  })

  it.each([
    ['sqs', 'AddPermission'],
    ['sns', 'AddPermission'],
    ['events', 'PutPermission'],
    ['ecr', 'SetRepositoryPolicy'],
    ['secretsmanager', 'PutResourcePolicy']
  ])('a resource-policy grant %s:%s is tier C', (service, action) => {
    expect(classifyAction(service, action)).toMatchObject({ class: 'write', tier: 'C' })
  })

  it.each([
    ['apigateway', 'GetApiKeys'],
    ['ssm', 'GetCommandInvocation'],
    ['states', 'GetExecutionHistory'],
    ['ec2', 'GetVpnConnectionDeviceSampleConfiguration']
  ])('%s:%s (returns key values, command output, execution data) is sensitive: never "always allow"', (service, action) => {
    expect(classifyAction(service, action).class).toBe('sensitive')
  })

  it('keeps Cost Explorer (billed per request) out of tier A', () => {
    expect(READ_SERVICES).not.toContain('ce')
  })

  it('asks every time for sensitive reads on new services', () => {
    expect(classifyAction('newservice', 'GetSecretValue')).toMatchObject({ class: 'sensitive', tier: 'B' })
    expect(classifyAction('newservice', 'GetCredentials')).toMatchObject({ class: 'sensitive', tier: 'B' })
  })
})

describe('writeTier: params can make a write tier C', () => {
  it('a plain write is B; destructive names are flagged', () => {
    expect(writeTier('sqs', 'PurgeQueue', { QueueUrl: 'q' })).toEqual({ tier: 'B', dangers: [], destructive: true })
    expect(writeTier('sns', 'Publish', { TopicArn: 't', Message: 'hi' })).toEqual({ tier: 'B', dangers: [], destructive: false })
  })

  it('passing a role (any depth), a resource policy, IAM capabilities or the app role itself is C', () => {
    expect(writeTier('ecs', 'RegisterTaskDefinition', { family: 'x', containerDefinitions: [] }).tier).toBe('B')
    expect(writeTier('ecs', 'RegisterTaskDefinition', { family: 'x', containerDefinitions: [], taskRoleArn: 'arn:aws:iam::1:role/admin' }).tier).toBe('C')
    expect(writeTier('eks', 'CreateNodegroup', { clusterName: 'c', nodeRole: 'arn:aws:iam::1:role/n' }).tier).toBe('C')
    expect(writeTier('glue', 'CreateJob', { Command: { Name: 'x' }, Role: 'admin' }).dangers[0]).toContain('PassRole')
    expect(writeTier('sqs', 'SetQueueAttributes', { QueueUrl: 'q', Attributes: { Policy: '{}' } }).dangers[0]).toContain('资源策略')
    expect(writeTier('sns', 'SetTopicAttributes', { TopicArn: 't', AttributeName: 'Policy', AttributeValue: '{}' }).tier).toBe('C')
    expect(writeTier('cloudformation', 'CreateStack', { StackName: 's', Capabilities: ['CAPABILITY_NAMED_IAM'] }).dangers).toContain('CloudFormation 授予 CAPABILITY_IAM（模板可含 IAM 资源）')
    expect(writeTier('iam', 'TagRole', { RoleName: 'Admin', Tags: [] }, 'Admin').dangers[0]).toContain('本应用登录用的角色')
    expect(writeTier('iam', 'TagRole', { RoleName: 'Other', Tags: [] }, 'Admin').tier).toBe('B')
    expect(writeTier('iam', 'AttachRolePolicy', { RoleName: 'x', PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }).tier).toBe('C')
  })
})
