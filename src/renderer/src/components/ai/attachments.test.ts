import { describe, expect, it } from 'vitest'
import { ATTACH_LIMITS } from '../../../../shared/ai'
import { chipReducer, classifyAttachment, chooseImageOutput, expiredChips, sendText, sourceFromFile, type AttachmentChip } from './attachments'

describe('attachment input', () => {
  it('rejects secret filenames and oversized text before reading bytes', () => {
    expect(classifyAttachment({ name: '.env.local', size: 1, type: '' }, true).reason).toBe('疑似凭证文件，已拒绝')
    expect(classifyAttachment({ name: 'notes.txt', size: 300 * 1024, type: '' }, true).kind).toBe('file')
    expect(classifyAttachment({ name: 'notes.txt', size: 1.5 * 1024 * 1024, type: '' }, true).reason).toBe('超过 1 MB，已拒绝')
    expect(classifyAttachment({ name: 'notes.pdf', size: 10, type: '' }, true).reason).toBe('不支持此文件类型')
  })
  it('normalizes names and rejects credential patterns', () => {
    for (const name of ['ＣＲＥＤＥＮＴＩＡＬＳ.txt', 'mySecretNotes.md', 'server.key.bak', 'test.PEM', 'id_ed25519.pub', 'notes.KDBX']) {
      expect(classifyAttachment({ name, size: 1, type: '' }, true).reason).toBe('疑似凭证文件，已拒绝')
    }
  })
  it('applies separate image and file limits and model support', () => {
    expect(classifyAttachment({ name: 'a.webp', size: 10, type: 'image/webp' }, false).reason).toBe('当前模型不支持图片')
    expect(classifyAttachment({ name: 'a.png', size: 10, type: 'image/png' }, true, 4, 0).reason).toContain('4')
    expect(classifyAttachment({ name: 'a.txt', size: 10, type: '' }, true, 0, 3).reason).toContain('3')
    expect(classifyAttachment({ name: 'a.txt', size: 1024, type: '' }, true, 0, 1, ATTACH_LIMITS.textTotalBytes).reason).toContain('400')
    expect(classifyAttachment({ name: 'a.png', size: ATTACH_LIMITS.imageInputBytes + 1, type: 'image/png' }, true).reason).toBe('图片太大')
  })
  it('preserves non-JPEG image alpha and bounds both dimensions', () => {
    expect(chooseImageOutput('image/gif', 4000, 1000)).toEqual({ mime: 'image/png', width: ATTACH_LIMITS.imageOutputSidePx, height: ATTACH_LIMITS.imageOutputSidePx / 4 })
    expect(chooseImageOutput('image/jpeg', 1000, 4000).mime).toBe('image/jpeg')
    expect(chooseImageOutput('image/webp', 100, 100).mime).toBe('image/png')
  })
  it('expires prepared chips and supplies attachment-only text', () => {
    const chip = { localId: 'a', kind: 'file', name: 'a.txt', size: 1, state: 'ready', id: 'id', createdAt: 1 } as AttachmentChip
    expect(expiredChips([chip], 600_001)).toEqual([])
    expect(sendText(' ', [chip])).toBe('请看附件。')
    expect(sendText(' hello ', [chip])).toBe(' hello ')
  })
  it('uses an injected image codec to prepare bytes without a path', async () => {
    const file = { name: 'shot.gif', type: 'image/gif', arrayBuffer: async () => new ArrayBuffer(1) } as File
    const source = await sourceFromFile(file, 'image', async () => ({ bytes: new Uint8Array([1, 2]), mime: 'image/png' }))
    expect(source).toEqual({ name: 'shot.gif', bytes: new Uint8Array([1, 2]), hintMime: 'image/png' })
  })
  it('reads a 300 KiB text file for backend truncation', async () => {
    const bytes = new Uint8Array(300 * 1024)
    const file = { name: 'notes.txt', type: 'text/plain', arrayBuffer: async () => bytes.buffer } as File
    expect((await sourceFromFile(file, 'file')).bytes.byteLength).toBe(300 * 1024)
  })
  it('rejects an oversized converted image before upload', async () => {
    const file = { name: 'large.webp', type: 'image/webp' } as File
    await expect(sourceFromFile(file, 'image', async () => ({ bytes: new Uint8Array(ATTACH_LIMITS.imageInputBytes + 1), mime: 'image/png' }))).rejects.toThrow('图片太大')
  })
  it('removes a preparing chip so a late result cannot restore it', () => {
    const chip = { localId: 'local', kind: 'image', name: 'shot.png', size: 10, state: 'preparing', id: '', createdAt: 1 } as AttachmentChip
    const removed = chipReducer([chip], { type: 'remove', localId: 'local' })
    expect(chipReducer(removed, { type: 'prepared', localId: 'local', chip: { ...chip, id: 'ready', state: 'ready' } })).toEqual([])
  })

})

