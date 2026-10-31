import { afterEach, describe, expect, it, vi } from 'vitest'
import { STEP_TIMEOUT_MS, formatDuration, identityMismatch, testConnection } from './connectionTest'
import type { ConnectionTestDeps } from './connectionTest'
import type { AwsAccount } from '../shared/types'

const NOW = Date.parse('2030-01-01T00:00:00Z')
const HOUR = 3600_000
const creds = (secret: string, expiresIn = HOUR) => ({
  AccessKeyId: 'AKIA',
  SecretAccessKey: secret,
  SessionToken: 'token',
  Expiration: new Date(NOW + expiresIn).toISOString()
})

const base: AwsAccount = {
  id: 'b',
  kind: 'base',
  name: '基础',
  accountId: '111111111111',
  role: 'Admin',
  command: 'helper',
  defaultRegion: 'us-east-1',
  color: '#000'
}
const target: AwsAccount = { ...base, id: 't', kind: 'assume', name: 'prod', accountId: '222222222222', role: 'ReadOnly', viaId: 'b', command: undefined }

function deps(overrides: Partial<ConnectionTestDeps> = {}): ConnectionTestDeps {
  return {
    now: () => NOW,
    runCommand: vi.fn(async () => creds('base-secret', 12 * HOUR)),
    assumeRole: vi.fn(async () => creds('assumed-secret')),
    callerIdentity: vi.fn(async (c) =>
      c.SecretAccessKey === 'assumed-secret'
        ? { Account: '222222222222', Arn: 'arn:aws:sts::222222222222:assumed-role/ReadOnly/aws-console-hub' }
        : { Account: '111111111111', Arn: 'arn:aws:sts::111111111111:assumed-role/Admin/me' }
    ),
    signinToken: vi.fn(async () => ({ expiresAt: NOW + HOUR - 60_000 })),
    ...overrides
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('identityMismatch', () => {
  it('accepts the entered account and role, ignoring role paths and case', () => {
    const arn = 'arn:aws:sts::111111111111:assumed-role/Admin/session'
    expect(identityMismatch(base, { Account: '111111111111', Arn: arn })).toBeNull()
    expect(identityMismatch({ ...base, role: 'team/admin' }, { Account: '111111111111', Arn: arn })).toBeNull()
  })

  it('names the actual account or ARN on a mismatch', () => {
    expect(identityMismatch(base, { Account: '999999999999', Arn: 'arn:x' })).toContain('实际是 999999999999')
    expect(
      identityMismatch(base, { Account: '111111111111', Arn: 'arn:aws:sts::111111111111:assumed-role/Dev/s' })
    ).toContain('实际是 arn:aws:sts::111111111111:assumed-role/Dev/s')
  })
})

describe('formatDuration', () => {
  it('rounds to five minutes', () => {
    expect(formatDuration(HOUR - 60_000)).toBe('约 1 小时')
    expect(formatDuration(12 * HOUR - 60_000)).toBe('约 12 小时')
    expect(formatDuration(45 * 60_000)).toBe('约 45 分钟')
    expect(formatDuration(HOUR + 30 * 60_000)).toBe('约 1 小时 30 分钟')
  })
})

describe('testConnection', () => {
  it('runs command, identity and federation for a base account', async () => {
    const d = deps({ signinToken: vi.fn(async () => ({ expiresAt: NOW + 12 * HOUR - 60_000 })) })
    const progress: string[] = []
    const steps = await testConnection(base, undefined, d, (s) => progress.push(s.map((x) => x.status).join(',')))
    expect(steps.map((s) => [s.id, s.status])).toEqual([
      ['command', 'ok'],
      ['identity', 'ok'],
      ['federation', 'ok']
    ])
    expect(steps[0].detail).toContain('剩余约 12 小时')
    expect(steps[2].detail).toBe('Console 会话约 12 小时')
    expect(d.runCommand).toHaveBeenCalledWith(base)
    expect(progress[0]).toBe('running,pending,pending')
    expect(progress.at(-1)).toBe('ok,ok,ok')
    expect(JSON.stringify(steps)).not.toContain('secret')
  })

  it('assumes the role with the base credentials and checks the assumed identity', async () => {
    const d = deps()
    const steps = await testConnection(target, base, d)
    expect(steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(steps[0].label).toContain('基础')
    expect(steps[1].detail).toBe('arn:aws:iam::222222222222:role/ReadOnly')
    expect(d.runCommand).toHaveBeenCalledWith(base)
    expect(d.assumeRole).toHaveBeenCalledWith(expect.objectContaining({ SecretAccessKey: 'base-secret' }), target, base)
    expect(d.signinToken).toHaveBeenCalledWith(target, expect.objectContaining({ SecretAccessKey: 'assumed-secret' }))
    expect(steps[3].detail).toBe('Console 会话约 1 小时')
  })

  it('skips everything after the first failure', async () => {
    const d = deps({ assumeRole: vi.fn(async () => Promise.reject(new Error('AccessDenied: not trusted'))) })
    const steps = await testConnection(target, base, d)
    expect(steps.map((s) => s.status)).toEqual(['ok', 'fail', 'skipped', 'skipped'])
    expect(steps[1].detail).toBe('AccessDenied: not trusted')
    expect(d.callerIdentity).not.toHaveBeenCalled()
  })

  it('fails the identity step when the credentials belong elsewhere', async () => {
    const d = deps({ callerIdentity: vi.fn(async () => ({ Account: '333333333333', Arn: 'arn:aws:sts::333333333333:assumed-role/Admin/x' })) })
    const steps = await testConnection(base, undefined, d)
    expect(steps.map((s) => s.status)).toEqual(['ok', 'fail', 'skipped'])
    expect(steps[1].detail).toContain('实际是 333333333333')
  })

  it('times a hanging step out', async () => {
    vi.useFakeTimers()
    const d = deps({ runCommand: () => new Promise(() => {}) })
    const result = testConnection(base, undefined, d)
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS.command)
    const steps = await result
    expect(steps[0]).toMatchObject({ status: 'fail', detail: '超时（60 秒）' })
    expect(steps.slice(1).every((s) => s.status === 'skipped')).toBe(true)
  })

  it('fails an assume account without a base account', async () => {
    const steps = await testConnection(target, undefined, deps())
    expect(steps[0]).toMatchObject({ status: 'fail', detail: '请选择一个基础账号' })
  })
})
