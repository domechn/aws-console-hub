import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ToastApi } from '../../shared/api'
import {
  EMPTY_TOASTS,
  addToast,
  dismissToast,
  expireToasts,
  nextExpiry,
  pauseToasts,
  resumeToasts
} from './toasts'
import './toast.css'

/**
 * The bottom-right toast stack. It runs in its own small transparent
 * WebContentsView (main/toast.ts) because the console views paint over the
 * app's DOM; main sizes that view to the stack's height reported here.
 */

declare global {
  interface Window {
    toastApi: ToastApi
  }
}

const api = window.toastApi

function ToastStack(): React.JSX.Element {
  const [state, setState] = useState(EMPTY_TOASTS)
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const stackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let nextId = 1
    const off = api.onToast((t) => setState((s) => addToast(s, t, nextId++, Date.now())))
    api.ready()
    return off
  }, [])

  useEffect(() => {
    const at = nextExpiry(state)
    if (at === null) return
    const timer = setTimeout(() => setState((s) => expireToasts(s, Date.now())), Math.max(0, at - Date.now()))
    return () => clearTimeout(timer)
  }, [state])

  // Measured on every change rather than by a ResizeObserver: the view may be hidden, with no frames.
  useLayoutEffect(() => {
    api.resize(state.toasts.length ? Math.ceil(stackRef.current?.getBoundingClientRect().height ?? 0) : 0)
  }, [state.toasts])

  useEffect(() => {
    if (copiedId === null) return
    const timer = setTimeout(() => setCopiedId(null), 1500)
    return () => clearTimeout(timer)
  }, [copiedId])

  return (
    <div
      className="toast-stack"
      ref={stackRef}
      onMouseEnter={() => setState((s) => pauseToasts(s, Date.now()))}
      onMouseLeave={() => setState((s) => resumeToasts(s, Date.now()))}
    >
      {state.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <div className="toast-message">{t.message}</div>
          <div className="toast-actions">
            {t.count > 1 && <span className="toast-count">×{t.count}</span>}
            <button
              onClick={() => {
                api.copy(t.message)
                setCopiedId(t.id)
              }}
            >
              {copiedId === t.id ? '已复制' : '复制'}
            </button>
            <button
              aria-label="关闭"
              title="关闭"
              onClick={() => {
                setState((s) => dismissToast(s, t.id, Date.now()))
                api.dismissed()
              }}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<ToastStack />)