describe('attachment safety', () => {
  it('accepts only supported inline image data', async () => {
    const { safeImageSrc } = await import('./attachments')
    expect(safeImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(safeImageSrc('data:image/svg+xml;base64,AAAA')).toBeUndefined()
    expect(safeImageSrc('javascript:alert(1)')).toBeUndefined()
  })
  it('restores each prepared attachment at most once', () => {
    const chip = { localId: 'a', kind: 'file', name: 'a.txt', size: 1, state: 'ready', id: 'id', createdAt: 1 } as AttachmentChip
    expect(chipReducer([chip], { type: 'restore', chips: [chip], now: 2 })).toEqual([chip])
  })
})

describe('input routing', () => {
  it.each([
    ['rich text with a preview image', { text: 'cells', html: '<table>x</table>', files: [{ type: 'image/png' }] }, false],
    ['html with an image', { text: '', html: '<b>x</b>', files: [{ type: 'image/png' }] }, false],
    ['whitespace text with an image', { text: ' ', html: '', files: [{ type: 'image/png' }] }, false],
    ['screenshot', { text: '', html: '', files: [{ type: 'image/png' }] }, true],
    ['a file alongside text', { text: 'caption', html: '', files: [{ type: 'text/plain' }] }, true],
    ['empty clipboard', { text: '', html: '', files: [] }, false]
  ] as const)('%s', async (_name, input, expected) => {
    const { shouldAttachPaste } = await import('./attachments')
    expect(shouldAttachPaste(input)).toBe(expected)
  })
  it('resets a file drag on an outside transition or window cancellation', async () => {
    const { dragFilesVisible } = await import('./attachments')
    expect(dragFilesVisible(false, 'enter', true)).toBe(true)
    expect(dragFilesVisible(true, 'leave', true)).toBe(true)
    expect(dragFilesVisible(true, 'leave', false)).toBe(false)
    expect(dragFilesVisible(true, 'reset', true)).toBe(false)
  })
})

it('rejects a huge declared PNG before asking Chromium to decode it', async () => {
  const { vi } = await import('vitest')
  const bitmap = vi.fn()
  vi.stubGlobal('createImageBitmap', bitmap)
  const header = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,234,96,0,0,234,96])
  const file = { name: 'huge.png', type: 'image/png', slice: () => ({ arrayBuffer: async () => header.buffer }) } as unknown as File
  await expect(sourceFromFile(file, 'image')).rejects.toThrow('图片尺寸超出限制')
  expect(bitmap).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

it('discards a prepared result if its chip was removed while preparation ran', async () => {
  const { discardLatePrepared } = await import('./attachments')
  const chip = { localId: 'local', kind: 'image', name: 'shot.png', size: 10, state: 'preparing', id: '', createdAt: 1 } as AttachmentChip
  expect(discardLatePrepared(chipReducer([chip], { type: 'remove', localId: chip.localId }), chip.localId, true)).toBe(true)
  expect(discardLatePrepared([chip], chip.localId, true)).toBe(false)
})
