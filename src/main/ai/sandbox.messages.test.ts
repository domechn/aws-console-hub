import { afterEach, describe, expect, it, vi } from 'vitest'

const { FakeWorker } = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = []
    replies: unknown[] = []
    handlers = new Map<string, ((value: unknown) => void)[]>()
    terminate = vi.fn(async () => 0)
    constructor() { FakeWorker.instances.push(this) }
    on(event: string, handler: (value: unknown) => void): this {
      this.handlers.set(event, [...this.handlers.get(event) ?? [], handler])
      return this
    }
    emit(event: string, value: unknown): void { for (const handler of this.handlers.get(event) ?? []) handler(value) }
    postMessage(value: unknown): void { this.replies.push(value) }
    send(value: unknown): void { this.emit('message', value) }
  }
  return { FakeWorker }
})
vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }))

import { leaks, runScript, SCRIPT_LIMITS, ScriptClock } from './sandbox'
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const start = (aws = vi.fn(async (_service: string, _action: string, _params: Record<string, unknown>) => '{}'), limits: Partial<typeof SCRIPT_LIMITS> = {}, clock?: ScriptClock) => {
  const pending = runScript('return 1', aws, { limits: { ...SCRIPT_LIMITS, ...limits }, clock })
  return { worker: FakeWorker.instances.at(-1)!, pending, aws }
}
const done = (worker: InstanceType<typeof FakeWorker>, value: unknown = { ok: true, value: 1 }) => worker.send({ type: 'result', result: JSON.stringify(value) })

