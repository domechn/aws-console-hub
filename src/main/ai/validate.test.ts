import { describe, expect, it } from 'vitest'
import {
  checkActionId,
  checkApiKey,
  checkAuditFilter,
  checkCardId,
  checkDeleteData,
  checkFormValues,
  checkId,
  checkPrompt,
  checkProposalId,
  checkApprovalId,
  checkApprovalDecision,
  checkAllowKey,
  checkProvider,
  checkRowId,
  checkTitle,
  checkTypedConfirmation,
  checkUrl,
  checkSearchQuery,
  checkFeedback,
  checkQueueId,
  MAX_PROMPT_CHARS,
  trustedSender
} from './validate'

describe('ai IPC validators', () => {
  it('checks card-action arguments by shape', () => {
    expect(checkCardId('c-0123456789ab')).toBe('c-0123456789ab')
    for (const bad of ['c-0123', 'C-0123456789AB', 'x', 1, null]) expect(() => checkCardId(bad)).toThrow()
    expect(checkActionId('stop_1')).toBe('stop_1')
    for (const bad of ['', 'a b', 'x'.repeat(33), {}]) expect(() => checkActionId(bad)).toThrow()
    expect(checkRowId(undefined)).toBeUndefined()
    expect(checkRowId(null)).toBeUndefined()
    expect(checkRowId('arn:aws:s3:::my.bucket/x')).toBe('arn:aws:s3:::my.bucket/x')
    for (const bad of ['', 'a b', 'x'.repeat(257), 5]) expect(() => checkRowId(bad)).toThrow()
    expect(checkFormValues({ name: 'web', count: 2, ok: true })).toEqual({ name: 'web', count: 2, ok: true })
    expect(checkFormValues(undefined)).toBeUndefined()
    const bad: unknown[] = [[], 'x', { n: { nested: 1 } }, { n: Number.NaN }, { n: 'x'.repeat(1001) }, { 'bad key': 1 }, { __proto__: { x: 1 } }, Object.create({ a: 1 })]
    bad.push(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, 1])))
    for (const v of bad) expect(() => checkFormValues(v), JSON.stringify(v)).toThrow()
  })

  it('accepts ids shaped like account and conversation uuids only', () => {
    expect(checkId('3f2b8c1e-0a4d-4c7e-9a51-2f6e8d1b7c90')).toBe('3f2b8c1e-0a4d-4c7e-9a51-2f6e8d1b7c90')
    for (const bad of ['', 'a b', '../x', 'x'.repeat(65), 1, null, undefined, {}]) expect(() => checkId(bad)).toThrow()
  })

  it('bounds prompts', () => {
    expect(checkPrompt('  列出 EC2  ')).toBe('列出 EC2')
    expect(checkPrompt('x'.repeat(MAX_PROMPT_CHARS))).toHaveLength(MAX_PROMPT_CHARS)
    for (const bad of ['', '   ', 'x'.repeat(MAX_PROMPT_CHARS + 1), 42, ['hi']]) expect(() => checkPrompt(bad)).toThrow()
  })

  it('bounds search, feedback and queue ids', () => {
    expect(checkSearchQuery(' CPU ')).toBe('CPU')
    expect(checkSearchQuery('', true)).toBe('')
    for (const bad of ['', 'x'.repeat(101), 'line\nbreak', 3]) expect(() => checkSearchQuery(bad)).toThrow()
    expect(checkFeedback(null)).toBeNull()
    expect(checkFeedback('up')).toBe('up')
    expect(() => checkFeedback('allow')).toThrow()
    expect(checkQueueId('01234567-89ab-cdef-0123-456789abcdef')).toBe('01234567-89ab-cdef-0123-456789abcdef')
    expect(() => checkQueueId('../x')).toThrow()
  })

  it('flattens titles to one bounded line', () => {
    expect(checkTitle(' a\nb\tc ')).toBe('a b c')
    for (const bad of ['', ' \n ', 'x'.repeat(101), null]) expect(() => checkTitle(bad)).toThrow()
  })

  it('accepts one-line printable keys', () => {
    expect(checkApiKey(' sk-abc123 ')).toBe('sk-abc123')
    // Short-term Bedrock API keys are a base64 presigned URL, well over 1000 characters.
    expect(checkApiKey(`bedrock-api-key-${'A'.repeat(2000)}`)).toHaveLength(2016)
    for (const bad of ['', 'sk abc', 'sk-\nabc', 'ключ', 'x'.repeat(4097), 5]) expect(() => checkApiKey(bad)).toThrow()
  })

  it('knows the offered providers', () => {
    expect(checkProvider('openrouter')).toBe('openrouter')
    expect(checkProvider('amazon-bedrock')).toBe('amazon-bedrock')
    for (const bad of ['google-vertex', '', null]) expect(() => checkProvider(bad)).toThrow()
  })

  it('bounds link URLs (main applies the URL policy itself)', () => {
    expect(checkUrl('https://ap-northeast-1.console.aws.amazon.com/ec2')).toBeTruthy()
    for (const bad of ['x'.repeat(4001), 1, null]) expect(() => checkUrl(bad)).toThrow()
  })
})

