import { describe, expect, it } from 'vitest'
import { REFRESH_IDLE_MS, REFRESH_LEAD_MS, REFRESH_RETRY_MS, shouldRefresh } from './refresh'

const now = 1_000_000_000_000
const min = 60_000

describe('shouldRefresh', () => {
  it('waits until the session is close to lapsing', () => {
    expect(shouldRefresh(now, { expiresAt: now + REFRESH_LEAD_MS + min, lastUsedAt: now })).toBe(false)
    expect(shouldRefresh(now, { expiresAt: now + REFRESH_LEAD_MS - min, lastUsedAt: now })).toBe(true)
    // Already lapsed (e.g. after sleep) but in use: still worth renewing.
    expect(shouldRefresh(now, { expiresAt: now - min, lastUsedAt: now - min })).toBe(true)
  })

  it('leaves idle or never-used accounts to expire', () => {
    expect(shouldRefresh(now, { expiresAt: now + min })).toBe(false)
    expect(shouldRefresh(now, { expiresAt: now + min, lastUsedAt: now - REFRESH_IDLE_MS - min })).toBe(false)
  })

  it('backs off between attempts', () => {
    const base = { expiresAt: now + min, lastUsedAt: now }
    expect(shouldRefresh(now, { ...base, lastAttemptAt: now - min })).toBe(false)
    expect(shouldRefresh(now, { ...base, lastAttemptAt: now - REFRESH_RETRY_MS })).toBe(true)
  })
})