describe('untrusted sandbox Worker messages', () => {
  afterEach(() => { vi.useRealTimers(); FakeWorker.instances.length = 0; expect(leaks.count).toBe(0) })

  it('starts the wall clock only on the first ready', async () => {
    vi.useFakeTimers()
    const clock = new ScriptClock()
    const { worker, pending } = start(undefined, { wallMs: 100 }, clock)
    let settled = false
    void pending.then(() => { settled = true })
    worker.send({ type: 'ready' })
    await vi.advanceTimersByTimeAsync(50)
    worker.send({ type: 'ready' })
    await vi.advanceTimersByTimeAsync(25)
    worker.send({ type: 'ready' })
    await vi.advanceTimersByTimeAsync(25)
    expect(settled).toBe(true)
    expect(await pending).toMatchObject({ ok: false, cause: 'timeout' })
  })

  it('builds and bounds the result in main, discarding forged fields and duplicate results', async () => {
    const { worker, pending } = start()
    worker.send({ type: 'log', line: 'x'.repeat(5000) })
    worker.send({ type: 'log', line: 42 })
    worker.send({ type: 'log', line: 'later' })
    done(worker, { ok: 'yes', value: { x: 1 }, error: 'e'.repeat(1000), cause: 'forged', logs: ['fake'], calls: 500, ms: -1, extra: 1 })
    done(worker, { ok: true, value: 2 })
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.value).toBeUndefined()
    expect(result.error).toHaveLength(600)
    expect(result.cause).toBe('error')
    expect(result.logs.join('').length).toBeLessThanOrEqual(SCRIPT_LIMITS.logChars)
    expect(result.logs).not.toContain('fake')
    expect(result.calls).toBe(0)
    expect(result).not.toHaveProperty('extra')
    worker.send({ type: 'log', line: 'after' })
    expect(result.logs).not.toContain('after')
  })

  it('caps and parses successful values; rejects non-JSON values', async () => {
    const first = start()
    done(first.worker, { ok: true, value: 'x'.repeat(30_000) })
    expect(await first.pending).toMatchObject({ ok: false, cause: 'error' })
    const second = start()
    second.worker.send({ type: 'result', result: '{"ok":true,"value":' })
    expect(await second.pending).toMatchObject({ ok: false, cause: 'error' })
    const third = start()
    done(third.worker, { ok: true, value: JSON.parse('{"safe":1,"__proto__":{"polluted":true},"nested":{"constructor":1}}') })
    expect((await third.pending).value).toEqual({ safe: 1, nested: {} })
  })

  it('rejects malformed aws messages before calling the host, and bounds the queue', async () => {
    const { worker, pending, aws } = start(undefined, { maxCalls: 20, concurrency: 1 })
    const base = { type: 'aws', service: 'ec2', action: 'DescribeVpcs', params: '{}', opts: '{}' }
    for (const [id, change] of [
      [1, { params: 'null' }], [2, { params: '[]' }], [3, { params: '{'.repeat(8001) }],
      [4, { opts: 'null' }], [5, { opts: '[]' }], [6, { opts: '{'.repeat(8001) }],
      [7, { service: 2 }], [8, { action: 2 }], [9, { service: 's'.repeat(1000) }],
      [10, { opts: '{"region":42}' }], [11, { opts: '{"region":"bad!"}' }]
    ] as const) worker.send({ ...base, ...change, id })
    await tick()
    expect(aws).not.toHaveBeenCalled()
    worker.send({ ...base, id: 12, params: '{"safe":1}' })
    worker.send({ ...base, id: 13 })
    worker.send({ ...base, id: 14 })
    await tick()
    expect(aws).toHaveBeenCalledTimes(3)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(aws.mock.calls[0]?.[2]).toEqual({ safe: 1 })
    done(worker)
    await pending
  })

  it('stops after the maxCalls number of distinct aws ids, including invalid calls', async () => {
    const { worker, pending, aws } = start(undefined, { maxCalls: 2 })
    const base = { type: 'aws', service: 'ec2', action: 'DescribeVpcs', params: '{}', opts: '{}' }
    worker.send({ ...base, id: 1, params: '[]' })
    worker.send({ ...base, id: 2, params: 'null' })
    worker.send({ ...base, id: 3 })
    expect(await pending).toMatchObject({ ok: false, cause: 'error', error: '脚本出错：沙箱内部错误' })
    expect(aws).not.toHaveBeenCalled()
    expect(worker.replies).toHaveLength(2)
  })

  it('stops after too many worker messages of any type', async () => {
    const { worker, pending } = start()
    for (let i = 0; i < 20_001; i++) worker.send({ type: 'unknown' })
    expect(await pending).toMatchObject({ ok: false, cause: 'error', error: '脚本出错：沙箱内部错误' })
  })

  it('reports oversized params before parsing them', async () => {
    const { worker, pending, aws } = start()
    worker.send({ type: 'aws', id: 1, service: 'ec2', action: 'DescribeVpcs', params: '{"x":"' + 'a'.repeat(8000) + '"}', opts: '{}' })
    expect(worker.replies).toContainEqual({ id: 1, error: 'aws() 参数太大（上限 4000 字符）' })
    expect(aws).not.toHaveBeenCalled()
    done(worker)
    await pending
  })

  it('rejects nested reserved params keys without changing the call', async () => {
    const { worker, pending, aws } = start()
    const base = { type: 'aws', service: 'dynamodb', action: 'GetItem', opts: '{}' }
    for (const [id, key] of ['__proto__', 'constructor', 'prototype'].entries()) {
      worker.send({ ...base, id: id + 1, params: `{"item":{"${key}":1}}` })
      expect(worker.replies).toContainEqual({ id: id + 1, error: 'params 里不能用 __proto__/constructor/prototype 作键名' })
    }
    expect(aws).not.toHaveBeenCalled()
    done(worker)
    await pending
  })

  it('ignores forged ids and duplicate aws requests', async () => {
    const { worker, pending, aws } = start()
    const base = { type: 'aws', service: 'ec2', action: 'DescribeVpcs', params: '{}', opts: '{}' }
    worker.send({ ...base, id: 'other' })
    worker.send({ ...base, id: -1 })
    worker.send({ ...base, id: 1 })
    worker.send({ ...base, id: 1 })
    await tick()
    expect(aws).toHaveBeenCalledTimes(1)
    done(worker)
    await pending
    worker.send({ ...base, id: 2 })
    expect(aws).toHaveBeenCalledTimes(1)
  })

  it('turns worker errors, OOM, and exits into settled tool errors', async () => {
    for (const [event, arg, cause, text] of [
      ['error', new Error('crash'), 'error', '内部错误'],
      ['messageerror', new Error('clone failed'), 'error', '内部错误'],
      ['error', Object.assign(new Error('out'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }), 'memory', '内存'],
      ['exit', 1, 'error', '意外退出']
    ] as const) {
      const { worker, pending } = start()
      worker.send({ type: 'ready' })
      worker.emit(event, arg)
      expect(await pending).toMatchObject({ ok: false, cause, error: expect.stringContaining(text) })
    }
  })

  it('fails startup after 15 seconds without ready', async () => {
    vi.useFakeTimers()
    const { pending } = start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toMatchObject({ ok: false, cause: 'timeout', error: '脚本沙箱启动超时' })
  })

  it('charges main-observed compute even when the worker reports zero CPU', async () => {
    const { worker, pending } = start(undefined, { scriptCpuMs: 30 })
    worker.send({ type: 'enter' })
    await new Promise((resolve) => setTimeout(resolve, 45))
    worker.send({ type: 'yield', cpuUsed: 0 })
    expect(await pending).toMatchObject({ ok: false, cause: 'timeout', error: expect.stringContaining('累计本地计算') })
  })

  it('settles even when terminate rejects', async () => {
    const { worker, pending } = start()
    worker.terminate.mockRejectedValueOnce(new Error('already gone'))
    done(worker)
    expect(await pending).toMatchObject({ ok: true, value: 1 })
  })
})
