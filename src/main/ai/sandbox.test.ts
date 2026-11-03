import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { leaks, runScript, SCRIPT_LIMITS, ScriptClock, type ScriptAws } from './sandbox'

const echo: ScriptAws = async (service, action, params) => JSON.stringify({ service, action, params })
const run = (code: string, aws: ScriptAws = echo, limits: Partial<typeof SCRIPT_LIMITS> = {}, signal?: AbortSignal, clock?: ScriptClock) =>
  runScript(code, aws, { limits: { ...SCRIPT_LIMITS, ...limits }, signal, clock })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const execFileAsync = promisify(execFile)

describe('run_script sandbox', { timeout: 15_000 }, () => {
  it.each([
    'for(;;){ (async()=>{for(;;){}})() }',
    'for(;;){ new Promise(()=>{for(;;){}}) }'
  ])('kills an interrupt-swallowing script within a bounded time: %s', async (code) => {
    const script = `import { runScript, SCRIPT_LIMITS } from './src/main/ai/sandbox.ts'; const r = await runScript(${JSON.stringify(code)}, async () => '{}', { limits: { ...SCRIPT_LIMITS, syncSliceMs: 50, wallMs: 5000 } }); if (r.cause !== 'timeout' || !r.error?.includes('连续同步计算') || r.ms > 4000) process.exitCode = 1`
    await execFileAsync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { cwd: process.cwd(), timeout: 6000 })
  }, 7500)
  it('keeps earlier logs when the watchdog kills a script', async () => {
    const r = await run(`log('before'); await aws('ec2', 'DescribeVpcs', {}); for(;;){ new Promise(()=>{for(;;){}}) }`, echo, { syncSliceMs: 100, wallMs: 1_000 })
    expect(r).toMatchObject({ ok: false, cause: 'timeout', logs: ['before'], calls: 1 })
  })
  it('reports completed calls and the configured deadline after a synchronous loop', async () => {
    await run('return 1')
    const r = await run(`await aws('ec2', 'DescribeVpcs', {}); while (true) {}`, echo, { wallMs: 300 })
    expect(r).toMatchObject({ ok: false, cause: 'timeout', calls: 1 })
    expect(r.error).toContain('0.3 秒')
    expect(r.error).toContain('已调用 1 次')
    expect(r.error).toContain('已完成 1 次')
  })
  it('reports a configured 30-minute wall deadline in minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const r = await run(`await aws('ec2', 'DescribeVpcs', {}); while (true) {}`, async () => {
        vi.setSystemTime(Date.now() + 30 * 60_000)
        return '{}'
      }, { wallMs: 30 * 60_000 })
      expect(r.error).toContain('30 分钟')
    } finally {
      vi.useRealTimers()
    }
  })
  it.each([
    ['initial eval', 'while (true) {}'],
    ['after await', `await aws('ec2', 'DescribeVpcs', {}); while (true) {}`]
  ])('interrupts a continuous sync slice during %s', async (_where, code) => {
    const r = await run(code, echo, { syncSliceMs: 50, wallMs: 5_000 })
    expect(r).toMatchObject({ ok: false, cause: 'timeout', error: '脚本连续同步计算超过 50 毫秒被中断，请把计算拆小或减少本地循环' })
  })
  it('ends a caught async slice interrupt before another promise job can run', async () => {
    let calls = 0
    const started = Date.now()
    const r = await run(`for(;;){ try { await (async()=>{ while(true){} })() } catch {} }`, async () => (calls++, '{}'), { syncSliceMs: 50, wallMs: 5_000 })
    expect(r).toMatchObject({ ok: false, cause: 'timeout', error: '脚本连续同步计算超过 50 毫秒被中断，请把计算拆小或减少本地循环' })
    expect(Date.now() - started).toBeLessThan(3000)
    await sleep(100)
    expect(calls).toBe(0)
  })
  it('does not start host calls from a catch handler after a slice interrupt', async () => {
    let calls = 0
    const r = await run(`for(;;){ try { await (async()=>{ while(true){} })() } catch { await aws('ec2', 'DescribeVpcs', {}) } }`, async () => (calls++, '{}'), { syncSliceMs: 50, wallMs: 5_000 })
    expect(r).toMatchObject({ ok: false, cause: 'timeout' })
    expect(calls).toBe(0)
  })
  it('caps accumulated VM compute across short promise jobs', async () => {
    const r = await run(`for (;;) { const end = Date.now() + 20; while (Date.now() < end) {} await aws('ec2', 'DescribeVpcs', {}) }`, echo, { syncSliceMs: 2_000, scriptCpuMs: 1_500, wallMs: 5_000 })
    expect(r).toMatchObject({ ok: false, cause: 'timeout', error: '脚本累计本地计算超过 1.5 秒被中断' })
    expect(r.ms).toBeLessThan(4000)
    expect(r.calls).toBeGreaterThan(1)
  })
  it('caps a burst of promise jobs by accumulated CPU time', async () => {
    const r = await run('for (;;) await null', echo, { scriptCpuMs: 60, syncSliceMs: 500, wallMs: 5_000 })
    expect(r).toMatchObject({ ok: false, cause: 'timeout', error: '脚本累计本地计算超过 0.06 秒被中断' })
  })

  it('keeps main timers responsive during a tight loop and stops it promptly', async () => {
    const ac = new AbortController()
    const ticks: number[] = []
    let started!: () => void
    const called = new Promise<void>((resolve) => { started = resolve })
    const aws: ScriptAws = async () => { started(); return '{}' }
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      const pending = run(`await aws('ec2', 'DescribeVpcs', {}); for (;;) {}`, aws, { syncSliceMs: 500, wallMs: 5_000 }, ac.signal)
      await called
      timer = setInterval(() => ticks.push(Date.now()), 20)
      await vi.waitFor(() => expect(ticks.length).toBeGreaterThanOrEqual(5), { timeout: 15_000 })
      const abortedAt = Date.now()
      ac.abort()
      expect(await pending).toMatchObject({ ok: false, cause: 'stopped' })
      expect(Date.now() - abortedAt).toBeLessThan(1000)
    } finally {
      if (timer) clearInterval(timer)
    }
  })

  it('does not charge an await-only script to the sync slice', async () => {
    const r = await run(`return await aws('ec2', 'DescribeVpcs', {})`, async () => (await sleep(700), '{"ok":true}'), { syncSliceMs: 250, scriptCpuMs: 250, wallMs: 5_000 })
    expect(r).toMatchObject({ ok: true, value: { ok: true } })
  })

  it('keeps a legal short slice when the main thread is delayed', async () => {
    let started!: () => void
    const called = new Promise<void>((resolve) => { started = resolve })
    const pending = run(`await aws('ec2', 'DescribeVpcs', {}); const end = Date.now() + 300; while (Date.now() < end) {} return 7`,
      async () => { started(); return '{}' }, { syncSliceMs: 700, wallMs: 2_000 })
    await called
    await sleep(100)
    const blockUntil = Date.now() + 500
    while (Date.now() < blockUntil) { /* main thread delayed by an unrelated task */ }
    expect(await pending).toMatchObject({ ok: true, value: 7 })
  })

  it('processes Stop between promise-job drains', async () => {
    const ac = new AbortController()
    const aws: ScriptAws = async () => {
      setImmediate(() => ac.abort())
      return '{}'
    }
    const pending = run(`await aws('ec2', 'DescribeVpcs', {}); for (;;) { await null }`, aws, { syncSliceMs: 500, wallMs: 5_000 }, ac.signal)
    expect(await pending).toMatchObject({ ok: false, cause: 'stopped' })
  })
  it('runs the body of an async function: aws() results come back parsed, the return value is the result', async () => {
    const r = await run(`const a = await aws('ec2', 'DescribeInstances', { MaxResults: 5 }); log('got', a.action); return { a, n: 1 }`)
    expect(r).toMatchObject({ ok: true, value: { a: { service: 'ec2', action: 'DescribeInstances', params: { MaxResults: 5 } }, n: 1 }, logs: ['got DescribeInstances'], calls: 1 })
    expect((await run('1 + 1')).value).toBeNull()
  })

  it('has no host objects: process, require, import, timers are not there, whatever the constructor chain', async () => {
    const probes = [
      `return [typeof process, typeof require, typeof module, typeof setTimeout, typeof fetch, typeof std, typeof os, typeof Buffer, typeof __aws, typeof __log]`,
      `return (function () {}).constructor('return [typeof process, typeof require]')()`,
      `return this === undefined ? 'strict-ish' : typeof this.process`,
      `return eval('typeof process') + ',' + new Function('return typeof require')()`,
      `return aws.constructor.constructor('return typeof process')()`,
      `return Object.getPrototypeOf(async function () {}).constructor('return typeof process')().then ? 'promise' : 'x'`
    ]
    for (const code of probes) {
      const r = await run(code)
      expect(r.ok).toBe(true)
      expect(JSON.stringify(r.value)).not.toMatch(/object|function/)
    }
    const names = await run('return Object.getOwnPropertyNames(globalThis)')
    expect(names.value).toEqual(expect.arrayContaining(['aws', 'parallel', 'log', 'JSON', 'Promise']))
    expect(names.value).not.toEqual(expect.arrayContaining(['__aws', '__log']))
    // A thrown host-looking error is only a sandbox value.
    const r = await run(`try { null.x } catch (e) { return [typeof e.constructor.constructor('return process')] }`)
    expect(r.ok).toBe(true)
    const thrown = await run(`return e.constructor.constructor('return process')()`.replace('e.', '(new Error()).'))
    expect(thrown).toMatchObject({ ok: false, cause: 'error' })
    expect(thrown.error).toMatch(/ReferenceError|process/)
  }, 30_000)

  it('import() and module syntax fail', async () => {
    const dyn = await run(`await import('fs'); return 'imported'`)
    expect(dyn.ok).toBe(false)
    expect((await run(`import fs from 'fs'`)).ok).toBe(false)
  })

  it('prototype pollution and overridden builtins stay inside the sandbox', async () => {
    const r = await run(`Object.prototype.polluted = 1; Array.prototype.map = null; JSON.parse = () => ({ forged: true }); return await aws('ec2', 'DescribeVpcs', {})`)
    // aws() kept the JSON.parse it captured at start.
    expect(r.value).toEqual({ service: 'ec2', action: 'DescribeVpcs', params: {} })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(typeof [].map).toBe('function')
  })

  it('only JSON crosses the boundary: getters run inside, proxies, functions and non-strings are refused', async () => {
    const calls: [string, string, unknown, unknown][] = []
    const aws: ScriptAws = async (s, a, p, o) => (calls.push([s, a, p, o]), '{}')
    const r = await run(
      `const p = { get Name() { aws('sts', 'GetCallerIdentity', {}); return 'from-getter' }, fn() {}, nested: new Proxy({}, { ownKeys: () => ['x'], getOwnPropertyDescriptor: () => ({ value: 1, enumerable: true, configurable: true }) }) }
       await aws('ec2', 'DescribeTags', p)
       const errs = []
       for (const bad of [[1, 'X'], ['ec2', { toString: () => 'X' }], [new Proxy({}, {}), 'X'], ['ec2', 'X', [1, 2]], ['ec2', 'X', () => 1], ['ec2', 'X', {}, 'us-east-1']]) {
         try { await aws(...bad) } catch (e) { errs.push(e.message) }
       }
       return errs`,
      aws
    )
    expect(r.ok, r.error).toBe(true)
    expect(r.value, JSON.stringify(calls)).toHaveLength(6)
    const described = calls.find((c) => c[1] === 'DescribeTags')
    // QuickJS's JSON.stringify reads the proxy's target keys: an empty object. Either way, only JSON arrives.
    expect(described?.[2], JSON.stringify(calls)).toEqual({ Name: 'from-getter', nested: {} })
    expect(Object.getPrototypeOf(described?.[2])).toBe(Object.prototype)
    expect(calls.every(([s, a]) => typeof s === 'string' && typeof a === 'string')).toBe(true)
    expect(calls.map((c) => c[1])).toEqual(['GetCallerIdentity', 'DescribeTags'])
  })

  it('rejects to the script with a short message; the script can catch it', async () => {
    const aws: ScriptAws = async () => {
      throw new Error('AccessDenied: no')
    }
    expect((await run(`try { await aws('ec2', 'DescribeVpcs') } catch (e) { return e.message }`, aws)).value).toBe('AccessDenied: no')
    expect(await run(`await aws('ec2', 'DescribeVpcs')`, aws)).toMatchObject({ ok: false, cause: 'error', error: '脚本出错：Error: AccessDenied: no' })
  })

  it('stops an infinite loop at the deadline, a memory bomb, a huge string and a stack overflow', async () => {
    const loop = await run('while (true) {}', echo, { wallMs: 300 })
    expect(loop).toMatchObject({ ok: false, cause: 'timeout' })
    expect(loop.ms).toBeLessThan(2000)
    const busyAsync = await run(`for (;;) { await null }`, echo, { wallMs: 300 })
    expect(busyAsync).toMatchObject({ ok: false, cause: 'timeout' })
    expect(await run('return new Array(10000000).fill(1)', echo, { memoryBytes: 16 << 20 })).toMatchObject({ ok: false, cause: 'memory' })
    expect(await run("let s = 'x'; for (;;) s += s", echo, { memoryBytes: 16 << 20 })).toMatchObject({ ok: false })
    const deep = await run('const f = (n) => f(n + 1) + 1; return f(0)')
    expect(deep).toMatchObject({ ok: false, cause: 'error' })
    expect(deep.error).toMatch(/stack|RangeError|InternalError/i)
    // A catch-all can't keep a busy loop alive past the deadline.
    expect(await run('for (;;) { try { while (true) {} } catch {} }', echo, { wallMs: 300 })).toMatchObject({ ok: false, cause: 'timeout' })
  }, 30_000)

  it('times out a script that only waits, but not while it waits for the user', async () => {
    const slow: ScriptAws = () => new Promise(() => {})
    expect(await run(`await aws('ec2', 'DescribeVpcs', {})`, slow, { wallMs: 300 })).toMatchObject({ ok: false, cause: 'timeout' })
    const clock = new ScriptClock()
    const approving: ScriptAws = async () => (await clock.pause(sleep(1600)), '{"ok":true}')
    expect(await run(`return await aws('sqs', 'ListQueues', {})`, approving, { wallMs: 1000 }, undefined, clock)).toMatchObject({ ok: true, value: { ok: true } })
  })

  it('caps host calls and keeps at most `concurrency` in flight', async () => {
    let active = 0
    let peak = 0
    const aws: ScriptAws = async () => {
      peak = Math.max(peak, ++active)
      await sleep(5)
      active--
      return '1'
    }
    const r = await run(`const xs = await Promise.all(Array.from({ length: 40 }, () => aws('ec2', 'DescribeVpcs', {}))); return xs.length`, aws, { concurrency: 4 })
    expect(r).toMatchObject({ ok: true, value: 40, calls: 40 })
    expect(peak).toBe(4)
    const capped = await run(`let n = 0; for (let i = 0; i < 20; i++) { try { await aws('ec2', 'DescribeVpcs', {}); n++ } catch (e) { return [n, e.message] } }`, aws, { maxCalls: 5 })
    expect(capped.value).toEqual([5, 'aws() 调用次数超过上限（5 次）'])
    const viaParallel = await run(`return (await parallel(Array.from({ length: 10 }, (_, i) => async () => i * 2), 3)).join()`)
    expect(viaParallel.value).toBe('0,2,4,6,8,10,12,14,16,18')
  })

  it('keeps the default 300-call and eight-in-flight limits', async () => {
    let active = 0
    let peak = 0
    const aws: ScriptAws = async () => {
      peak = Math.max(peak, ++active)
      await sleep(2)
      active--
      return '{}'
    }
    const r = await run(`await Promise.all(Array.from({ length: 300 }, () => aws('ec2', 'DescribeVpcs', {}))); try { await aws('ec2', 'DescribeVpcs', {}) } catch (e) { return e.message }`, aws)
    expect(r).toMatchObject({ ok: true, calls: 300, value: 'aws() 调用次数超过上限（300 次）' })
    expect(peak).toBe(8)
  })

  it('counts only host calls actually started before Stop, including calls waiting for a slot', async () => {
    const ac = new AbortController()
    let started = 0
    const aws: ScriptAws = async () => { started++; return new Promise(() => {}) }
    const pending = run(`await Promise.all(Array.from({ length: 20 }, () => aws('ec2', 'DescribeVpcs', {})))`, aws, { concurrency: 2 }, ac.signal)
    await vi.waitFor(() => expect(started).toBe(2), { timeout: 15_000 })
    ac.abort()
    expect(await pending).toMatchObject({ ok: false, cause: 'stopped', calls: 2 })
    await sleep(30)
    expect(started).toBe(2)
  })

  it('reaps workers after many sequential runs', async () => {
    for (let i = 0; i < 8; i++) {
      expect((await run(`return ${i}`)).value).toBe(i)
      expect(leaks.count).toBe(0)
    }
  }, 30_000)

  it('caps the code, each result, the return value and the log', async () => {
    expect(await run('x'.repeat(SCRIPT_LIMITS.codeChars + 1))).toMatchObject({ ok: false, cause: 'too-long' })
    const big: ScriptAws = async () => JSON.stringify('x'.repeat(200))
    expect((await run(`try { await aws('s3', 'ListBuckets', {}) } catch (e) { return e.message }`, big, { resultChars: 100 })).value).toMatch(/结果太大/)
    expect((await run(`return 'y'.repeat(5000)`, echo, { returnChars: 1000 })).value).toMatchObject({ truncated: true })
    expect((await run(`return 'y'.repeat(20_000)`)).value).toMatchObject({ truncated: true })
    const logged = await run(`for (let i = 0; i < 1000; i++) log('line', i); return 1`)
    expect(logged.logs.join('').length).toBeLessThanOrEqual(SCRIPT_LIMITS.logChars + 20)
  })

  it('stop: disposes at once, cancels in-flight calls, and late results do no harm', async () => {
    const ac = new AbortController()
    const signals: AbortSignal[] = []
    let resolveLate!: (v: string) => void
    let started!: () => void
    const called = new Promise<void>((r) => (started = r))
    const aws: ScriptAws = (_s, _a, _p, _o, signal) => (signals.push(signal), started(), new Promise((r) => (resolveLate = r)))
    const pending = run(`await aws('ec2', 'DescribeVpcs', {}); return 'finished'`, aws, {}, ac.signal)
    await called
    ac.abort()
    expect(await pending).toMatchObject({ ok: false, cause: 'stopped', error: '已停止' })
    expect(signals[0].aborted).toBe(true)
    resolveLate('{}')
    await Promise.resolve()
    // Already-aborted signal: nothing runs.
    const aws2 = vi.fn(echo)
    expect(await run(`await aws('ec2', 'DescribeVpcs', {})`, aws2, {}, AbortSignal.abort())).toMatchObject({ cause: 'stopped' })
    expect(aws2).not.toHaveBeenCalled()
  })

  it('stops when aborted during QuickJS loading', async () => {
    const ac = new AbortController()
    const aws = vi.fn(echo)
    const pending = run(`await aws('ec2', 'DescribeVpcs', {})`, aws, {}, ac.signal)
    ac.abort()
    expect(await pending).toMatchObject({ ok: false, cause: 'stopped' })
    expect(aws).not.toHaveBeenCalled()
  })

  it('a syntax error is a script error, not a crash', async () => {
    expect(await run('return {')).toMatchObject({ ok: false, cause: 'error', error: expect.stringMatching(/SyntaxError/) })
  })

  it('deeply nested JSON overflows the host stack inside the wasm: the run fails, that instance is dropped, the next one is fresh', async () => {
    for (const code of ['let o = {}; for (let i = 0; i < 200000; i++) o = { o }; return o', 'return JSON.parse("[".repeat(100000) + "1" + "]".repeat(100000)).length']) {
      expect(await run(code)).toMatchObject({ ok: false, cause: 'error', error: expect.stringMatching(/栈溢出|stack/) })
    }
    expect(await run(`globalThis.leftover = 1; return 2`)).toMatchObject({ ok: true, value: 2 })
    expect((await run(`return typeof leftover`)).value).toBe('undefined')
  })

  afterEach(() => expect(leaks.count).toBe(0))
})
