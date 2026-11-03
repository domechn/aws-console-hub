import { Worker } from 'node:worker_threads'

export const SYNC_SLICE_MS = 2_000
export const SCRIPT_LIMITS = {
  codeChars: 8000,
  wallMs: 5 * 60_000,
  syncSliceMs: SYNC_SLICE_MS,
  scriptCpuMs: 60_000,
  memoryBytes: 64 * 1024 * 1024,
  /** QuickJS's own check; above ~200 KB plain recursion overflows the host's (V8's) stack first. */
  stackBytes: 192 * 1024,
  maxCalls: 300,
  concurrency: 8,
  /** JSON text of one aws() result handed to the script. */
  resultChars: 2_000_000,
  /** JSON text of the return value read back into main (the tool result is cut to 12 KB after that). */
  returnChars: 1_000_000,
  logChars: 4000
}
export type ScriptLimits = typeof SCRIPT_LIMITS

/** Workers still running; tests keep this at zero after each run. */
export const leaks = { count: 0 }

/** Wall clock that stops while the script waits for the user (approval cards). */
export class ScriptClock {
  private used = 0
  private since = Date.now()
  private paused = 0

  start(): void {
    this.used = 0
    this.since = Date.now()
  }

  elapsed(): number {
    return this.used + (this.paused ? 0 : Date.now() - this.since)
  }

  async pause<T>(wait: Promise<T>): Promise<T> {
    if (this.paused++ === 0) this.used += Date.now() - this.since
    try {
      return await wait
    } finally {
      if (--this.paused === 0) this.since = Date.now()
    }
  }
}

/** One aws() call: arguments checked (names are strings, params a JSON object). Resolves with the JSON text the script gets. */
export type ScriptAws = (service: string, action: string, params: Record<string, unknown>, opts: Record<string, unknown>, signal: AbortSignal) => Promise<string>

export interface ScriptRun {
  ok: boolean
  /** ok: the return value (parsed JSON). */
  value?: unknown
  error?: string
  /** Why it failed, for the audit log (never the message: it may quote AWS data). */
  cause?: 'too-long' | 'timeout' | 'memory' | 'stopped' | 'error'
  logs: string[]
  calls: number
  ms: number
}

const duration = (ms: number, short = false): string => ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : ms < 1000 && short ? `${ms} 毫秒` : `${ms / 1000} 秒`
const SLICE_GRACE_MS = 150
const STARTUP_MS = 15_000
const MAX_LOG_LINES = 1000
/** Keep in sync with shapeData's MAX_RESULT_CHARS, the model-facing output cap. */
const MAX_RESULT_CHARS = 12_000
const MAX_WORKER_MESSAGES = 20_000
const MAX_RESULT_MESSAGE_CHARS = 2 * MAX_RESULT_CHARS
const INTERNAL_ERROR = '脚本出错：沙箱内部错误'
const RESULT_CAUSES = new Set<ScriptRun['cause']>(['too-long', 'timeout', 'memory', 'stopped', 'error'])
const safeJson = (key: string, item: unknown): unknown =>
  key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : item
const plainJsonObject = (text: unknown, limit: number, reserved?: { found: boolean }): Record<string, unknown> | null => {
  if (typeof text !== 'string' || text.length > limit) return null
  try {
    const value: unknown = JSON.parse(text, (key: string, item: unknown) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        if (reserved) reserved.found = true
        return undefined
      }
      return item
    })
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
      ? value as Record<string, unknown> : null
  } catch { return null }
}

