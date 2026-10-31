/**
 * When to renew an account's console session in the background.
 *
 * AWS limits, which no client can get around:
 * - A console session can never outlive what the federation endpoint grants:
 *   at most 12 hours (`SessionDuration=43200`), and only for credentials that
 *   are not role-chained.
 * - Assume-accounts are role-chained (credential command → sts:AssumeRole), so
 *   STS caps them at 1 hour and the federation endpoint refuses
 *   `SessionDuration`; their console session ends with those credentials.
 * - An existing session cannot be extended. "Refreshing" means minting a new
 *   one (credential command + STS again) and letting the federation login
 *   overwrite the session cookies in the account's partition. That needs the
 *   credential command to keep working every time.
 */

/** Start renewing this long before the session lapses. */
export const REFRESH_LEAD_MS = 10 * 60_000
/** Back-off between attempts while renewing keeps failing (e.g. the command's login expired). */
export const REFRESH_RETRY_MS = 3 * 60_000
/** An account untouched for this long is left to expire instead of running the credential command every hour. */
export const REFRESH_IDLE_MS = 4 * 3600_000

export interface RefreshState {
  /** ms epoch at which the current console session lapses. */
  expiresAt: number
  /** Last time the user opened or navigated in the account. */
  lastUsedAt?: number
  /** Last background attempt, successful or not. */
  lastAttemptAt?: number
}

export function shouldRefresh(now: number, s: RefreshState): boolean {
  if (s.expiresAt - now > REFRESH_LEAD_MS) return false
  if (s.lastUsedAt === undefined || now - s.lastUsedAt > REFRESH_IDLE_MS) return false
  return s.lastAttemptAt === undefined || now - s.lastAttemptAt >= REFRESH_RETRY_MS
}
