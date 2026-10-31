import type { ToastInput, ToastKind } from '../../shared/types'

/**
 * The toast overlay's queue, as pure functions over an immutable state so the
 * timing rules are testable: newest on top, at most MAX_TOASTS, each gone
 * after TOAST_TTL_MS unless the pointer is over the stack.
 */

export const TOAST_TTL_MS = 8000
export const MAX_TOASTS = 3

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  /** How many times this exact message arrived while it was up. */
  count: number
  expiresAt: number
}

export interface ToastState {
  toasts: Toast[]
  /** When hovering began; every timer is frozen meanwhile. */
  pausedAt: number | null
}

export const EMPTY_TOASTS: ToastState = { toasts: [], pausedAt: null }

/** A repeat of a visible toast moves it to the top with a count and a fresh timer instead of stacking. */
export function addToast(state: ToastState, input: ToastInput, id: number, now: number): ToastState {
  const same = state.toasts.find((t) => t.kind === input.kind && t.message === input.message)
  const toast: Toast = {
    id: same?.id ?? id,
    kind: input.kind,
    message: input.message,
    count: (same?.count ?? 0) + 1,
    // Added while paused: resume shifts it by the rest of the pause, so its 8s start then.
    expiresAt: (state.pausedAt ?? now) + TOAST_TTL_MS
  }
  return { ...state, toasts: [toast, ...state.toasts.filter((t) => t !== same)].slice(0, MAX_TOASTS) }
}

export function pauseToasts(state: ToastState, now: number): ToastState {
  return state.pausedAt === null ? { ...state, pausedAt: now } : state
}

export function resumeToasts(state: ToastState, now: number): ToastState {
  if (state.pausedAt === null) return state
  const shift = now - state.pausedAt
  return { toasts: state.toasts.map((t) => ({ ...t, expiresAt: t.expiresAt + shift })), pausedAt: null }
}

/** Also resumes: the overlay shrinks under the pointer, which then may never get a mouseleave. */
export function dismissToast(state: ToastState, id: number, now: number): ToastState {
  return resumeToasts({ ...state, toasts: state.toasts.filter((t) => t.id !== id) }, now)
}

export function expireToasts(state: ToastState, now: number): ToastState {
  if (state.pausedAt !== null) return state
  const toasts = state.toasts.filter((t) => t.expiresAt > now)
  return toasts.length === state.toasts.length ? state : { ...state, toasts }
}

/** When the next toast runs out; null while paused or empty. */
export function nextExpiry(state: ToastState): number | null {
  if (state.pausedAt !== null || state.toasts.length === 0) return null
  return Math.min(...state.toasts.map((t) => t.expiresAt))
}
