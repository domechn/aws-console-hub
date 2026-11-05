import { describe, expect, it } from 'vitest'
import { AI_CHANGE_SERVICES } from '../../../shared/ai'
import { dangerOf } from '../classify'
import { ADAPTERS, changeCatalog, lookupChange } from './registry'

const WRITE_TABLE = [
  'ec2:StartInstances',
  'ec2:StopInstances',
  'ec2:RebootInstances',
  'ec2:TerminateInstances',
  'ec2:ModifyInstanceAttribute',
  'ec2:CreateTags',
  'ec2:DeleteTags',
  'ec2:AuthorizeSecurityGroupIngress',
  'ec2:RevokeSecurityGroupIngress',
  'ec2:AuthorizeSecurityGroupEgress',
  'ec2:RevokeSecurityGroupEgress',
  'ec2:RunInstances',
  'rds:StopDBInstance',
  'rds:StartDBInstance',
  'rds:RebootDBInstance',
  'rds:DeleteDBInstance',
  'lambda:UpdateFunctionConfiguration',
  's3:PutBucketTagging',
  's3:PutBucketVersioning',
  's3:DeleteBucket',
  'ecs:UpdateService',
  'autoscaling:SetDesiredCapacity',
  'cloudformation:CreateChangeSet',
  'rds:ModifyDBInstance',
  'dynamodb:UpdateTable',
  's3:CreateBucket',
  'tag:TagResources',
  'tag:UntagResources',
  'ec2:CreateSnapshot',
  'ec2:ModifyVolume'
]

const FORBIDDEN = [
  // IAM privilege escalation, including the app's own role
  'iam:PutRolePolicy', 'iam:PutUserPolicy', 'iam:PutGroupPolicy', 'iam:AttachRolePolicy', 'iam:AttachUserPolicy', 'iam:AttachGroupPolicy',
  'iam:CreateAccessKey', 'iam:UpdateAssumeRolePolicy', 'iam:CreatePolicyVersion', 'iam:SetDefaultPolicyVersion', 'iam:AddUserToGroup',
  'iam:CreateLoginProfile', 'iam:UpdateLoginProfile', 'iam:CreateRole', 'iam:DeleteRole', 'iam:PassRole', 'iam:CreateInstanceProfile',
  'iam:AddRoleToInstanceProfile', 'iam:DeleteRolePolicy', 'iam:CreateUser',
  // audit and detection
  'cloudtrail:StopLogging', 'cloudtrail:DeleteTrail', 'cloudtrail:UpdateTrail', 'cloudtrail:PutEventSelectors',
  'guardduty:DeleteDetector', 'guardduty:UpdateDetector', 'guardduty:ArchiveFindings',
  'config:StopConfigurationRecorder', 'config:DeleteConfigurationRecorder', 'config:DeleteDeliveryChannel',
  'securityhub:DisableSecurityHub', 'access-analyzer:DeleteAnalyzer',
  // account and organization
  'organizations:LeaveOrganization', 'organizations:CreateAccount', 'account:CloseAccount', 'sts:AssumeRole', 'sts:GetSessionToken', 'sso:Logout', 'sso-admin:CreatePermissionSet',
  // keys and secrets
  'kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy', 'kms:CreateGrant', 'secretsmanager:DeleteSecret', 'secretsmanager:PutSecretValue',
  // remote execution and data plane
  'ssm:SendCommand', 'ssm:StartSession', 'ssm:PutParameter', 'ec2-instance-connect:SendSSHPublicKey', 'lambda:Invoke', 'lambda:UpdateFunctionCode', 'lambda:CreateFunction',
  // exposure
  's3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:PutBucketAcl', 's3:PutPublicAccessBlock', 's3:DeletePublicAccessBlock', 's3:DeleteObjects',
  'ec2:ModifySnapshotAttribute', 'ec2:ModifyImageAttribute', 'ec2:CreateKeyPair', 'ec2:AssociateIamInstanceProfile', 'ec2:ModifyInstanceMetadataOptions',
  'rds:ModifyDBSnapshotAttribute', 'lambda:AddPermission', 'lambda:CreateFunctionUrlConfig',
  // cloudformation outside the change-set flow
  'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteStack'
]

