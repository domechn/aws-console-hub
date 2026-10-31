import { app } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from './store'
import { ACCOUNT_ID_RE, REGION_RE, ROLE_RE, checkCommand } from './credentialCommand'
import type { AwsAccount } from '../shared/types'
import { AI_CHANGE_SERVICES, RISK_LEVELS } from '../shared/ai'

const COLORS = ['#e06c75', '#61afef', '#98c379', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66', '#7f9cf5']

export class AccountStore {
  private file = path.join(app.getPath('userData'), 'accounts.json')
  private accounts: AwsAccount[]

  constructor() {
    this.accounts = readJson<AwsAccount[]>(this.file, [])
    // Anything but an assume-account is a base account, including entries saved
    // by older versions. Those had no credential command; opening one asks for it.
    let migrated = false
    for (const account of this.accounts) {
      if (account.kind === 'assume' || (account.kind === 'base' && typeof account.command === 'string')) continue
      account.kind = 'base'
      if (typeof account.command !== 'string') account.command = ''
      migrated = true
    }
    if (migrated) writeJson(this.file, this.accounts)
  }

  list(): AwsAccount[] {
    return this.accounts
  }

  get(id: string): AwsAccount | undefined {
    return this.accounts.find((a) => a.id === id)
  }

  /** Assume-accounts that log in through the given base account. */
  dependents(baseId: string): AwsAccount[] {
    return this.accounts.filter((a) => a.viaId === baseId)
  }

  save(input: Partial<AwsAccount>): AwsAccount {
    const existing = input.id ? this.get(input.id) : undefined
    const account = this.draft(input)
    if (existing) Object.assign(existing, account)
    else this.accounts.push(account)
    writeJson(this.file, this.accounts)
    return existing ?? account
  }

  /** The account `save(input)` would store, validated the same way, without storing it. */
  draft(input: Partial<AwsAccount>): AwsAccount {
    const existing = input.id ? this.get(input.id) : undefined
    if (input.id && !existing) throw new Error(`account not found: ${input.id}`)
    const account: AwsAccount = existing
      ? {
          ...existing,
          name: input.name ?? existing.name,
          accountId: input.accountId ?? existing.accountId,
          role: input.role ?? existing.role,
          defaultRegion: input.defaultRegion ?? existing.defaultRegion,
          viaId: existing.kind === 'assume' ? (input.viaId ?? existing.viaId) : existing.viaId,
          command: existing.kind === 'base' ? (input.command ?? existing.command) : undefined,
          aiAllowWrite: input.aiAllowWrite ?? existing.aiAllowWrite,
          production: input.production ?? existing.production,
          // Present but undefined (or null) clears them: "all services", "no ceiling".
          aiServices: 'aiServices' in input ? (input.aiServices ?? undefined) : existing.aiServices,
          aiMaxRisk: 'aiMaxRisk' in input ? (input.aiMaxRisk ?? undefined) : existing.aiMaxRisk
        }
      : {
          id: randomUUID(),
          kind: input.kind === 'assume' ? 'assume' : 'base',
          name: input.name || input.accountId || 'Account',
          accountId: input.accountId ?? '',
          role: input.role ?? '',
          viaId: input.kind === 'assume' ? input.viaId : undefined,
          command: input.kind === 'assume' ? undefined : (input.command ?? ''),
          defaultRegion: input.defaultRegion || 'us-east-1',
          color: COLORS[this.accounts.length % COLORS.length],
          aiAllowWrite: input.aiAllowWrite,
          production: input.production,
          aiServices: input.aiServices ?? undefined,
          aiMaxRisk: input.aiMaxRisk ?? undefined
        }
    this.validate(account)
    return account
  }

  /** The renderer is untrusted input: these values end up in a shell command, ARNs and hostnames. */
  private validate(a: AwsAccount): void {
    if (typeof a.name !== 'string') throw new Error('无效的账号名称')
    if (!ACCOUNT_ID_RE.test(a.accountId)) throw new Error(`无效的账号 ID：${a.accountId}`)
    if (!ROLE_RE.test(a.role)) throw new Error(`无效的 role：${a.role}`)
    if (!REGION_RE.test(a.defaultRegion)) throw new Error(`无效的 region：${a.defaultRegion}`)
    if (a.kind === 'base' && !checkCommand(a.command).trim()) throw new Error('请填写凭证命令')
    if (a.aiAllowWrite !== undefined && typeof a.aiAllowWrite !== 'boolean') throw new Error('无效的 AI 变更设置')
    if (a.production !== undefined && typeof a.production !== 'boolean') throw new Error('无效的生产账号设置')
    if (a.aiServices !== undefined) {
      const known = AI_CHANGE_SERVICES.map((s) => s.id)
      if (!Array.isArray(a.aiServices) || a.aiServices.some((s) => !known.includes(s))) throw new Error('无效的 AI 服务列表')
      a.aiServices = known.filter((s) => a.aiServices?.includes(s))
    }
    if (a.aiMaxRisk !== undefined && !RISK_LEVELS.includes(a.aiMaxRisk)) throw new Error('无效的 AI 风险上限')
    if (a.kind === 'assume' && this.get(a.viaId ?? '')?.kind !== 'base') {
      throw new Error('请选择一个基础账号')
    }
  }

  remove(id: string): void {
    this.accounts = this.accounts.filter((a) => a.id !== id)
    writeJson(this.file, this.accounts)
  }
}
