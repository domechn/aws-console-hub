import type { AwsCredentials } from './credentialCommand'
import type { AwsAccount, ConnectionTestStep } from '../shared/types'

/**
 * The account modal's 「测试连接」: every step a real login takes, run on
 * unsaved values and reported one by one, without opening a console. The
 * AWS calls are injected (see index.ts) so this stays pure and testable; none
 * of them may touch the real credential cache. Step details are shown in the
 * renderer, so they only ever hold expiries, ARNs and error messages.
 */

export interface ConnectionTestDeps {
  /** Run a base account's credential command, fresh and uncached. */
  runCommand(base: AwsAccount): Promise<AwsCredentials>
  assumeRole(base: AwsCredentials, account: AwsAccount, via: AwsAccount): Promise<AwsCredentials>
  callerIdentity(creds: AwsCredentials): Promise<{ Account?: string; Arn?: string }>
  /** getSigninToken as a real login asks for it; resolves to when that console session would end (ms epoch). */
  signinToken(account: AwsAccount, creds: AwsCredentials): Promise<{ expiresAt: number }>
  now?: () => number
}

/** The command has its own 45 s limit plus the PATH probe; the federation step may fetch twice. */
export const STEP_TIMEOUT_MS: Record<ConnectionTestStep['id'], number> = {
  command: 60_000,
  assume: 20_000,
  identity: 20_000,
  federation: 45_000
}

export function planSteps(account: AwsAccount, via: AwsAccount | undefined): ConnectionTestStep[] {
  const assume = account.kind === 'assume'
  const steps: ConnectionTestStep[] = [
    { id: 'command', label: assume ? `执行凭证命令（${via?.name ?? '?'}）` : '执行凭证命令', status: 'pending' }
  ]
  if (assume) steps.push({ id: 'assume', label: 'AssumeRole', status: 'pending' })
  steps.push({ id: 'identity', label: '身份校验', status: 'pending' }, { id: 'federation', label: '联邦登录', status: 'pending' })
  return steps
}

/** Why GetCallerIdentity's answer is not the account that was entered, or null when it is. */
export function identityMismatch(account: AwsAccount, identity: { Account?: string; Arn?: string }): string | null {
  const arn = identity.Arn ?? ''
  if (identity.Account !== account.accountId) {
    return `账号不符：实际是 ${identity.Account ?? '未知账号'}${arn && `（${arn}）`}`
  }
  // assumed-role ARNs drop the role's path: arn:aws:sts::123:assumed-role/Admin/session
  const name = (account.role.split('/').pop() ?? '').toLowerCase()
  if (!arn.toLowerCase().split(/[:/]/).includes(name)) return `身份不是 role ${account.role}：实际是 ${arn || '未知'}`
  return null
}

/** "约 1 小时" / "约 11 小时 30 分钟" / "约 45 分钟", to the nearest 5 minutes. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(5, Math.round(ms / 300_000) * 5)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `约 ${[h && `${h} 小时`, m && `${m} 分钟`].filter(Boolean).join(' ')}`
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超时（${ms / 1000} 秒）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Run the steps in order. `onProgress` gets a snapshot after each change;
 * the first failure marks every later step skipped.
 */
export async function testConnection(
  account: AwsAccount,
  via: AwsAccount | undefined,
  deps: ConnectionTestDeps,
  onProgress: (steps: ConnectionTestStep[]) => void = () => {}
): Promise<ConnectionTestStep[]> {
  const now = deps.now ?? Date.now
  const steps = planSteps(account, via)
  const snapshot = (): ConnectionTestStep[] => steps.map((s) => ({ ...s }))
  let creds: AwsCredentials | undefined

  const run: Record<ConnectionTestStep['id'], () => Promise<string>> = {
    command: async () => {
      const base = account.kind === 'assume' ? via : account
      if (!base) throw new Error('请选择一个基础账号')
      creds = await deps.runCommand(base)
      const expiration = Date.parse(creds.Expiration)
      return `凭证有效期至 ${formatTime(expiration)}（剩余${formatDuration(expiration - now())}）`
    },
    assume: async () => {
      creds = await deps.assumeRole(creds!, account, via!)
      return `arn:aws:iam::${account.accountId}:role/${account.role}`
    },
    identity: async () => {
      const identity = await deps.callerIdentity(creds!)
      const mismatch = identityMismatch(account, identity)
      if (mismatch) throw new Error(mismatch)
      return identity.Arn ?? ''
    },
    federation: async () => {
      const { expiresAt } = await deps.signinToken(account, creds!)
      return `Console 会话${formatDuration(expiresAt - now())}`
    }
  }

  for (const [i, step] of steps.entries()) {
    step.status = 'running'
    onProgress(snapshot())
    try {
      step.detail = await withTimeout(run[step.id](), STEP_TIMEOUT_MS[step.id])
      step.status = 'ok'
    } catch (err) {
      step.status = 'fail'
      step.detail = err instanceof Error ? err.message : String(err)
      for (const later of steps.slice(i + 1)) later.status = 'skipped'
      break
    }
  }
  onProgress(snapshot())
  return snapshot()
}
