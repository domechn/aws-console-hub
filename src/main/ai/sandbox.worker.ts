import { parentPort, workerData } from 'node:worker_threads'
import type { QuickJSDeferredPromise, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten-core'
import type { ScriptAws, ScriptLimits, ScriptRun } from './sandbox'

const limits = workerData.limits as ScriptLimits
const code = workerData.code as string
const pending = new Map<number, { resolve: (json: string) => void; reject: (error: Error) => void }>()
let nextId = 0
parentPort!.on('message', (message: { id: number; json?: string; error?: string }) => {
  const p = pending.get(message.id)
  if (!p) return
  pending.delete(message.id)
  if (message.error) p.reject(new Error(message.error))
  else p.resolve(message.json ?? 'null')
})
const aws: ScriptAws = (service, action, params, opts) => new Promise((resolve, reject) => {
  const id = ++nextId
  pending.set(id, { resolve, reject })
  parentPort!.postMessage({ type: 'aws', id, service, action, params: JSON.stringify(params), opts: JSON.stringify(opts) })
})
class ScriptClock {
  elapsed(): number { return 0 }
}
async function load(): Promise<QuickJSWASMModule> {
  const [core, variant] = await Promise.all([import('quickjs-emscripten-core'), import('@jitl/quickjs-singlefile-cjs-release-sync')])
  const mod = await core.newQuickJSWASMModuleFromVariant(variant as never)
  parentPort!.postMessage({ type: 'ready' })
  return mod
}
const leaks = { count: 0 }
/** Installed before the script, then the raw host functions are gone from the global object. */
const PRELUDE = `"use strict";
(() => {
  const g = globalThis, raw = g.__aws, rawLog = g.__log, stringify = JSON.stringify, parse = JSON.parse;
  delete g.__aws; delete g.__log;
  const json = (v, what) => {
    const s = stringify(v === undefined ? {} : v);
    if (typeof s !== 'string' || s[0] !== '{') throw new TypeError(what + ' 必须是能转成 JSON 的对象');
    return s;
  };
  g.aws = (service, action, params, opts) => raw(service, action, json(params, 'params'), json(opts, 'opts')).then(parse);
  const show = (v) => { if (typeof v === 'string') return v; try { return stringify(v); } catch { return String(v); } };
  g.log = (...a) => { rawLog(a.map(show).join(' ')); };
  g.console = { log: g.log, info: g.log, warn: g.log, error: g.log };
  g.parallel = async (tasks, limit = 8) => {
    const list = Array.from(tasks), out = new Array(list.length);
    let next = 0;
    const worker = async () => { while (next < list.length) { const i = next++; out[i] = await (typeof list[i] === 'function' ? list[i]() : list[i]); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(limit) || 8, list.length)) }, worker));
    return out;
  };
})();`

/** The code is the body of an async function; its return value comes back as JSON text. */
const wrap = (code: string): string =>
  `(async () => {\n${code}\n})().then((v) => { const s = JSON.stringify(v === undefined ? null : v); return typeof s === 'string' ? s : 'null'; })`

async function runInWorker(code: string, aws: ScriptAws, opts: { signal?: AbortSignal; clock?: ScriptClock; limits?: ScriptLimits; onCalls?: (calls: number) => void } = {}): Promise<ScriptRun> {
  const limits = opts.limits ?? (workerData.limits as ScriptLimits)
  const clock = opts.clock ?? new ScriptClock()
  const started = Date.now()
  const logs: string[] = []
  let logChars = 0
  let calls = 0
  let completed = 0
  if (code.length > limits.codeChars) return { ok: false, error: `代码太长（${code.length} 字符，上限 ${limits.codeChars}）`, cause: 'too-long', logs, calls, ms: 0 }
  if (opts.signal?.aborted) return { ok: false, error: '已停止', cause: 'stopped', logs, calls, ms: 0 }
  const mod = await load()
  if (opts.signal?.aborted) return { ok: false, error: '已停止', cause: 'stopped', logs, calls, ms: Date.now() - started }
  const stop = new AbortController()
  const timedOut = (): boolean => clock.elapsed() >= limits.wallMs
  let sliceStart = Date.now()
  let sliceExceeded = false
  let cpuUsed = 0
  let cpuExceeded = false
  const duration = (ms: number, short = false): string => ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : ms < 1000 && short ? `${ms} 毫秒` : `${ms / 1000} 秒`
  const sliceText = `脚本连续同步计算超过 ${duration(limits.syncSliceMs, true)}被中断，请把计算拆小或减少本地循环`
  const cpuText = `脚本累计本地计算超过 ${limits.scriptCpuMs / 1000} 秒被中断`
  const timeoutText = (): string => `脚本超过 ${duration(limits.wallMs)}（不含等待审批的时间），已停止；已完成 ${completed} 次调用（已调用 ${calls} 次 aws()）`
  const rt = mod.newRuntime()
  rt.setMemoryLimit(limits.memoryBytes)
  rt.setMaxStackSize(limits.stackBytes)
  // Called regularly while QuickJS runs: a busy loop ends here, an idle script by the watch timer below.
  rt.setInterruptHandler(() => {
    const current = Date.now() - sliceStart
    if (current > limits.syncSliceMs) sliceExceeded = true
    if (cpuUsed + current > limits.scriptCpuMs) cpuExceeded = true
    return stop.signal.aborted || sliceExceeded || cpuExceeded
  })
  const vm = rt.newContext()
  const deferreds = new Set<QuickJSDeferredPromise>()
  // Inside a QuickJS call (eval, pending jobs): disposing waits until it returns.
  let depth = 0
  let finished = false
  let disposed = false
  let nextPump: ReturnType<typeof setImmediate> | undefined
  // A host exception went through the instance (V8's stack overflowed inside the wasm: deeply nested JSON does that
  // whatever QuickJS's own stack limit): its state is unknown, so it is never touched again, only dropped.
  let poisoned = false
  let settle!: (r: ScriptRun) => void
  const done = new Promise<ScriptRun>((resolve) => (settle = resolve))

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    const pending = [...deferreds]
    deferreds.clear()
    if (poisoned) return
    try {
      for (const d of pending) if (d.alive) d.dispose()
      vm.dispose()
      rt.dispose()
    } catch {
      // A leaked handle makes QuickJS assert here; the instance is per script and the run is over either way.
      leaks.count++
    }
  }
  const finish = (r: Pick<ScriptRun, 'ok' | 'value' | 'error' | 'cause'>): void => {
    if (finished) return
    finished = true
    stop.abort()
    clearInterval(watch)
    if (nextPump) clearImmediate(nextPump)
    opts.signal?.removeEventListener('abort', onAbort)
    settle({ ...r, logs, calls, ms: Date.now() - started })
    if (depth === 0) queueMicrotask(dispose)
  }
  /** Every call from main into QuickJS goes through here: undefined once the instance is gone or poisoned. */
  const inVm = <T,>(f: () => T): T | undefined => {
    if (disposed || poisoned) return undefined
    if (depth === 0) { sliceStart = Date.now(); parentPort!.postMessage({ type: 'enter' }) }
    depth++
    try {
      return f()
    } catch (err) {
      poisoned = true
      finish({ ok: false, cause: 'error', error: err instanceof RangeError ? '脚本出错：嵌套或递归太深（栈溢出）' : '脚本出错：沙箱内部错误' })
      return undefined
    } finally {
      if (--depth === 0) {
        cpuUsed += Date.now() - sliceStart
        parentPort!.postMessage({ type: 'yield', cpuUsed })
        if (cpuUsed > limits.scriptCpuMs) cpuExceeded = true
        if (finished) queueMicrotask(dispose)
      }
    }
  }
  /** A thrown value from QuickJS as a short message, and what kind of failure it was. */
  const failure = (h: QuickJSHandle): Pick<ScriptRun, 'ok' | 'error' | 'cause'> => {
    const e = inVm(() => {
      try {
        return vm.dump(h)
      } finally {
        h.dispose()
      }
    })
    const o = (e && typeof e === 'object' ? e : {}) as { name?: unknown; message?: unknown }
    const text = typeof o.message === 'string' ? `${typeof o.name === 'string' ? `${o.name}: ` : ''}${o.message}` : String(e)
    if (stop.signal.aborted && !timedOut()) return { ok: false, error: '已停止', cause: 'stopped' }
    if (sliceExceeded) return { ok: false, error: sliceText, cause: 'timeout' }
    if (cpuExceeded) return { ok: false, error: cpuText, cause: 'timeout' }
    if (timedOut() || /interrupted/.test(text)) return { ok: false, error: timeoutText(), cause: 'timeout' }
    if (/out of memory/i.test(text)) return { ok: false, error: `脚本内存超过 ${limits.memoryBytes >> 20} MB，已停止`, cause: 'memory' }
    return { ok: false, error: `脚本出错：${text.slice(0, 500)}`, cause: 'error' }
  }
  const pump = (): void => {
    if (finished) return
    if (sliceExceeded || cpuExceeded) return finish({ ok: false, error: sliceExceeded ? sliceText : cpuText, cause: 'timeout' })
    const r = inVm(() => rt.executePendingJobs(100))
    if (r?.error) finish(failure(r.error))
    else if (sliceExceeded || cpuExceeded) finish({ ok: false, error: sliceExceeded ? sliceText : cpuText, cause: 'timeout' })
    else if (r?.value === 100 && !nextPump) nextPump = setImmediate(() => {
      nextPump = undefined
      pump()
    })
  }

  // Host calls beyond `concurrency` wait for a slot (Promise.all over 100 items is fine).
  let active = 0
  let requests = 0
  const waiting: (() => void)[] = []
  const slot = (): Promise<void> => (active < limits.concurrency ? (active++, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve)))
  const release = (): void => {
    const next = waiting.shift()
    if (next) next()
    else active--
  }

  const str = (h: QuickJSHandle | undefined): string | null => (h && vm.typeof(h) === 'string' ? vm.getString(h) : null)
  const object = (text: string | null): Record<string, unknown> | null => {
    try {
      const v = text === null ? null : JSON.parse(text)
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null
    } catch {
      return null
    }
  }
  const awsFn = vm.newFunction('__aws', (...args) => {
    const d = vm.newPromise()
    deferreds.add(d)
    void d.settled.then(() => {
      deferreds.delete(d)
      pump()
    })
    const reject = (message: string): void =>
      void inVm(() => {
        if (finished || !d.alive) return
        const e = vm.newError(message)
        d.reject(e)
        e.dispose()
      })
    const [service, action, paramsText, optsText] = args.slice(0, 4).map(str)
    const params = object(paramsText)
    const options = object(optsText)
    if (typeof service !== 'string' || typeof action !== 'string') reject('aws(service, action, params?, opts?)：service 和 action 必须是字符串')
    else if (!params || !options) reject('aws()：params 和 opts 必须是 JSON 对象')
    else if (++requests > limits.maxCalls) reject(`aws() 调用次数超过上限（${limits.maxCalls} 次）`)
    else {
      void slot()
        .then(() => {
          if (finished) throw new Error('已停止')
          calls++
          opts.onCalls?.(calls)
          return aws(service, action, params, options, stop.signal)
        })
        .finally(release)
        .then(
          (json) => {
            if (finished || !d.alive) return
            if (typeof json !== 'string' || json.length > limits.resultChars) return reject(`${service}:${action} 的结果太大（上限 ${limits.resultChars} 字符），请加过滤条件或分页`)
            completed++
            inVm(() => {
              const s = vm.newString(json)
              d.resolve(s)
              s.dispose()
            })
          },
          (err: unknown) => reject((err instanceof Error ? err.message : String(err)).slice(0, 600))
        )
    }
    return d.handle
  })
  vm.setProp(vm.global, '__aws', awsFn)
  awsFn.dispose()
  const logFn = vm.newFunction('__log', (h) => {
    const line = str(h)
    if (!line || logChars >= limits.logChars) return
    const kept = line.slice(0, limits.logChars - logChars)
    logChars += kept.length
    const logged = kept.length < line.length ? `${kept}…（日志已截断）` : kept
    logs.push(logged)
    parentPort!.postMessage({ type: 'log', line: logged })
  })
  vm.setProp(vm.global, '__log', logFn)
  logFn.dispose()

  const onAbort = (): void => finish({ ok: false, error: '已停止', cause: 'stopped' })
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  // An idle script (waiting on calls) never hits the interrupt handler.
  const watch = setInterval(() => {
    if (sliceExceeded || cpuExceeded) finish({ ok: false, error: sliceExceeded ? sliceText : cpuText, cause: 'timeout' })
  }, 200)
  watch.unref?.()

  const prelude = inVm(() => vm.evalCode(PRELUDE, 'prelude.js'))
  if (prelude?.error) finish(failure(prelude.error))
  else prelude?.value.dispose()
  if (finished) return done
  const r = inVm(() => vm.evalCode(wrap(code), 'script.js'))
  if (!r) return done
  if (r.error) {
    finish(failure(r.error))
    return done
  }
  const value = r.value
  const result = inVm(() => {
    try {
      return vm.resolvePromise(value)
    } finally {
      value.dispose()
    }
  })
  void result?.then((res) => {
    if (finished) {
      if (res.error) res.error.dispose()
      else res.value.dispose()
      return
    }
    if (res.error) return finish(failure(res.error))
    const json = inVm(() => {
      try {
        return vm.getString(res.value)
      } finally {
        res.value.dispose()
      }
    })
    if (json === undefined) return
    if (json.length > limits.returnChars) {
      return finish({ ok: true, value: { truncated: true, note: `返回值太大（${json.length} 字符，上限 ${limits.returnChars}），已丢弃。请只返回汇总。` } })
    }
    finish({ ok: true, value: JSON.parse(json) })
  })
  pump()
  return done
}

void runInWorker(code, aws, { limits, clock: new ScriptClock() }).then(
  (result) => {
    if (result.ok) {
      const json = JSON.stringify(result.value)
      if (json.length > 12_000) result.value = { truncated: true, note: `返回值太大（${json.length} 字符，上限 12000），已丢弃。请只返回汇总。` }
    }
    parentPort!.postMessage({ type: 'result', result: JSON.stringify(result) })
  },
  () => parentPort!.postMessage({ type: 'result', result: JSON.stringify({ ok: false, error: '脚本出错：沙箱内部错误', cause: 'error' }) })
)