export async function runScript(code: string, aws: ScriptAws, opts: { signal?: AbortSignal; clock?: ScriptClock; limits?: ScriptLimits; onCalls?: (calls: number) => void } = {}): Promise<ScriptRun> {
  const limits = opts.limits ?? SCRIPT_LIMITS
  const clock = opts.clock ?? new ScriptClock()
  const started = Date.now()
  if (code.length > limits.codeChars) return { ok: false, error: `代码太长（${code.length} 字符，上限 ${limits.codeChars}）`, cause: 'too-long', logs: [], calls: 0, ms: 0 }
  if (opts.signal?.aborted) return { ok: false, error: '已停止', cause: 'stopped', logs: [], calls: 0, ms: 0 }
  const source = import.meta.url.endsWith('.ts')
  const worker = new Worker(new URL(source ? './sandbox.worker.ts' : './sandbox.worker.js', import.meta.url), {
    workerData: { code, limits }, env: {}, execArgv: source ? ['--experimental-strip-types', '--no-warnings'] : [],
    resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 }
  })
  leaks.count++
  const stop = new AbortController()
  const logs: string[] = []
  let calls = 0
  let completed = 0
  let active = 0
  let busySince = Date.now()
  let busy = false
  let observedCpu = 0
  let workerCpu = 0
  let ready = false
  let ended = false
  let logChars = 0
  let messages = 0
  const ids = new Set<number>()
  const waiting: { resolve: () => void; reject: (error: Error) => void }[] = []
  const slot = (): Promise<void> => active < limits.concurrency ? (active++, Promise.resolve()) : new Promise((resolve, reject) => waiting.push({ resolve, reject }))
  const release = (): void => { const next = waiting.shift(); if (next) next.resolve(); else active-- }
  const result = await new Promise<ScriptRun>((resolve) => {
    const finish = (r: Partial<Pick<ScriptRun, 'value' | 'error' | 'cause' | 'logs'>> & Pick<ScriptRun, 'ok'>): void => {
      if (ended) return
      ended = true
      stop.abort()
      for (const queued of waiting.splice(0)) queued.reject(new Error('已停止'))
      clearInterval(watch)
      clearTimeout(startup)
      opts.signal?.removeEventListener('abort', onAbort)
      const done = (): void => { leaks.count--; resolve({ ...r, logs, calls, ms: Date.now() - started }) }
      void worker.terminate().then(done, done)
    }
    const timeoutText = (): string => `脚本超过 ${duration(limits.wallMs)}（不含等待审批的时间），已停止；已完成 ${completed} 次调用（已调用 ${calls} 次 aws()）`
    const sliceText = `脚本连续同步计算超过 ${duration(limits.syncSliceMs, true)}被中断，请把计算拆小或减少本地循环`
    const cpuText = `脚本累计本地计算超过 ${limits.scriptCpuMs / 1000} 秒被中断`
    const onAbort = (): void => finish({ ok: false, error: '已停止', cause: 'stopped' })
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (raw: unknown) => {
      if (ended) return
      if (++messages > MAX_WORKER_MESSAGES) return finish({ ok: false, error: INTERNAL_ERROR, cause: 'error' })
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
      const m = raw as Record<string, unknown>
      if (m.type === 'ready' && !ready) { clock.start(); ready = true; clearTimeout(startup) }
      if (m.type === 'log' && typeof m.line === 'string' && logs.length < MAX_LOG_LINES && logChars < limits.logChars) {
        const line = m.line.slice(0, limits.logChars - logChars)
        logs.push(line)
        logChars += line.length
      }
      if (m.type === 'enter' && !busy) { busy = true; busySince = Date.now() }
      if (m.type === 'yield' && busy) {
        observedCpu += Date.now() - busySince
        busy = false
        if (typeof m.cpuUsed === 'number' && Number.isFinite(m.cpuUsed) && m.cpuUsed >= 0) workerCpu = Math.max(workerCpu, m.cpuUsed)
        if (Math.max(observedCpu, workerCpu) > limits.scriptCpuMs) finish({ ok: false, error: cpuText, cause: 'timeout' })
      }
      if (m.type === 'result') {
        if (typeof m.result !== 'string' || m.result.length > MAX_RESULT_MESSAGE_CHARS) return finish({ ok: false, error: INTERNAL_ERROR, cause: 'error' })
        let candidate: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(m.result, safeJson)
          candidate = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
        } catch { return finish({ ok: false, error: INTERNAL_ERROR, cause: 'error' }) }
        const ok = candidate.ok === true
        const error = typeof candidate.error === 'string' ? candidate.error.slice(0, 600) : INTERNAL_ERROR
        const cause = RESULT_CAUSES.has(candidate.cause as ScriptRun['cause']) ? candidate.cause as ScriptRun['cause'] : 'error'
        if (!ok) return finish({ ok: false, error, cause })
        try {
          const value = candidate.value
          if (value !== null && !['string', 'number', 'boolean', 'object'].includes(typeof value)) throw new Error('invalid value')
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('invalid value')
          const json = JSON.stringify(value)
          if (typeof json !== 'string') throw new Error('invalid value')
          if (json.length > MAX_RESULT_CHARS) return finish({ ok: true, value: { truncated: true, note: `返回值太大（${json.length} 字符，上限 ${MAX_RESULT_CHARS}），已丢弃。请只返回汇总。` } })
          return finish({ ok: true, value: JSON.parse(json, safeJson) as unknown })
        } catch {
          return finish({ ok: false, error: '脚本返回值无效或超过大小上限', cause: 'error' })
        }
      }
      if (m.type !== 'aws') return
      const id = m.id
      if (!Number.isSafeInteger(id) || (id as number) <= 0 || ids.has(id as number)) return
      if (ids.size >= limits.maxCalls) return finish({ ok: false, error: INTERNAL_ERROR, cause: 'error' })
      ids.add(id as number)
      const replyError = (error: string): void => { if (!ended) worker.postMessage({ id, error: error.slice(0, 600) }) }
      const service = m.service, action = m.action
      if (typeof m.params === 'string' && m.params.length > 4000) { replyError('aws() 参数太大（上限 4000 字符）'); return }
      const reserved = { found: false }
      const params = plainJsonObject(m.params, 4000, reserved)
      const options = plainJsonObject(m.opts, Math.min(limits.codeChars, SCRIPT_LIMITS.codeChars))
      if (reserved.found) { replyError('params 里不能用 __proto__/constructor/prototype 作键名'); return }
      if (typeof service !== 'string' || service.length < 1 || service.length > 50 ||
          typeof action !== 'string' || action.length < 1 || action.length > 100 ||
          !params || !options ||
          ('region' in options && (typeof options.region !== 'string' || !/^[a-z0-9-]{1,30}$/.test(options.region)))) {
        replyError('aws() 参数无效')
        return
      }
      void slot().then(async () => {
        try {
          if (ended) return
          if (calls >= limits.maxCalls) throw new Error(`aws() 调用次数超过上限（${limits.maxCalls} 次）`)
          calls++
          opts.onCalls?.(calls)
          const json = await aws(service, action, params, options, stop.signal)
          if (ended) return
          if (typeof json !== 'string' || json.length > limits.resultChars) throw new Error(`${service}:${action} 的结果太大（上限 ${limits.resultChars} 字符），请加过滤条件或分页`)
          completed++
          worker.postMessage({ id, json })
        } catch (err) {
          if (!ended) worker.postMessage({ id, error: (err instanceof Error ? err.message : String(err)).slice(0, 600) })
        } finally { release() }
      }).catch(() => {})
    })
    worker.on('error', (err: Error & { code?: string }) => {
      if (err?.code) console.warn(`sandbox worker error: ${/^[A-Z0-9_]{1,80}$/.test(err.code) ? err.code : 'UNKNOWN'}`)
      finish(err?.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? { ok: false, error: '脚本内存不足，沙箱工作线程已停止', cause: 'memory' }
        : { ok: false, error: INTERNAL_ERROR, cause: 'error' })
    })
    worker.on('messageerror', () => finish({ ok: false, error: INTERNAL_ERROR, cause: 'error' }))
    worker.on('exit', () => finish({ ok: false, error: '脚本出错：沙箱工作线程意外退出', cause: 'error' }))
    const watch = setInterval(() => {
      if (ready && clock.elapsed() >= limits.wallMs) finish({ ok: false, error: timeoutText(), cause: 'timeout' })
      else if (busy && Date.now() - busySince > limits.syncSliceMs + SLICE_GRACE_MS) {
        setImmediate(() => {
          if (!ended && busy && Date.now() - busySince > limits.syncSliceMs + SLICE_GRACE_MS) finish({ ok: false, error: sliceText, cause: 'timeout' })
        })
      }
    }, 25)
    watch.unref?.()
    const startup = setTimeout(() => finish({ ok: false, error: '脚本沙箱启动超时', cause: 'timeout' }), STARTUP_MS)
    if (opts.signal?.aborted) onAbort()
  })
  return result
}
