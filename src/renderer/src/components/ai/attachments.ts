import { imageHeaderSize } from '../../../../shared/imageHeader'
import { TEXT_ATTACHMENT_EXTENSIONS } from '../../../../shared/attachmentTypes'
import { ATTACH_LIMITS, type AttachmentMeta, type AttachmentSource } from '../../../../shared/ai'

export type AttachmentChip = AttachmentMeta & { localId: string; state: 'preparing' | 'ready' | 'error'; createdAt: number; reason?: string }
type ChipAction =
  | { type: 'add'; chip: AttachmentChip }
  | { type: 'prepared'; localId: string; chip: AttachmentChip }
  | { type: 'remove'; localId: string }
  | { type: 'expire'; now: number }
  | { type: 'restore'; chips: AttachmentChip[]; now: number }
export function chipReducer(chips: AttachmentChip[], action: ChipAction): AttachmentChip[] {
  switch (action.type) {
    case 'add': return [...chips, action.chip]
    case 'prepared': return chips.map((chip) => chip.localId === action.localId ? action.chip : chip)
    case 'remove': return chips.filter((chip) => chip.localId !== action.localId)
    case 'expire': return expiredChips(chips, action.now)
    case 'restore': {
      const result = [...chips]
      for (const chip of expiredChips(action.chips, action.now)) if (!result.some((c) => c.localId === chip.localId || (chip.id && c.id === chip.id))) result.push(chip)
      return result
    }
  }
}
export const FILE_ACCEPT = TEXT_ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`).join(',')
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp'
const allowed = new Set(FILE_ACCEPT.split(',').map((s) => s.slice(1)))
const forbidden = /^(?:\.env.*|id_rsa.*|id_ed25519.*|credentials.*)|secret|\.key\.|\.(?:pem|key|p12|pfx|kdbx|keystore)$/i

export function classifyAttachment(file: Pick<File, 'name' | 'size' | 'type'>, canImages: boolean, images = 0, files = 0, textBytes = 0): { kind?: 'image' | 'file'; reason?: string } {
  const name = file.name.normalize('NFKC').split(/[\\/]/).at(-1) ?? ''
  if (forbidden.test(name)) return { reason: '疑似凭证文件，已拒绝' }
  const image = /^(image\/(?:png|jpeg|webp|gif|bmp))$/.test(file.type) || /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(name)
  if (image) {
    if (!canImages) return { reason: '当前模型不支持图片' }
    if (images >= ATTACH_LIMITS.imageCount) return { reason: `最多添加 ${ATTACH_LIMITS.imageCount} 张图片` }
    if (file.size > ATTACH_LIMITS.imageInputBytes) return { reason: '图片太大' }
    return { kind: 'image' }
  }
  const ext = name.toLowerCase().split('.').at(-1)!
  if (name.includes('.') && !allowed.has(ext)) return { reason: '不支持此文件类型' }
  if (files >= ATTACH_LIMITS.fileCountPerMessage) return { reason: `最多添加 ${ATTACH_LIMITS.fileCountPerMessage} 个文件` }
  if (file.size > ATTACH_LIMITS.textInputBytes) return { reason: `超过 ${ATTACH_LIMITS.textInputBytes / 1024 / 1024} MB，已拒绝` }
  if (textBytes + Math.min(file.size, ATTACH_LIMITS.textOutputBytes) > ATTACH_LIMITS.textTotalBytes) return { reason: `文本附件总计超过 ${ATTACH_LIMITS.textTotalBytes / 1024} KB，已拒绝` }
  return { kind: 'file' }
}

export function chooseImageOutput(mime: string, width: number, height: number): { mime: 'image/png' | 'image/jpeg'; width: number; height: number } {
  const ratio = Math.min(1, ATTACH_LIMITS.imageOutputSidePx / Math.max(width, height))
  return { mime: mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}

export function expiredChips(chips: AttachmentChip[], now: number): AttachmentChip[] {
  return chips.filter((chip) => chip.state !== 'ready' || now - chip.createdAt < ATTACH_LIMITS.pendingTtlMs)
}
export function sendText(text: string, chips: AttachmentChip[]): string { return text.trim() ? text : chips.some((chip) => chip.state === 'ready') ? '请看附件。' : text }
export function readyChips(chips: AttachmentChip[]): AttachmentChip[] { return chips.filter((chip) => chip.state === 'ready') }
export function safeImageSrc(src?: string): string | undefined { return src && /^data:image\/(?:png|jpeg);base64,[a-z0-9+/=]+$/i.test(src) ? src : undefined }
export function formatSize(size: number): string { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB` }

export async function sourceFromFile(file: File, kind: 'image' | 'file', codec = browserImageCodec): Promise<AttachmentSource> {
  if (kind === 'file') return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), hintMime: file.type }
  const converted = await codec(file)
  if (converted.bytes.byteLength > ATTACH_LIMITS.imageInputBytes) throw new Error('图片太大')
  return { name: file.name, bytes: converted.bytes, hintMime: converted.mime }
}

async function browserImageCodec(file: File): Promise<{ bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' }> {
  const mime = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' } as Record<string, string>)[file.name.toLowerCase().split('.').at(-1) ?? '']
  let header: ReturnType<typeof imageHeaderSize>
  try { header = imageHeaderSize(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()), mime) } catch { throw new Error('无法读取这张图片') }
  if (!header) throw new Error('无法读取这张图片')
  if (Math.max(header.width, header.height) > ATTACH_LIMITS.imageSidePx || header.width * header.height > ATTACH_LIMITS.imagePixels) throw new Error('图片尺寸超出限制')
  const bitmap = await createImageBitmap(file)
  try {
    if (Math.max(bitmap.width, bitmap.height) > ATTACH_LIMITS.imageSidePx || bitmap.width * bitmap.height > ATTACH_LIMITS.imagePixels) throw new Error('image dimensions')
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')
    const output = chooseImageOutput(mime, bitmap.width, bitmap.height)
    canvas.width = output.width
    canvas.height = output.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: output.mime, quality: 0.9 })
      : await new Promise<Blob>((resolve, reject) => (canvas as HTMLCanvasElement).toBlob((value: Blob | null) => value ? resolve(value) : reject(new Error('encode')), output.mime, 0.9))
    if (blob.size > ATTACH_LIMITS.imageInputBytes) throw new Error('图片太大')
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: output.mime }
  } finally { bitmap.close() }
}

export function shouldAttachPaste(input: { text: string; html: string; files: readonly { type: string }[] }): boolean {
  return input.files.length > 0 && !((input.text || input.html) && input.files.every((file) => file.type.startsWith('image/')))
}

export function dragFilesVisible(current: boolean, event: 'enter' | 'leave' | 'reset', stillInside: boolean): boolean {
  return event === 'enter' ? true : event === 'reset' ? false : stillInside ? current : false
}

export function discardLatePrepared(chips: AttachmentChip[], localId: string, preparedOk: boolean): boolean {
  return preparedOk && !chips.some((chip) => chip.localId === localId)
}
