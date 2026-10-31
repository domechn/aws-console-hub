import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystore-test-'))
vi.mock('electron', () => ({ app: { getPath: () => dir }, safeStorage: {} }))

const { KeyStore } = await import('./keystore')

const KEY = 'sk-live-0123456789abcdef'
const file = path.join(dir, 'ai-keys.json')

/** Stands in for the OS keychain: reversible, but never contains the plaintext. */
function fakeCrypto(opts: { available?: boolean; backend?: string } = {}) {
  return {
    available: opts.available ?? true,
    isEncryptionAvailable() {
      return this.available
    },
    encryptString: (s: string) => Buffer.from(`enc:${[...s].reverse().join('')}`),
    decryptString: (b: Buffer) => {
      const s = b.toString()
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext')
      return [...s.slice(4)].reverse().join('')
    },
    getSelectedStorageBackend: opts.backend ? () => opts.backend! : undefined
  }
}

describe('KeyStore', () => {
  beforeEach(() => fs.rmSync(file, { force: true }))

  it('persists only ciphertext and decrypts it in a later run', () => {
    const crypto = fakeCrypto()
    expect(new KeyStore(crypto, file).set('deepseek', `  ${KEY}\n`)).toEqual({ ok: true, persisted: true })
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain(KEY)
    expect(raw).not.toContain('0123456789')

    const nextRun = new KeyStore(crypto, file)
    expect(nextRun.has('deepseek')).toBe(true)
    expect(nextRun.get('deepseek')).toBe(KEY)
  })

  it('keeps the key in memory only when encryption is unavailable or is Linux basic_text', () => {
    for (const crypto of [fakeCrypto({ available: false }), fakeCrypto({ backend: 'basic_text' })]) {
      const store = new KeyStore(crypto, file)
      expect(store.set('openai', KEY)).toEqual({ ok: true, persisted: false })
      expect(store.get('openai')).toBe(KEY)
      expect(fs.existsSync(file)).toBe(false)
      expect(new KeyStore(crypto, file).has('openai')).toBe(false)
    }
  })

  it('keeps a key in memory only when asked to, and takes an older saved one off the disk', () => {
    const crypto = fakeCrypto()
    new KeyStore(crypto, file).set('openai', 'sk-old-0123456789abcdef')
    const store = new KeyStore(crypto, file)
    expect(store.set('openai', KEY, false)).toEqual({ ok: true, persisted: false })
    expect(store.get('openai')).toBe(KEY)
    expect(new KeyStore(crypto, file).has('openai')).toBe(false)
  })

  it('drops an older saved key when a new one can only be kept in memory', () => {
    const crypto = fakeCrypto()
    new KeyStore(crypto, file).set('openai', 'sk-old-0123456789abcdef')
    crypto.available = false
    new KeyStore(crypto, file).set('openai', KEY)
    crypto.available = true
    expect(new KeyStore(crypto, file).get('openai')).toBeUndefined()
  })

  it('deletes from memory and disk', () => {
    const store = new KeyStore(fakeCrypto(), file)
    store.set('deepseek', KEY)
    store.set('openai', KEY)
    store.delete('deepseek')
    expect(store.has('deepseek')).toBe(false)
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).keys)).toEqual(['openai'])
  })

  it('treats undecryptable ciphertext as no key', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, keys: { deepseek: Buffer.from('garbage').toString('base64') } }))
    expect(new KeyStore(fakeCrypto(), file).get('deepseek')).toBeUndefined()
  })

  it('rejects malformed input at the boundary', () => {
    const store = new KeyStore(fakeCrypto(), file)
    expect(store.set('Deep Seek', KEY).ok).toBe(false)
    expect(store.set('deepseek', '').ok).toBe(false)
    expect(store.set('deepseek', 'sk-a\nsk-b').ok).toBe(false)
    expect(store.set('deepseek', 'x'.repeat(4097)).ok).toBe(false)
    expect(store.set('deepseek', 42 as unknown as string).ok).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })
})
