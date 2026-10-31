import { describe, expect, it } from 'vitest'
import { compareDocuments, paramDocs, policyFacts } from './policyDoc'

const OWN = '123456789012'
const doc = (...Statement: Record<string, unknown>[]) => JSON.stringify({ Version: '2012-10-17', Statement })

describe('policyFacts', () => {
  it.each([
    ['Principal "*" without Condition', doc({ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }), { anyPrincipal: true, otherAccounts: [], conditions: [] }, 'Principal 是 *（任何主体），没有 Condition'],
    ['{ AWS: "*" } with a Condition', doc({ Effect: 'Allow', Principal: { AWS: '*' }, Action: 's3:GetObject', Condition: { StringEquals: { 'aws:SourceVpce': 'vpce-1' } } }), { anyPrincipal: true, conditions: ['StringEquals aws:SourceVpce'] }, '带 Condition：StringEquals aws:SourceVpce'],
    ['another account (ARN and bare id), own account ignored', doc({ Effect: 'Allow', Principal: { AWS: ['arn:aws:iam::111122223333:root', '444455556666', `arn:aws:iam::${OWN}:role/x`] }, Action: 'sqs:SendMessage' }), { anyPrincipal: false, otherAccounts: ['111122223333', '444455556666'] }, '主体里有其他账号 111122223333、444455556666'],
    ['wildcard actions', doc({ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: ['s3:*', 's3:Get*', 's3:ListBucket'] }), { wildcardActions: ['s3:*', 's3:Get*'], principals: ['Service:lambda.amazonaws.com'] }, 'Action 含通配符 s3:*、s3:Get*'],
    ['NotPrincipal / NotAction', doc({ Effect: 'Allow', NotPrincipal: { AWS: `arn:aws:iam::${OWN}:root` }, NotAction: 'iam:*' }), { notPrincipal: true, notAction: true }, '用的是 NotAction']
  ])('%s', (_name, input, statement, note) => {
    const f = policyFacts(input, OWN)!
    expect(f.statements[0]).toMatchObject(statement)
    expect(f.notes.join('\n')).toContain(note)
  })

  it('takes objects and JSON strings, a single statement object; anything else is not a policy', () => {
    expect(policyFacts({ Statement: { Effect: 'Deny', Principal: '*', Action: '*' } })?.statements[0]).toMatchObject({ effect: 'Deny', anyPrincipal: true, wildcardActions: ['*'] })
    expect(policyFacts('not json')).toBeNull()
    expect(policyFacts('{"a":1}')).toBeNull()
    expect(policyFacts(null)).toBeNull()
    // An owner-only policy has nothing to flag.
    expect(policyFacts(doc({ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${OWN}:root` }, Action: 's3:GetObject' }), OWN)?.notes).toEqual([])
  })
})

describe('compareDocuments', () => {
  it('says which principals, actions and conditions a new policy adds and removes, plus a field diff', () => {
    const before = doc({ Sid: 'Own', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${OWN}:root` }, Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'true' } } })
    const after = doc({ Sid: 'Pub', Effect: 'Allow', Principal: '*', Action: 's3:GetObject' })
    const c = compareDocuments(before, after, OWN)
    expect(c.policy).toMatchObject({
      statements: { before: 1, after: 1 },
      principals: { added: ['Allow · *'], removed: [`Allow · AWS:arn:aws:iam::${OWN}:root`] },
      actions: { added: ['Allow · s3:GetObject'], removed: ['Allow · s3:*'] },
      conditions: { added: [], removed: ['Allow · Bool aws:SecureTransport'] }
    })
    expect(c.policy?.notesAfter[0]).toContain('Principal 是 *')
    expect(c.diff.length).toBeGreaterThan(0)
  })

  it('no current document: everything is added; non-policy JSON gets only the field diff', () => {
    expect(compareDocuments(undefined, doc({ Effect: 'Allow', Principal: '*', Action: 'sns:Publish' })).policy?.principals.added).toEqual(['Allow · *'])
    const plain = compareDocuments('{"VisibilityTimeout":"30"}', '{"VisibilityTimeout":"60"}')
    expect(plain.policy).toBeUndefined()
    expect(plain.diff).toEqual([expect.objectContaining({ path: 'VisibilityTimeout', op: 'change' })])
  })
})

describe('paramDocs', () => {
  it('finds policy documents under policy keys or as any JSON string with a Statement, at depth', () => {
    const found = paramDocs({ Bucket: 'b', Policy: doc({ Effect: 'Allow', Principal: '*', Action: 's3:GetObject' }) }, OWN)
    expect(found).toEqual([{ path: 'Policy', facts: expect.objectContaining({ notes: [expect.stringContaining('Principal 是 *')] }) }])
    expect(paramDocs({ QueueUrl: 'q', Attributes: { Policy: doc({ Effect: 'Allow', Principal: { AWS: '111122223333' }, Action: 'sqs:*' }) } }, OWN)[0].path).toBe('Attributes.Policy')
    expect(paramDocs({ Message: 'hi', Tags: [{ Key: 'Policy', Value: 'x' }] })).toEqual([])
  })
})
