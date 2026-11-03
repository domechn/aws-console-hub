import { createHash, randomBytes } from 'node:crypto'
import { nativeImage } from 'electron'
import { TEXT_ATTACHMENT_EXTENSIONS } from '../../shared/attachmentTypes'
import { ATTACH_LIMITS, type AttachmentMeta, type AttachmentPrepareResult, type AttachmentSource } from '../../shared/ai'
import { redactAttachmentSecrets } from './redact'

export const ATTACHMENT_EXPIRED = '附件已过期，请重新添加'
export const imageTokenEstimate = (width?: number, height?: number): number =>
  width && height ? Math.max(1200, Math.min(3300, Math.ceil(width * height / 750))) : 1600
const ALLOWED = new Set(TEXT_ATTACHMENT_EXTENSIONS)
const FORBIDDEN = /^(?:\.env.*|id_rsa.*|id_ed25519.*|credentials.*)|secret|\.key\.|\.(?:pem|key|p12|pfx|kdbx|keystore)$/i

export interface ImageCodec {
  decode(bytes: Uint8Array): { width: number; height: number }
  encode(bytes: Uint8Array, width: number, height: number, quality: number): Uint8Array
  thumbnail(bytes: Uint8Array): Uint8Array
}
/** Remove EXIF before decode so platform auto-rotation cannot double-apply our transform. */
export function stripJpegExif(bytes: Uint8Array): { bytes: Uint8Array; orientation: number } {
  let at = 2, orientation = 1
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)]
  let changed = false
  while (at + 4 <= Math.min(bytes.length, 1024 * 1024)) {
    const start = at
    if (bytes[at++] !== 255) break
    while (bytes[at] === 255) at++
    const marker = bytes[at++]
    if (marker === 0xd9 || marker === 0xda) { at = start; break }
    if (at + 2 > bytes.length) break
    const length = (bytes[at] << 8) | bytes[at + 1]
    if (length < 2 || at + length > bytes.length) break
    const end = at + length
    const exif = marker === 0xe1 && bytes[at + 2] === 69 && bytes[at + 3] === 120 && bytes[at + 4] === 105 && bytes[at + 5] === 102 && bytes[at + 6] === 0 && bytes[at + 7] === 0
    if (exif) {
      changed = true
      const tiff = at + 8
      const little = bytes[tiff] === 73 && bytes[tiff + 1] === 73
      const big = bytes[tiff] === 77 && bytes[tiff + 1] === 77
      if (little || big) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const read16 = (p: number) => view.getUint16(p, little)
        const read32 = (p: number) => view.getUint32(p, little)
        if (tiff + 8 <= end && read16(tiff + 2) === 42) {
          const ifd = tiff + read32(tiff + 4)
          if (ifd + 2 <= end) for (let i = 0, count = Math.min(read16(ifd), 128); i < count; i++) {
            const entry = ifd + 2 + i * 12
            if (entry + 12 > end) break
            if (read16(entry) === 0x112 && read16(entry + 2) === 3 && read32(entry + 4) === 1) {
              const value = read16(entry + 8)
              if (value >= 1 && value <= 8) orientation = value
              break
            }
          }
        }
      }
    } else chunks.push(bytes.subarray(start, end))
    at = end
  }
  if (!changed) return { bytes, orientation }
  chunks.push(bytes.subarray(at))
  return { bytes: Buffer.concat(chunks), orientation }
}

export function orientBitmap(bitmap: Uint8Array, width: number, height: number, orientation: number): Buffer {
  if (orientation === 1) return Buffer.from(bitmap)
  const out = Buffer.alloc(bitmap.length)
  const destWidth = orientation >= 5 ? height : width
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [dx, dy] = orientation === 2 ? [width - 1 - x, y] : orientation === 3 ? [width - 1 - x, height - 1 - y] :
      orientation === 4 ? [x, height - 1 - y] : orientation === 5 ? [y, x] : orientation === 6 ? [height - 1 - y, x] :
        orientation === 7 ? [height - 1 - y, width - 1 - x] : [y, width - 1 - x]
    out.set(bitmap.subarray((y * width + x) * 4, (y * width + x + 1) * 4), (dy * destWidth + dx) * 4)
  }
  return out
}

