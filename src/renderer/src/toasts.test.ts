import { describe, expect, it } from 'vitest'
import {
  EMPTY_TOASTS,
  MAX_TOASTS,
  TOAST_TTL_MS,
  addToast,
  dismissToast,
  expireToasts,
  nextExpiry,
  pauseToasts,
  resumeToasts
} from './toasts'

const err = (message: string) => ({ kind: 'error' as const, message })

describe('toast queue', () => {
  it('stacks newest first and keeps at most three', () => {
    let s = EMPTY_TOASTS
    for (let i = 1; i <= 4; i++) s = addToast(s, err(`e${i}`), i, i)
    expect(s.toasts.map((t) => t.message)).toEqual(['e4', 'e3', 'e2'])
    expect(s.toasts).toHaveLength(MAX_TOASTS)
  })

  it('dedupes a repeat: same id, counted, moved to the top, timer reset', () => {
    let s = addToast(EMPTY_TOASTS, err('a'), 1, 0)
    s = addToast(s, err('b'), 2, 10)
    s = addToast(s, err('a'), 3, 1000)
    expect(s.toasts.map((t) => [t.id, t.message, t.count])).toEqual([
      [1, 'a', 2],
      [2, 'b', 1]
    ])
    expect(s.toasts[0].expiresAt).toBe(1000 + TOAST_TTL_MS)
    // Same text, different kind: a different toast.
    expect(addToast(s, { kind: 'info', message: 'a' }, 4, 1000).toasts).toHaveLength(3)
  })

  it('expires each toast after its own ttl', () => {
    let s = addToast(EMPTY_TOASTS, err('a'), 1, 0)
    s = addToast(s, err('b'), 2, 2000)
    expect(nextExpiry(s)).toBe(TOAST_TTL_MS)
    s = expireToasts(s, TOAST_TTL_MS)
    expect(s.toasts.map((t) => t.message)).toEqual(['b'])
    expect(expireToasts(s, 2000 + TOAST_TTL_MS).toasts).toEqual([])
    expect(nextExpiry(EMPTY_TOASTS)).toBeNull()
  })

  it('freezes every timer while hovered', () => {
    let s = addToast(EMPTY_TOASTS, err('a'), 1, 0)
    s = pauseToasts(s, 5000)
    expect(nextExpiry(s)).toBeNull()
    expect(expireToasts(s, 60_000).toasts).toHaveLength(1)
    // Arrived during the hover: its clock starts at the resume.
    s = addToast(s, err('b'), 2, 7000)
    s = resumeToasts(s, 20_000)
    expect(s.toasts.find((t) => t.message === 'a')?.expiresAt).toBe(20_000 + 3000)
    expect(s.toasts.find((t) => t.message === 'b')?.expiresAt).toBe(20_000 + TOAST_TTL_MS)
  })

  it('dismisses by id and resumes the timers', () => {
    let s = addToast(EMPTY_TOASTS, err('a'), 1, 0)
    s = addToast(s, err('b'), 2, 0)
    s = dismissToast(pauseToasts(s, 1000), 2, 3000)
    expect(s.toasts.map((t) => t.id)).toEqual([1])
    expect(s.pausedAt).toBeNull()
    expect(s.toasts[0].expiresAt).toBe(TOAST_TTL_MS + 2000)
  })
})
