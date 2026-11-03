import { describe, expect, it, vi } from 'vitest'
import { runTabAction } from './tabIpc'

describe('runTabAction', () => {
  it('reports a synchronous tab failure without throwing', async () => {
    const report = vi.fn()
    await expect(runTabAction(() => { throw new Error('private URL') }, report)).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledOnce()
  })

  it('reports an asynchronous navigation failure without rejecting', async () => {
    const report = vi.fn()
    await expect(runTabAction(() => Promise.reject(new Error('private URL')), report)).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledOnce()
  })

  it('passes the original error to the reporting boundary', async () => {
    const report = vi.fn()
    const error = new TypeError('secret')
    await runTabAction(() => { throw error }, report)
    expect(report).toHaveBeenCalledWith(error)
  })
})
