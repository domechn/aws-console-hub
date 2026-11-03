import { createAssistantMessageEventStream, fauxAssistantMessage, type AssistantMessageEvent, type Model } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { watchedStream } from './watchdog'

const model = { api: 'faux', provider: 'faux', id: 'faux-1' } as Model<'faux'>
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function source(events: AssistantMessageEvent[] = []) {
  const stream = createAssistantMessageEventStream()
  for (const event of events) stream.push(event)
  return stream
}

describe('model request watchdog', () => {
  it('retries a second request with no event once, then reports a retryable error', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const statuses: string[] = []
      const stalled = () => { calls++; return source() }
      const first = source()
      first.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage('first') })
      const run = (open: typeof stalled) => watchedStream(open, model, undefined, { firstEventMs: 60_000, idleMs: 90_000 }, (s) => statuses.push(s.type))
      expect((await (await run(() => first)).result()).content).toEqual([{ type: 'text', text: 'first' }])
      const reply = await run(stalled)
      const result = reply.result()
      await vi.advanceTimersByTimeAsync(120_000)
      expect((await result).errorMessage).toContain('模型 60 秒没有响应')
      expect((await result).usage.input).toBe(0)
      expect(calls).toBe(2)
      expect(statuses).toContain('retrying')
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('retries when headers arrive but no content event follows', async () => {
    vi.useFakeTimers()
    try {
      const partial = fauxAssistantMessage('')
      partial.usage.input = 5
      const open = vi.fn(() => source([{ type: 'start', partial }]))
      const reply = await watchedStream(open, model, undefined, { firstEventMs: 60_000, idleMs: 90_000 }, () => {})
      const result = reply.result()
      await vi.advanceTimersByTimeAsync(120_000)
      expect((await result).stopReason).toBe('error')
      expect((await result).usage.input).toBe(0)
      expect(open).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('allows a first text token at 40 seconds', async () => {
    vi.useFakeTimers()
    try {
      const stream = source()
      const open = vi.fn(() => stream)
      const statuses: string[] = []
      const reply = await watchedStream(open, model, undefined, { firstEventMs: 60_000, idleMs: 90_000 }, (event) => statuses.push(event.type))
      vi.advanceTimersByTime(40_000)
      stream.push({ type: 'start', partial: fauxAssistantMessage('') })
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'slow answer', partial: fauxAssistantMessage('slow answer') })
      stream.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage('slow answer') })
      await flush()
      expect((await reply.result()).content).toEqual([{ type: 'text', text: 'slow answer' }])
      expect(open).toHaveBeenCalledTimes(1)
      expect(statuses).not.toContain('stalled')
    } finally { vi.useRealTimers() }
  })

  it('lets Stop interrupt a held start without opening a second request', async () => {
    vi.useFakeTimers()
    try {
      const stop = new AbortController()
      const stream = source()
      const open = vi.fn(() => stream)
      const reply = await watchedStream(open, model, stop.signal, { firstEventMs: 60_000, idleMs: 90_000 }, () => {})
      stream.push({ type: 'start', partial: fauxAssistantMessage('') })
      await flush()
      stop.abort()
      expect((await reply.result()).stopReason).toBe('aborted')
      expect(open).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('passes start then provider error through in order with one open', async () => {
    const stream = source()
    const open = vi.fn(() => stream)
    const reply = await watchedStream(open, model, undefined, { firstEventMs: 60_000, idleMs: 90_000 }, () => {})
    stream.push({ type: 'start', partial: fauxAssistantMessage('') })
    stream.push({ type: 'error', reason: 'error', error: { ...fauxAssistantMessage('error'), stopReason: 'error' } })
    expect((await reply.result()).stopReason).toBe('error')
    const types: string[] = []
    for await (const event of reply) types.push(event.type)
    expect(types).toEqual(['start', 'error'])
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not retry after content follows start', async () => {
    vi.useFakeTimers()
    try {
      const stream = source()
      const open = vi.fn(() => stream)
      const reply = await watchedStream(open, model, undefined, { firstEventMs: 60_000, idleMs: 90_000 }, () => {})
      const partial = fauxAssistantMessage('hello')
      stream.push({ type: 'start', partial })
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'hello', partial })
      await vi.advanceTimersByTimeAsync(90_000)
      expect((await reply.result()).stopReason).toBe('error')
      expect(open).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('returns the successful second attempt after a first-event stall', async () => {
    vi.useFakeTimers()
    try {
      const second = source([{ type: 'done', reason: 'stop', message: fauxAssistantMessage('recovered') }])
      const open = vi.fn().mockImplementationOnce(() => source()).mockImplementationOnce(() => second)
      const statuses: string[] = []
      const reply = await watchedStream(open, model, undefined, { firstEventMs: 60_000, idleMs: 90_000 }, (event) => statuses.push(event.type))
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await reply.result()).content).toEqual([{ type: 'text', text: 'recovered' }])
      expect(open).toHaveBeenCalledTimes(2)
      expect(statuses).toContain('retrying')
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('resets the idle timer after each content event', async () => {
    vi.useFakeTimers()
    try {
      const stream = source()
      const open = vi.fn(() => stream)
      const statuses: string[] = []
      const reply = await watchedStream(open, model, undefined, { firstEventMs: 60_000, idleMs: 90_000 }, (event) => statuses.push(event.type))
      stream.push({ type: 'start', partial: fauxAssistantMessage('') })
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'a', partial: fauxAssistantMessage('a') })
      await vi.advanceTimersByTimeAsync(60_000)
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'b', partial: fauxAssistantMessage('ab') })
      await vi.advanceTimersByTimeAsync(60_000)
      stream.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage('ab') })
      expect((await reply.result()).stopReason).toBe('stop')
      expect(statuses).not.toContain('stalled')
      expect(open).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('clears timers after provider error and Stop during a stream', async () => {
    vi.useFakeTimers()
    try {
      const errorStream = source()
      const errored = await watchedStream(() => errorStream, model, undefined, { firstEventMs: 60_000, idleMs: 90_000 }, () => {})
      errorStream.push({ type: 'error', reason: 'error', error: fauxAssistantMessage('error') })
      await errored.result()
      expect(vi.getTimerCount()).toBe(0)
      const stop = new AbortController()
      const stream = source()
      const stopped = await watchedStream(() => stream, model, stop.signal, { firstEventMs: 60_000, idleMs: 90_000 }, () => {})
      stream.push({ type: 'start', partial: fauxAssistantMessage('') })
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'a', partial: fauxAssistantMessage('a') })
      await flush()
      stop.abort()
      expect((await stopped.result()).stopReason).toBe('aborted')
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('lets Stop win during the retry and never opens another request', async () => {
    vi.useFakeTimers()
    try {
      const stop = new AbortController()
      const open = vi.fn(() => source())
      const reply = await watchedStream(open, model, stop.signal, { firstEventMs: 60_000, idleMs: 90_000 }, (event) => {
        if (event.type === 'retrying') stop.abort()
      })
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await reply.result()).stopReason).toBe('aborted')
      expect(open).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
})
