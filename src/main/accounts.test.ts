import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const { AccountStore } = await import('./accounts')

const file = path.join(dir, 'accounts.json')
const stored = (): Array<Record<string, unknown>> => JSON.parse(fs.readFileSync(file, 'utf8'))
const fields = { accountId: '111122223333', role: 'Admin', defaultRegion: 'us-east-1' }

describe('AccountStore', () => {
  beforeEach(() => fs.rmSync(file, { force: true }))

  it('migrates every non-assume account to a base account without a command', () => {
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: 'old', kind: 'legacy-kind', name: 'old', ...fields, color: '#fff' },
        { id: 'oldest', name: 'oldest', ...fields, color: '#fff' },
        { id: 'jump', kind: 'assume', viaId: 'old', name: 'jump', ...fields, color: '#fff' }
      ])
    )
    const store = new AccountStore()
    expect(store.list().map((a) => [a.kind, a.command])).toEqual([
      ['base', ''],
      ['base', ''],
      ['assume', undefined]
    ])
    expect(stored().map((a) => a.kind)).toEqual(['base', 'base', 'assume'])
  })

  it('requires a valid credential command for base accounts', () => {
    const store = new AccountStore()
    expect(() => store.save({ kind: 'base', ...fields })).toThrow('凭证命令')
    expect(() => store.save({ kind: 'base', ...fields, command: 'a\nb' })).toThrow('一行')
    const base = store.save({ kind: 'base', ...fields, command: 'helper --role {role}' })
    expect(base.command).toBe('helper --role {role}')

    // Assume-accounts never carry a command, even if the renderer sends one.
    const jump = store.save({ kind: 'assume', ...fields, viaId: base.id, command: 'x' })
    expect(jump.command).toBeUndefined()
  })

  it('lets a migrated account be fixed by setting its command', () => {
    fs.writeFileSync(file, JSON.stringify([{ id: 'old', kind: 'legacy-kind', name: 'old', ...fields, color: '#fff' }]))
    const store = new AccountStore()
    expect(() => store.save({ id: 'old', name: 'renamed' })).toThrow('凭证命令')
    expect(store.save({ id: 'old', command: 'helper' }).command).toBe('helper')
    expect(stored()[0].command).toBe('helper')
  })

  it('stores the AI write switch per account, off unless set, without touching the login', () => {
    const store = new AccountStore()
    const base = store.save({ kind: 'base', ...fields, command: 'helper' })
    expect(base.aiAllowWrite).toBeUndefined()
    expect(store.save({ id: base.id, aiAllowWrite: true }).aiAllowWrite).toBe(true)
    expect(store.save({ id: base.id, name: 'renamed' }).aiAllowWrite).toBe(true)
    expect(new AccountStore().get(base.id)?.aiAllowWrite).toBe(true)
    expect(() => store.save({ id: base.id, aiAllowWrite: 'yes' as unknown as boolean })).toThrow('AI')
  })

  it('stores the production flag, off unless set, and rejects non-booleans', () => {
    const store = new AccountStore()
    const base = store.save({ kind: 'base', ...fields, command: 'helper' })
    expect(base.production).toBeUndefined()
    expect(store.save({ id: base.id, production: true }).production).toBe(true)
    expect(store.save({ id: base.id, aiAllowWrite: false }).production).toBe(true)
    expect(new AccountStore().get(base.id)?.production).toBe(true)
    expect(store.save({ id: base.id, production: false }).production).toBe(false)
    expect(() => store.save({ id: base.id, production: 1 as unknown as boolean })).toThrow('生产')
  })

  it('stores the AI policy (service allowlist, risk ceiling), clears it on an explicit undefined, rejects unknowns', () => {
    const store = new AccountStore()
    const base = store.save({ kind: 'base', ...fields, command: 'helper' })
    expect(base.aiServices).toBeUndefined()
    expect(store.save({ id: base.id, aiServices: ['s3', 'ec2', 'ec2'], aiMaxRisk: 'high' })).toMatchObject({ aiServices: ['ec2', 's3'], aiMaxRisk: 'high' })
    expect(store.save({ id: base.id, name: 'renamed' })).toMatchObject({ aiServices: ['ec2', 's3'], aiMaxRisk: 'high' })
    expect(new AccountStore().get(base.id)).toMatchObject({ aiServices: ['ec2', 's3'], aiMaxRisk: 'high' })
    expect(store.save({ id: base.id, aiServices: [] }).aiServices).toEqual([])
    const cleared = store.save({ id: base.id, aiServices: undefined, aiMaxRisk: undefined })
    expect(cleared.aiServices).toBeUndefined()
    expect(cleared.aiMaxRisk).toBeUndefined()
    expect(() => store.save({ id: base.id, aiServices: ['iam'] })).toThrow('AI 服务')
    expect(() => store.save({ id: base.id, aiServices: 'ec2' as never })).toThrow('AI 服务')
    expect(() => store.save({ id: base.id, aiMaxRisk: 'none' as never })).toThrow('风险上限')
  })

  it('validates a draft like save without storing it', () => {
    const store = new AccountStore()
    const base = store.save({ kind: 'base', ...fields, command: 'helper' })
    expect(() => store.draft({ kind: 'base', ...fields, role: 'a b', command: 'x' })).toThrow('role')
    expect(() => store.draft({ kind: 'assume', ...fields, viaId: 'missing' })).toThrow('基础账号')
    expect(store.draft({ id: base.id, command: 'other' }).command).toBe('other')
    expect(store.get(base.id)?.command).toBe('helper')
    expect(stored()).toHaveLength(1)
  })
})