const UNSUPPORTED = [
  'ec2:DeleteVpc', 'ec2:CreateVolume', 'ec2:DeleteSnapshot', 'ec2:DeleteVolume', 'ec2:AllocateAddress', 'ec2:ModifyVpcAttribute', 'rds:ModifyDBCluster', 'rds:DeleteDBCluster',
  'dynamodb:DeleteTable', 'dynamodb:DeleteBackup', 'sqs:DeleteQueue', 'sns:Publish', 'route53:ChangeResourceRecordSets', 'eks:DeleteCluster',
  'ecs:DeleteService', 'ecs:RunTask', 'autoscaling:UpdateAutoScalingGroup', 'autoscaling:DeleteAutoScalingGroup', 's3:PutBucketEncryption',
  'lambda:DeleteFunction', 'tag:TagResource', 'tag:GetResources', 'cloudformation:UpdateStack', 'cloudformation:CreateStack', 'elasticloadbalancing:DeleteLoadBalancer', 'made-up:Anything'
]

describe('account policy services', () => {
  it('offers exactly the services the write table has', () => {
    expect(AI_CHANGE_SERVICES.map((s) => s.id).filter((id) => id !== 'other').sort()).toEqual([...new Set(ADAPTERS.map((a) => a.service))].sort())
    expect(AI_CHANGE_SERVICES.at(-1)?.id).toBe('other')
  })
})

describe('write lookup (adapter, generic, or a read)', () => {
  it.each(['ModifyDbInstance', 'DeleteDbInstance'])('refuses noncanonical RDS adapter spelling %s', (action) => {
    expect(lookupChange('rds', action)).toEqual({
      refused: 'invalid', reason: expect.stringContaining(`请使用 ${action.replace('Db', 'DB')}`)
    })
  })
  it('knows exactly the write table', () => {
    expect(ADAPTERS.map((a) => `${a.service}:${a.action}`).sort()).toEqual([...WRITE_TABLE].sort())
    for (const key of WRITE_TABLE) {
      const [service, action] = key.split(':')
      expect(lookupChange(service, action), key).toHaveProperty('adapter')
    }
  })

  // M3 / M4 refused these outright; now they go to the generic card (tier C for the danger table: classify.test.ts).
  it.each(FORBIDDEN.filter((k) => !k.startsWith('sts:')))('sends old forbidden %s to the generic adapter', (key) => {
    const [service, action] = key.split(':')
    expect(lookupChange(service, action)).toEqual({ generic: true })
  })

  it.each(UNSUPPORTED.filter((k) => k !== 'tag:GetResources'))('sends %s (no adapter) to the generic adapter', (key) => {
    const [service, action] = key.split(':')
    expect(lookupChange(service, action)).toEqual({ generic: true })
  })

  it('points reads (credential-issuing STS calls included) to aws_read', () => {
    for (const key of ['tag:GetResources', 'sts:AssumeRole', 'sts:GetSessionToken', 'ec2:DescribeInstances', 's3:GetObject']) {
      const [service, action] = key.split(':')
      expect(lookupChange(service, action), key).toMatchObject({ refused: 'read', reason: expect.stringContaining('aws_read') })
    }
  })

  it('refuses malformed names and non-strings', () => {
    for (const [s, a] of [['', 'StopInstances'], ['ec2', ''], ['EC2', 'StopInstances'], ['ec2', 'Stop Instances'], ['ec2', 'Stop;Instances'], [1, 2], [null, undefined], ['ec2/../iam', 'X']]) {
      expect(lookupChange(s, a)).toMatchObject({ refused: 'invalid' })
    }
  })

  it('no adapter is also on the danger list, every schema refuses unknown params, every adapter documents its params', () => {
    for (const a of ADAPTERS) {
      expect(dangerOf(a.service, a.action), a.action).toBeNull()
      expect((a.schema as { additionalProperties?: boolean }).additionalProperties, a.action).toBe(false)
      expect(a.doc.length).toBeGreaterThan(5)
    }
    expect(changeCatalog().split('\n')).toHaveLength(ADAPTERS.length)
  })

  it('Lambda create and S3 public-access changes have no adapter and are tier C (CreateBucket sets the block internally)', () => {
    expect(lookupChange('lambda', 'CreateFunction')).toEqual({ generic: true })
    expect(dangerOf('lambda', 'CreateFunction')).toBeTruthy()
    expect(dangerOf('lambda', 'DeleteFunction')).toBeNull()
    for (const action of ['PutPublicAccessBlock', 'DeletePublicAccessBlock', 'PutBucketPolicy', 'PutBucketAcl']) {
      expect(lookupChange('s3', action)).toEqual({ generic: true })
      expect(dangerOf('s3', action)).toBeTruthy()
    }
  })

  it('every adapter without DryRun or a change set names the ARNs the permission pre-check simulates against', () => {
    const missing = ADAPTERS.filter((a) => !a.dryRun && !a.prepare && !a.arns).map((a) => `${a.service}:${a.action}`)
    // ASG: the policy simulation runs against "*" (the group ARN needs a lookup of its uuid).
    expect(missing).toEqual(['autoscaling:SetDesiredCapacity'])
  })
})
