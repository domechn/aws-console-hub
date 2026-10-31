import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { MissingCommandError, runCredentialCommand } from './credentialCommand'
import type { AwsCredentials } from './credentialCommand'
import type { AwsAccount } from '../shared/types'

/**
 * Console federation: base credentials come from the account's credential
 * command (see credentialCommand.ts), assume-accounts chain an AssumeRole on
 * top, and the result is exchanged at the public signin.aws.amazon.com
 * federation endpoint for a console login URL the webview can load.
 */

/**
 * Role chaining (assuming a role with credentials that are themselves
 * temporary, which is what the credential command hands us) is capped at one
 * hour by STS. Asking for more just fails.
 */
const ASSUME_SESSION_SECONDS = 3600

/** The federation endpoint refuses a console session longer than 12 hours. */
const CONSOLE_SESSION_MAX_SECONDS = 43200

/** Reuse minted credentials until shortly before they expire. */
const CACHE_SAFETY_MS = 5 * 60_000
/** Keyed by account id; the command is kept alongside so editing it is a cache miss. */
const credentialCache = new Map<string, { creds: AwsCredentials; command?: string }>()

function cached(account: AwsAccount): AwsCredentials | null {
  const hit = credentialCache.get(account.id)
  if (hit && hit.command === account.command && Date.parse(hit.creds.Expiration) - CACHE_SAFETY_MS > Date.now()) {
    return hit.creds
  }
  return null
}

/** Thrown when a base account has no credential command yet; carries the account to edit. */
export class NeedsCommandError extends Error {
  constructor(readonly account: AwsAccount) {
    super(`「${account.name}」还没有设置凭证命令，请在编辑窗口里填写后重试`)
  }
}

async function getCredentials(account: AwsAccount, fresh: boolean): Promise<AwsCredentials> {
  if (!fresh) {
    const hit = cached(account)
    if (hit) return hit
  }
  let creds: AwsCredentials
  try {
    creds = await runCredentialCommand(account.command ?? '', {
      accountId: account.accountId,
      role: account.role,
      region: account.defaultRegion
    })
  } catch (err) {
    if (err instanceof MissingCommandError) throw new NeedsCommandError(account)
    throw new Error(`${account.name}：${err instanceof Error ? err.message : String(err)}`)
  }
  credentialCache.set(account.id, { creds, command: account.command })
  return creds
}

/** The federation endpoint is a plain HTTPS call; never let it hang the login. */
const FETCH_TIMEOUT_MS = 20_000

function truncate(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}

/**
 * How long a console session built from these credentials may last.
 *
 * `SessionDuration` is the only thing that decouples the console session from
 * the credentials behind it — without it the session dies exactly when the
 * credentials do. But AWS rejects the parameter for role-chained credentials,
 * which is what every assume-account has, so those sessions are stuck at the
 * one-hour chaining cap. `null` means "don't send the parameter".
 *
 * The value must also stay strictly below the assumed role's own maximum
 * session duration, and the credential window the command just handed us is the only
 * evidence of that maximum we have.
 */
export function consoleSessionSeconds(account: AwsAccount, creds: AwsCredentials): number | null {
  if (account.kind === 'assume') return null
  const remaining = Math.floor((Date.parse(creds.Expiration) - Date.now()) / 1000)
  const seconds = Math.min(CONSOLE_SESSION_MAX_SECONDS, remaining) - 60
  return seconds >= 900 ? seconds : null
}

export interface SigninToken {
  token: string
  /** ms epoch at which the console will start bouncing the user to sign-in. */
  expiresAt: number
}

export async function getSigninToken(
  creds: AwsCredentials,
  sessionSeconds: number | null
): Promise<SigninToken> {
  const session = encodeURIComponent(
    JSON.stringify({
      sessionId: creds.AccessKeyId,
      sessionKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken
    })
  )
  const endpoint = 'https://signin.aws.amazon.com/federation'

  if (sessionSeconds !== null) {
    const response = await fetch(
      `${endpoint}?Action=getSigninToken&SessionDuration=${sessionSeconds}&Session=${session}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    )
    if (response.ok) {
      const body = (await response.json()) as { SigninToken: string }
      return { token: body.SigninToken, expiresAt: Date.now() + sessionSeconds * 1000 }
    }
  }

  // No SessionDuration: the console session lasts exactly as long as the
  // credentials, so that expiry is the one to plan around.
  const response = await fetch(`${endpoint}?Action=getSigninToken&Session=${session}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`联邦登录失败：signin.aws.amazon.com 返回 ${response.status}`)
  }
  const body = (await response.json()) as { SigninToken: string }
  return { token: body.SigninToken, expiresAt: Date.parse(creds.Expiration) }
}