const decodedImages = new WeakMap<Uint8Array, ReturnType<typeof nativeImage.createFromBuffer>>()
export const nativeImageCodec: ImageCodec = {
  decode(bytes) {
    const raw = sniffImage(bytes) === 'image/jpeg' ? stripJpegExif(bytes) : { bytes, orientation: 1 }
    let image = nativeImage.createFromBuffer(Buffer.from(raw.bytes))
    if (image.isEmpty()) throw new Error('图片无法解码')
    if (raw.orientation !== 1) {
      const { width, height } = image.getSize()
      const rotated = orientBitmap(image.toBitmap(), width, height, raw.orientation)
      image = nativeImage.createFromBitmap(rotated, { width: raw.orientation >= 5 ? height : width, height: raw.orientation >= 5 ? width : height })
    }
    decodedImages.set(bytes, image)
    return image.getSize()
  },
  encode(bytes, width, height, quality) {
    const source = decodedImages.get(bytes)
    if (!source) throw new Error('图片无法解码')
    const resized = source.resize({ width, height })
    const bitmap = resized.toBitmap()
    // Preserve alpha as PNG; nativeImage has no portable white compositing operation.
    const transparent = bitmap.some((v, i) => i % 4 === 3 && v < 255)
    const encoded = transparent ? resized.toPNG() : resized.toJPEG(quality)
    decodedImages.set(encoded, resized)
    return encoded
  },
  thumbnail(bytes) {
    const image = decodedImages.get(bytes)
    if (!image) throw new Error('图片无法解码')
    const { width, height } = image.getSize()
    for (const side of [ATTACH_LIMITS.thumbnailSidePx, ATTACH_LIMITS.thumbnailSidePx / 2, ATTACH_LIMITS.thumbnailSidePx / 4]) {
      const ratio = Math.min(1, side / Math.max(width, height))
      const scaled = image.resize({ width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)), quality: 'good' })
      if (sniffImage(bytes) === 'image/png') {
        const thumb = scaled.toPNG()
        if (thumb.length <= ATTACH_LIMITS.thumbnailBytes) return thumb
      } else for (const quality of [75, 55, 35, 20]) {
        const thumb = scaled.toJPEG(quality)
        if (thumb.length <= ATTACH_LIMITS.thumbnailBytes) return thumb
      }
    }
    throw new Error('缩略图太大')
  }
}

/** Read only bounded headers before nativeImage can allocate decoded pixels. */
export function imageHeaderSize(bytes: Uint8Array, mime: 'image/png' | 'image/jpeg'): { width: number; height: number } | null {
  if (mime === 'image/png') {
    if (bytes.length < 24 || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  let at = 2
  const end = Math.min(bytes.length, 1024 * 1024)
  while (at < end) {
    if (bytes[at++] !== 255) return null
    while (at < end && bytes[at] === 255) at++
    if (at >= end) return null
    const marker = bytes[at++]
    if (marker === 0xd9 || marker === 0xda) return null
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (at + 2 > end) return null
    const length = (bytes[at] << 8) | bytes[at + 1]
    if (length < 2 || at + length > end) return null
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 7) return null
      return { height: (bytes[at + 3] << 8) | bytes[at + 4], width: (bytes[at + 5] << 8) | bytes[at + 6] }
    }
    at += length
  }
  return null
}

