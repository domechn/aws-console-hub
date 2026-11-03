import { describe, expect, it } from 'vitest'
import { imageHeaderSize } from './imageHeader'

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))
const size = { width: 60000, height: 60000 }
function webp(chunk: string, length: number, values: [number, number][]): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set(ascii('RIFF'), 0); bytes.set(ascii('WEBP'), 8); bytes.set(ascii(chunk), 12)
  for (const [at, value] of values) bytes[at] = value
  return bytes
}

describe('bounded image headers', () => {
  it.each([
    ['image/png', Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,...ascii('IHDR'),0,0,234,96,0,0,234,96])],
    ['image/jpeg', Uint8Array.from([255,216,255,192,0,17,8,234,96,234,96,3,1,17,0,2,17,0,3,17,0])],
    ['image/gif', Uint8Array.from([...ascii('GIF89a'),96,234,96,234])],
    ['image/webp', webp('VP8X', 30, [[24, 95], [25, 234], [27, 95], [28, 234]])],
    ['image/bmp', Uint8Array.from([...ascii('BM'),0,0,0,0,0,0,0,0,54,0,0,0,40,0,0,0,96,234,0,0,96,234,0,0])]
  ] as const)('reads %s dimensions before decode', (mime, bytes) => {
    expect(imageHeaderSize(bytes, mime)).toEqual(size)
  })
  it('rejects incomplete or unrecognized data', () => {
    expect(imageHeaderSize(new Uint8Array(5), 'image/png')).toBeNull()
    expect(imageHeaderSize(Uint8Array.from(ascii('garbage data')), 'image/webp')).toBeNull()
  })
  it('reads WebP VP8 and VP8L dimensions', () => {
    expect(imageHeaderSize(webp('VP8 ', 30, [[23, 157], [24, 1], [25, 42], [26, 0x10], [27, 0x27], [28, 0x10], [29, 0x27]]), 'image/webp')).toEqual({ width: 10000, height: 10000 })
    expect(imageHeaderSize(webp('VP8L', 25, [[20, 47], [21, 95], [22, 234], [23, 167], [24, 14]]), 'image/webp')).toEqual({ width: 10848, height: 15008 })
  })
})
