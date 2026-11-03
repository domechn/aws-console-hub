/** Pixel dimensions from a bounded prefix. A missing SOF or malformed header is not safe to decode. */
export function imageHeaderSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  const n = bytes.length
  const v = new DataView(bytes.buffer, bytes.byteOffset, n)
  const tag = (at: number, text: string): boolean => at + text.length <= n && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0))
  let width = 0, height = 0
  if (mime === 'image/png' && n >= 24 && bytes[0] === 137 && tag(1, 'PNG\r\n\x1a\n') && v.getUint32(8) === 13 && tag(12, 'IHDR')) {
    width = v.getUint32(16); height = v.getUint32(20)
  } else if (mime === 'image/jpeg' && n >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2
    while (at + 4 <= n) {
      if (bytes[at++] !== 255) break
      while (bytes[at] === 255) at++
      const marker = bytes[at++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (at + 2 > n) break
      const length = v.getUint16(at)
      if (length < 2 || at + length > n) break
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length >= 7) { height = v.getUint16(at + 3); width = v.getUint16(at + 5) }
        break
      }
      at += length
    }
  } else if (mime === 'image/gif' && n >= 10 && (tag(0, 'GIF87a') || tag(0, 'GIF89a'))) {
    width = v.getUint16(6, true); height = v.getUint16(8, true)
  } else if (mime === 'image/webp' && n >= 20 && tag(0, 'RIFF') && tag(8, 'WEBP')) {
    if (tag(12, 'VP8X') && n >= 30) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16)
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
    } else if (tag(12, 'VP8L') && n >= 25 && bytes[20] === 0x2f) {
      width = 1 + (((bytes[22] & 0x3f) << 8) | bytes[21])
      height = 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | (bytes[22] >> 6))
    } else if (tag(12, 'VP8 ') && n >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = v.getUint16(26, true) & 0x3fff; height = v.getUint16(28, true) & 0x3fff
    }
  } else if (mime === 'image/bmp' && n >= 26 && tag(0, 'BM')) {
    const dib = v.getUint32(14, true)
    if (dib === 12 && n >= 26) { width = v.getUint16(18, true); height = v.getUint16(20, true) }
    else if (dib >= 40 && n >= 26) { width = v.getInt32(18, true); height = Math.abs(v.getInt32(22, true)) }
  }
  return width > 0 && height > 0 ? { width, height } : null
}
