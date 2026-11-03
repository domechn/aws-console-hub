import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Model } from '@earendil-works/pi-ai'

export type WatchEvent = { type: 'waiting' | 'first' | 'retrying' | 'stalled' | 'done'; phase: 'first' | 'idle'; ms: number; attempt: number }
export type WatchLimits = { firstEventMs: number; idleMs: number }

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

/** One model call. Retry only before any provider event reaches pi, so no message or tool call can be duplicated. */
export async function watchedStream(
  open: (signal: AbortSignal) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  model: Model<any>,
  signal: AbortSignal | undefined,
  limits: WatchLimits,
  onEvent: (event: WatchEvent) => void
): Promise<AssistantMessageEventStream> {
  const output = createAssistantMessageEventStream()
  void (async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      let timer: ReturnType<typeof setTimeout> | undefined
      let abortListener: (() => void) | undefined
      let partial: AssistantMessage | undefined
      let heldStart: AssistantMessageEvent | undefined
      let count = 0
      const started = Date.now()
      let last = started
      const next = async <T>(work: Promise<T>, timeout: number): Promise<T> => {
        return Promise.race([
          work,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('stalled')), timeout) }),
          new Promise<never>((_, reject) => {
            abortListener = () => reject(new Error('aborted'))
            controller.signal.addEventListener('abort', abortListener, { once: true })
            if (controller.signal.aborted) abortListener()
          })
        ]).finally(() => {
          clearTimeout(timer)
          if (abortListener) controller.signal.removeEventListener('abort', abortListener)
        })
      }
      try {
        onEvent({ type: 'waiting', phase: 'first', ms: 0, attempt })
        if (controller.signal.aborted) throw new Error('aborted')
        const stream = await next(Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error('aborted')
          return open(controller.signal)
        }), limits.firstEventMs)
        const iterator = stream[Symbol.asyncIterator]()
        while (true) {
          if (controller.signal.aborted) throw new Error('aborted')
          const step = await next(iterator.next(), count ? limits.idleMs : Math.max(0, limits.firstEventMs - (Date.now() - started)))
          if (step.done) {
            output.end(await stream.result())
            onEvent({ type: 'done', phase: count ? 'idle' : 'first', ms: Date.now() - started, attempt })
            return
          }
          const event = step.value as AssistantMessageEvent
          if (event.type === 'start' && count === 0) {
            heldStart = event
            continue
          }
          count++
          if (count === 1) onEvent({ type: 'first', phase: 'first', ms: Date.now() - started, attempt })
          last = Date.now()
          if ('partial' in event) partial = event.partial
          if (heldStart) output.push(heldStart)
          heldStart = undefined
          output.push(event)
          if (event.type === 'done' || event.type === 'error') {
            onEvent({ type: 'done', phase: 'idle', ms: Date.now() - started, attempt })
            return
          }
        }
      } catch (error) {
        const ms = Date.now() - (count ? last : started)
        const aborted = signal?.aborted || (error instanceof Error && error.message === 'aborted')
        const stalled = !aborted && error instanceof Error && error.message === 'stalled'
        if (stalled) onEvent({ type: 'stalled', phase: count ? 'idle' : 'first', ms, attempt })
        controller.abort()
        if (stalled && count === 0 && attempt === 1 && !signal?.aborted) {
          onEvent({ type: 'retrying', phase: 'first', ms, attempt })
          continue
        }
        const message = aborted ? '已停止' : stalled && count === 0
          ? `模型 ${limits.firstEventMs / 1000} 秒没有响应（连接可能已断开）。`
          : stalled ? `模型连续 ${limits.idleMs / 1000} 秒没有新响应（连接可能已断开）。`
            : error instanceof Error ? error.message : String(error)
        output.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: { ...partial, role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: partial?.content ?? [], usage: partial?.usage ?? usage, stopReason: aborted ? 'aborted' : 'error', errorMessage: message, timestamp: partial?.timestamp ?? started } })
        return
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }
  })()
  return output
}