export interface AttachmentData extends AttachmentMeta {
  mime: string
  sha256: string
  text?: string
  bytes?: Uint8Array
  thumb?: Uint8Array
}
export function sanitizeAttachmentName(name: string): string {
  return (name.normalize('NFKC').split(/[\\/]/).at(-1) ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名'
}
export function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  return null
}
function forbiddenMagic(bytes: Uint8Array): boolean {
  const starts = (v: number[]) => v.every((b, i) => bytes[i] === b)
  return starts([37, 80, 68, 70, 45]) || starts([80, 75, 3, 4]) || starts([31, 139]) ||
    starts([127, 69, 76, 70]) || starts([77, 90]) || starts([208, 207, 17, 224]) ||
    (bytes.length > 262 && [117, 115, 116, 97, 114].every((b, i) => bytes[257 + i] === b))
}
function fail(name: string, reason: string): AttachmentPrepareResult { return { ok: false, name, reason } }
export function attachmentMeta(item: AttachmentData): AttachmentMeta {
  const { id, kind, name, size, width, height, redactions, truncated } = item
  return { id, kind, name, size, ...(width !== undefined && { width }), ...(height !== undefined && { height }), ...(redactions !== undefined && { redactions }), ...(truncated !== undefined && { truncated }) }
}
export class AttachmentPreparer {
  private pending = new Map<string, { accountId: string; conversationId: string | null; expires: number; data: AttachmentData }>()
  constructor(private codec: ImageCodec = nativeImageCodec, private now: () => number = Date.now) {}
  sweep(): void { for (const [id, item] of this.pending) if (item.expires <= this.now()) this.pending.delete(id) }
  prepare(accountId: string, conversationId: string | null, files: AttachmentSource[], canAttachImages: boolean): AttachmentPrepareResult[] {
    this.sweep()
    if (!Array.isArray(files) || files.length > ATTACH_LIMITS.fileCount) throw new Error('附件数量超出限制')
    const validFiles = files.filter((f) => f && typeof f.name === 'string' && f.bytes instanceof Uint8Array && Number.isSafeInteger(f.bytes.byteLength))
    if (validFiles.reduce((n, f) => n + f.bytes.byteLength, 0) > ATTACH_LIMITS.payloadBytes) throw new Error('附件总大小超出限制')
    return files.map((file) => {
      const name = typeof file?.name === 'string' ? sanitizeAttachmentName(file.name) : '未命名'
      const bytes = file?.bytes
      if (!(bytes instanceof Uint8Array) || typeof file?.name !== 'string' || !Number.isSafeInteger(bytes.byteLength)) return fail(name, '附件数据无效')
      if ([...this.pending.values()].filter((v) => v.accountId === accountId).length >= ATTACH_LIMITS.pendingPerAccount) return fail(name, '待发送附件最多 8 个')
      const mime = sniffImage(bytes)
      const imageNamed = /\.(?:png|jpe?g|webp|gif)$/i.test(name) || (typeof file.hintMime === 'string' && file.hintMime.startsWith('image/'))
      let data: AttachmentData
      if (imageNamed || mime) {
        if (!canAttachImages) return fail(name, '当前模型不支持图片，请换一个支持图片的模型')
        if (!mime) return fail(name, '请先将图片转换为 PNG 或 JPEG')
        if (bytes.length > ATTACH_LIMITS.imageInputBytes) return fail(name, '图片太大')
        const header = imageHeaderSize(bytes, mime)
        if (!header) return fail(name, '图片头无效')
        if (header.width <= 0 || header.height <= 0 || header.width > ATTACH_LIMITS.imageSidePx || header.height > ATTACH_LIMITS.imageSidePx || header.width * header.height > ATTACH_LIMITS.imagePixels) return fail(name, '图片尺寸超出限制')
        let dimensions: { width: number; height: number }
        try { dimensions = this.codec.decode(bytes) } catch { return fail(name, '图片无法解码') }
        const { width, height } = dimensions
        if (width <= 0 || height <= 0 || width > ATTACH_LIMITS.imageSidePx || height > ATTACH_LIMITS.imageSidePx || width * height > ATTACH_LIMITS.imagePixels) return fail(name, '图片尺寸超出限制')
        const ratio = Math.min(1, ATTACH_LIMITS.imageOutputSidePx / Math.max(width, height))
        const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio))
        let encoded: Uint8Array = new Uint8Array()
        let thumb: Uint8Array
        try {
          for (const q of [85, 70, 55, 40]) { encoded = this.codec.encode(bytes, w, h, q); if (encoded.length <= ATTACH_LIMITS.imageOutputBytes || sniffImage(encoded) === 'image/png') break }
          if (encoded.length > ATTACH_LIMITS.imageOutputBytes) return fail(name, '处理后的图片超过 3.74 MB')
          thumb = this.codec.thumbnail(encoded)
        } catch { return fail(name, '图片无法处理') }
        const imageMime = sniffImage(encoded) ?? 'image/jpeg'
        const thumbMime = sniffImage(thumb) ?? 'image/jpeg'
        if (Buffer.byteLength(`data:${thumbMime};base64,${Buffer.from(thumb).toString('base64')}`) > ATTACH_LIMITS.thumbnailBytes) return fail(name, '缩略图太大')
        data = { id: randomBytes(24).toString('hex'), kind: 'image', name, size: encoded.length, width: w, height: h, mime: imageMime, bytes: encoded, thumb, sha256: createHash('sha256').update(encoded).digest('hex') }
      } else {
        if (bytes.length > ATTACH_LIMITS.textInputBytes) return fail(name, '文本文件太大')
        if (FORBIDDEN.test(name)) return fail(name, '疑似凭证文件，已拒绝')
        if (forbiddenMagic(bytes)) return fail(name, '不支持此文件类型')
        const ext = name.toLowerCase().split('.').at(-1)!
        if (name.includes('.') && !ALLOWED.has(ext)) return fail(name, '不支持此文件类型')
        if (bytes.includes(0)) return fail(name, '看起来不是文本文件')
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, '').normalize('NFKC') } catch { return fail(name, '看起来不是文本文件') }
        if ((text.match(/[\u0001-\u0008\u000b\u000e-\u001f\u007f]/g) ?? []).length / Math.max(1, text.length) > 0.02) return fail(name, '看起来不是文本文件')
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text)) return fail(name, '含私钥，已拒绝')
        const redacted = redactAttachmentSecrets(text)
        const redactions = (redacted.match(/\[redacted(?::[^\]]+)?\]/g) ?? []).length - (text.match(/\[redacted(?::[^\]]+)?\]/g) ?? []).length
        let safe = redacted
        let truncated = false
        if (Buffer.byteLength(safe) > ATTACH_LIMITS.textOutputBytes) {
          safe = new TextDecoder().decode(Buffer.from(safe).subarray(0, ATTACH_LIMITS.textOutputBytes - 30)).replace(/\ufffd$/, '') + '\n[文件已截断]'
          truncated = true
        }
        data = { id: randomBytes(24).toString('hex'), kind: 'file', name, size: Buffer.byteLength(safe), mime: 'text/plain', text: safe, redactions, truncated, sha256: createHash('sha256').update(safe).digest('hex') }
      }
      while (this.pending.size >= ATTACH_LIMITS.pendingGlobal) this.pending.delete(this.pending.keys().next().value!)
      this.pending.set(data.id, { accountId, conversationId, expires: this.now() + ATTACH_LIMITS.pendingTtlMs, data })
      const warnings = data.redactions ? [`已隐藏 ${data.redactions} 处疑似密钥`] : []
      return { ok: true, ...attachmentMeta(data), ...(data.kind === 'image' && { thumbDataUrl: `data:${sniffImage(data.thumb!) ?? 'image/jpeg'};base64,${Buffer.from(data.thumb!).toString('base64')}` }), warnings }
    })
  }
  valid(accountId: string, conversationId: string | null, ids: string[]): boolean {
    this.sweep()
    return ids.every((id) => { const p = this.pending.get(id); return p !== undefined && p.accountId === accountId && (p.conversationId === null || p.conversationId === conversationId) && p.expires > this.now() })
  }
  hasImage(ids: string[]): boolean { return ids.some((id) => this.pending.get(id)?.data.kind === 'image') }
  consume(accountId: string, conversationId: string | null, ids: string[]): AttachmentData[] {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || !this.valid(accountId, conversationId, ids)) throw new Error(ATTACHMENT_EXPIRED)
    const data = ids.map((id) => this.pending.get(id)!.data)
    if (data.filter((x) => x.kind === 'image').length > ATTACH_LIMITS.imageCount || data.filter((x) => x.kind === 'file').length > ATTACH_LIMITS.fileCountPerMessage || data.filter((x) => x.kind === 'file').reduce((n, x) => n + x.size, 0) > ATTACH_LIMITS.textTotalBytes || data.reduce((n, x) => n + x.size, 0) > ATTACH_LIMITS.payloadBytes) throw new Error('附件超出限制')
    ids.forEach((id) => this.pending.delete(id))
    return data
  }
  discard(accountId: string, id: string): void { if (this.pending.get(id)?.accountId === accountId) this.pending.delete(id) }
  clearAccount(accountId: string): void { for (const [id, p] of this.pending) if (p.accountId === accountId) this.pending.delete(id) }
  clearConversation(conversationId: string): void { for (const [id, p] of this.pending) if (p.conversationId === conversationId) this.pending.delete(id) }
  clear(): void { this.pending.clear() }
}
export function attachmentFence(item: AttachmentData): string {
  const name = item.name.normalize('NFKC').replace(/[&"'<>\n\r\t]/g, (c) => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' })[c]!)
  const text = (item.text ?? '').normalize('NFKC').replace(/<(\s*\/?\s*attachment)/gi, '&lt;$1')
  return `<attachment kind="file" name="${name}" untrusted="true">\n${text}\n</attachment>`
}

export type ModelPart = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