describe('proposal IPC arguments', () => {
  it('takes only main-shaped proposal ids', () => {
    expect(checkProposalId('p-0123456789ab')).toBe('p-0123456789ab')
    for (const bad of ['p-0123456789aB', 'p-0123', 'c-0123456789ab', '', 1, null, { id: 'p-0123456789ab' }]) expect(() => checkProposalId(bad)).toThrow('提案 id')
  })

  it('takes typed confirmation as one bounded line of text, never an object (no params from the renderer)', () => {
    expect(checkTypedConfirmation(undefined)).toBeUndefined()
    expect(checkTypedConfirmation(null)).toBeUndefined()
    expect(checkTypedConfirmation('prod-db-1')).toBe('prod-db-1')
    for (const bad of [{ InstanceIds: ['i-1'] }, ['i-1'], 42, 'a\nb', 'x'.repeat(301)]) expect(() => checkTypedConfirmation(bad)).toThrow('确认输入')
  })

  it('takes only main-shaped approval ids, a known decision, and a well-formed allow key (never params)', () => {
    expect(checkApprovalId('a-0123456789ab')).toBe('a-0123456789ab')
    for (const bad of ['a-0123456789aB', 'p-0123456789ab', 'a-0123', '', 1, null, { id: 'a-0123456789ab' }]) expect(() => checkApprovalId(bad)).toThrow('审批 id')
    for (const d of ['once', 'session', 'deny']) expect(checkApprovalDecision(d)).toBe(d)
    for (const bad of ['always', 'ALLOW', '', null, { decision: 'once', params: {} }, ['once']]) expect(() => checkApprovalDecision(bad)).toThrow('审批决定')
    expect(checkAllowKey('sqs:ListQueues:us-east-1')).toBe('sqs:ListQueues:us-east-1')
    for (const bad of ['sqs:ListQueues', 'SQS:ListQueues:us-east-1', 'sqs:listQueues:us-east-1', 'sqs:ListQueues:us-east-1:x', 'sqs:List Queues:us', 7]) expect(() => checkAllowKey(bad)).toThrow('允许记录')
  })

  it('accepts IPC only from the main window top frame', () => {
    const mainFrame = {}
    const webContents = { mainFrame }
    const win = { webContents }
    expect(trustedSender({ sender: webContents, senderFrame: mainFrame }, win)).toBe(true)
    expect(trustedSender({ sender: webContents, senderFrame: {} }, win)).toBe(false)
    expect(trustedSender({ sender: webContents, senderFrame: null }, win)).toBe(false)
    expect(trustedSender({ sender: webContents }, win)).toBe(false)
    expect(trustedSender({ sender: { mainFrame }, senderFrame: mainFrame }, win)).toBe(false)
  })
})

describe('audit viewer and data deletion arguments', () => {
  it('takes known filter keys with valid values only', () => {
    expect(checkAuditFilter(undefined)).toEqual({})
    expect(checkAuditFilter({ accountId: 'acc-1', days: 30, risk: 'high', scope: 'all' })).toEqual({ accountId: 'acc-1', days: 30, risk: 'high', scope: 'all' })
    for (const bad of [[], 'x', { extra: 1 }, { days: 0 }, { days: 1.5 }, { days: '7' }, { risk: 'severe' }, { scope: 'raw' }, { accountId: '../x' }, Object.create({ days: 1 })]) {
      expect(() => checkAuditFilter(bad), JSON.stringify(bad)).toThrow()
    }
  })

  it('needs a boolean scope and a short string phrase', () => {
    expect(checkDeleteData(false, undefined)).toEqual({ audit: false, typed: undefined })
    expect(checkDeleteData(true, '删除审计记录')).toEqual({ audit: true, typed: '删除审计记录' })
    expect(() => checkDeleteData('yes', undefined)).toThrow()
    expect(() => checkDeleteData(true, 'x'.repeat(51))).toThrow()
    expect(() => checkDeleteData(true, 5)).toThrow()
  })
})
