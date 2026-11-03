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
    expect(regenerate).toHaveBeenCalledWith('acc-1', 'chat-1', 3, '原文', '重试', undefined)
    expect(() => handle(trusted, 'acc-1', 'chat-1', 3, '原文', '重试', { resources: [{ type: 'fake', id: 'x', region: 'global' }] })).toThrow('无效的资源引用')
    await handle(trusted, 'acc-1', 'chat-1', 3, '原文', '重试', { resources: [] })
    expect(regenerate).toHaveBeenLastCalledWith('acc-1', 'chat-1', 3, '原文', '重试', { resources: [] })
  })
})

describe('P3 IPC', () => {
  it('validates resource context and deny-only operations before dispatch', async () => {
    const frame = {}
    const contents = { mainFrame: frame }
    const send = vi.fn(async () => ({ conversationId: 'chat-1', runId: 1 }))
    const denyAll = vi.fn(() => ({ approvals: 0, proposals: 0 }))
    registerAiIpc({ webContents: contents } as never, { send, denyAll } as never, () => {})
    const trusted = { sender: contents, senderFrame: frame }
    const sendHandle = handlers.get('ai:send')!
    expect(() => sendHandle(trusted, 'acc-1', null, 'hello', true, { resources: [{ type: 'invalid', id: 'x', region: 'global' }] })).toThrow()
    expect(send).not.toHaveBeenCalled()
    await sendHandle(trusted, 'acc-1', null, 'hello', true, { resources: [] })
    expect(send).toHaveBeenCalledWith('acc-1', null, 'hello', true, { resources: [] })
    const deny = handlers.get('ai:deny-all')!
    expect(() => deny(trusted, '../x', 'chat-1')).toThrow()
    expect(deny(trusted, 'acc-1', 'chat-1')).toEqual({ approvals: 0, proposals: 0 })
    expect(denyAll).toHaveBeenCalledWith('acc-1', 'chat-1')
  })
})

describe('attachment IPC contract', () => {
  it('forwards bytes, ids, and owned fetch only from the trusted frame', async () => {
    const frame = {}
    const contents = { mainFrame: frame }
    const ai = { attachmentPrepare: vi.fn(() => [{ ok: true, id: 'x' }]), attachmentDiscard: vi.fn(), attachmentGet: vi.fn(() => ({ kind: 'file', text: 'hello' })), send: vi.fn(() => ({ conversationId: 'c', runId: 1 })) }
    registerAiIpc({ webContents: contents } as never, ai as never, () => {})
    const trusted = { sender: contents, senderFrame: frame }
    const bytes = Uint8Array.of(65)
    const prep = handlers.get('ai:attachment-prepare')!
    expect(() => prep({ sender: {}, senderFrame: frame }, 'a', null, [{ name: 'x.txt', bytes }])).toThrow('forbidden')
    expect(prep(trusted, 'a', null, [{ name: 'x.txt', bytes }])).toEqual([{ ok: true, id: 'x' }])
    expect(ai.attachmentPrepare).toHaveBeenCalledWith('a', null, [{ name: 'x.txt', bytes }])
    handlers.get('ai:attachment-discard')!(trusted, 'a', 'x')
    expect(ai.attachmentDiscard).toHaveBeenCalledWith('a', 'x')
    expect(handlers.get('ai:attachment-get')!(trusted, 'a', 'c', 'x')).toEqual({ kind: 'file', text: 'hello' })
    expect(ai.attachmentGet).toHaveBeenCalledWith('a', 'c', 'x')
    handlers.get('ai:send')!(trusted, 'a', 'c', 'hello', true, undefined, ['x'])
    expect(ai.send).toHaveBeenCalledWith('a', 'c', 'hello', true, undefined, ['x'])
  })
})