function stsClient(creds: AwsCredentials): STSClient {
  return new STSClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken
    }
  })
}

/** AssumeRole into `account` with `via`'s base credentials. Nothing is cached here. */
export async function assumeRole(base: AwsCredentials, account: AwsAccount, via: AwsAccount): Promise<AwsCredentials> {
  const roleArn = `arn:aws:iam::${account.accountId}:role/${account.role}`
  let result
  try {
    result = await stsClient(base).send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: 'aws-console-hub',
        DurationSeconds: ASSUME_SESSION_SECONDS
      })
    )
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `通过 ${via.name} assume ${roleArn} 失败。请确认该 role 存在且信任 ${via.accountId}。\n${truncate(detail)}`
    )
  }

  const c = result.Credentials
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
    throw new Error(`assume ${roleArn} 返回的凭证不完整`)
  }
  return {
    AccessKeyId: c.AccessKeyId,
    SecretAccessKey: c.SecretAccessKey,
    SessionToken: c.SessionToken,
    Expiration: c.Expiration.toISOString()
  }
}

export async function callerIdentity(creds: AwsCredentials): Promise<{ Account?: string; Arn?: string }> {
  const { Account, Arn } = await stsClient(creds).send(new GetCallerIdentityCommand({}))
  return { Account, Arn }
}

/** Assume the target account's role using the base account's credentials. */
async function getAssumedCredentials(
  account: AwsAccount,
  via: AwsAccount,
  fresh: boolean
): Promise<AwsCredentials> {
  if (!fresh) {
    const hit = cached(account)
    if (hit) return hit
  }

  // The base credentials can still come from the cache: a fresh AssumeRole gets
  // its full hour regardless of how much of the base session is left.
  const creds = await assumeRole(await getCredentials(via, false), account, via)
  credentialCache.set(account.id, { creds })
  return creds
}

/**
 * Credentials for any account kind. For assume-accounts, `via` is the
 * base account minting base credentials. `fresh` skips the cache, which
 * matters for console logins: a cached credential with five minutes left buys
 * a five-minute console session.
 */
export async function getAccountCredentials(
  account: AwsAccount,
  via: AwsAccount | undefined,
  fresh = false
): Promise<AwsCredentials> {
  if (account.kind === 'assume') {
    if (!via) throw new Error(`账号「${account.name}」没有关联的基础账号，请编辑后重新选择`)
    return getAssumedCredentials(account, via, fresh)
  }
  return getCredentials(account, fresh)
}

export interface ConsoleSession {
  /** Federation URL that signs in and lands on the requested destination. */
  url: string
  /** ms epoch at which the console session stops working. */
  expiresAt: number
}

/**
 * Mint a console login URL that signs in and lands on `destination`. It is read
 * only once the token is in hand, so a caller can retarget a slow login.
 */
export async function getLoginUrl(
  account: AwsAccount,
  via: AwsAccount | undefined,
  destination: () => string
): Promise<ConsoleSession> {
  const creds = await getAccountCredentials(account, via, true)
  const { token, expiresAt } = await getSigninToken(creds, consoleSessionSeconds(account, creds))
  return {
    url:
      'https://signin.aws.amazon.com/federation?Action=login' +
      '&Issuer=aws-console-hub' +
      `&Destination=${encodeURIComponent(destination())}` +
      `&SigninToken=${encodeURIComponent(token)}`,
    expiresAt
  }
}

export function consoleHome(region: string): string {
  return `https://${region}.console.aws.amazon.com/console/home?region=${region}`
}

export function clearCredentialCache(accountId: string): void {
  credentialCache.delete(accountId)
}
