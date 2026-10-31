import { afterEach, describe, expect, it, vi } from 'vitest'
import { leaks, runScript, SCRIPT_LIMITS, ScriptClock, type ScriptAws } from './sandbox'

const echo: ScriptAws = async (service, action, params) => JSON.stringify({ service, action, params })
const run = (code: string, aws: ScriptAws = echo, limits: Partial<typeof SCRIPT_LIMITS> = {}, signal?: AbortSignal, clock?: ScriptClock) =>
  runScript(code, aws, { limits: { ...SCRIPT_LIMITS, ...limits }, signal, clock })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('run_script sandbox', () => {
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
  })

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
    expect(loop.ms).toBeLessThan(3000)
    const busyAsync = await run(`for (;;) { await null }`, echo, { wallMs: 300 })
    expect(busyAsync).toMatchObject({ ok: false, cause: 'timeout' })
    expect(await run('const a = []; for (;;) a.push(new Array(100000).fill(1))', echo, { memoryBytes: 16 << 20 })).toMatchObject({ ok: false, cause: 'memory' })
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
    const approving: ScriptAws = async () => (await clock.pause(sleep(700)), '{"ok":true}')
    expect(await run(`return await aws('sqs', 'ListQueues', {})`, approving, { wallMs: 400 }, undefined, clock)).toMatchObject({ ok: true, value: { ok: true } })
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

  it('caps the code, each result, the return value and the log', async () => {
    expect(await run('x'.repeat(SCRIPT_LIMITS.codeChars + 1))).toMatchObject({ ok: false, cause: 'too-long' })
    const big: ScriptAws = async () => JSON.stringify('x'.repeat(200))
    expect((await run(`try { await aws('s3', 'ListBuckets', {}) } catch (e) { return e.message }`, big, { resultChars: 100 })).value).toMatch(/结果太大/)
    expect((await run(`return 'y'.repeat(5000)`, echo, { returnChars: 1000 })).value).toMatchObject({ truncated: true })
    const logged = await run(`for (let i = 0; i < 1000; i++) log('line', i); return 1`)
    expect(logged.logs.join('').length).toBeLessThanOrEqual(SCRIPT_LIMITS.logChars + 20)
  })

  it('stop: disposes at once, cancels in-flight calls, and late results do no harm', async () => {
    const ac = new AbortController()
    const signals: AbortSignal[] = []
    let resolveLate!: (v: string) => void
    const aws: ScriptAws = (_s, _a, _p, _o, signal) => (signals.push(signal), new Promise((r) => (resolveLate = r)))
    const pending = run(`await aws('ec2', 'DescribeVpcs', {}); return 'finished'`, aws, {}, ac.signal)
    await sleep(20)
    ac.abort()
    expect(await pending).toMatchObject({ ok: false, cause: 'stopped', error: '已停止' })
    expect(signals[0].aborted).toBe(true)
    resolveLate('{}')
    await sleep(10)
    // Already-aborted signal: nothing runs.
    const aws2 = vi.fn(echo)
    expect(await run(`await aws('ec2', 'DescribeVpcs', {})`, aws2, {}, AbortSignal.abort())).toMatchObject({ cause: 'stopped' })
    expect(aws2).not.toHaveBeenCalled()
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
