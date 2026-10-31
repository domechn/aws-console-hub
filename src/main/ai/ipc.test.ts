import { describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, fn) } }))

const { registerAiIpc } = await import('./ipc')

describe('ai:regenerate IPC', () => {
  it('checks sender, ids, index and edited prompt before calling the service', async () => {
    const frame = {}
    const contents = { mainFrame: frame }
    const regenerate = vi.fn(async () => ({ conversationId: 'chat-1', runId: 2 }))
    registerAiIpc({ webContents: contents } as never, { regenerate } as never, () => {})
    const handle = handlers.get('ai:regenerate')!
    const trusted = { sender: contents, senderFrame: frame }
    const untrusted = { sender: {}, senderFrame: frame }

    expect(() => handle(untrusted, 'acc-1', 'chat-1', 0)).toThrow('forbidden')
    for (const bad of [-1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) expect(() => handle(trusted, 'acc-1', 'chat-1', bad)).toThrow('无效的消息位置')
    for (const bad of ['', 'x'.repeat(8001), {}]) expect(() => handle(trusted, 'acc-1', 'chat-1', 0, bad)).toThrow()
    expect(() => handle(trusted, '../other', 'chat-1', 0)).toThrow()
    expect(regenerate).not.toHaveBeenCalled()
    await expect(handle(trusted, 'acc-1', 'chat-1', 3, '原文', '  重试  ')).resolves.toEqual({ conversationId: 'chat-1', runId: 2 })
    expect(regenerate).toHaveBeenCalledWith('acc-1', 'chat-1', 3, '原文', '重试')
  })
})
