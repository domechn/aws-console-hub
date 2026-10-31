import { app, safeStorage } from 'electron'
import path from 'node:path'
import { readJson, writeJson } from '../store'
import type { SetKeyResult } from '../../shared/ai'

/** The slice of Electron's safeStorage used here; injected so tests can stand in for the OS keychain. */
export interface CryptoBackend {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
  /** Linux only. */
  getSelectedStorageBackend?(): string
}

/** Base64 ciphertext per provider id. Never plaintext. */
interface KeyFile {
  version: 1
  keys: Record<string, string>
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
// One line of printable ASCII, no spaces. Short-term Bedrock API keys (a presigned URL in base64) run past 1000 chars.
const API_KEY = /^[\x21-\x7e]{1,4096}$/

/**
 * LLM API keys, main process only. Encrypted with safeStorage (macOS: key held in Keychain) into ai-keys.json;
 * where that isn't trustworthy the key lives in memory for this run only. `get` must never be exposed over IPC.
 * Call after app `ready`: safeStorage is unavailable before it.
 */
export class KeyStore {
  private memory = new Map<string, string>()

  constructor(
    private crypto: CryptoBackend = safeStorage,
    private file = path.join(app.getPath('userData'), 'ai-keys.json')
  ) {}

  /** Linux without a keyring falls back to `basic_text`: a hardcoded password, as good as plaintext. */
  canPersist(): boolean {
    return this.crypto.isEncryptionAvailable() && this.crypto.getSelectedStorageBackend?.() !== 'basic_text'
  }

  /** `persist: false` keeps the key in memory for this run only (the "memory" key mode). */
  set(providerId: string, key: string, persist = true): SetKeyResult {
    if (!PROVIDER_ID.test(providerId)) return { ok: false, error: 'invalid provider id' }
    key = typeof key === 'string' ? key.trim() : ''
    if (!API_KEY.test(key)) return { ok: false, error: 'API key must be one line of printable characters, at most 4096' }
    this.memory.set(providerId, key)
    const persisted = persist && this.canPersist()
    // Memory-only still clears an older saved key, or it would come back on the next launch.
    this.writeKey(providerId, persisted ? this.crypto.encryptString(key).toString('base64') : null)
    return { ok: true, persisted }
  }

  has(providerId: string): boolean {
    return this.memory.has(providerId) || providerId in this.load().keys
  }

  delete(providerId: string): void {
    this.memory.delete(providerId)
    this.writeKey(providerId, null)
  }

  get(providerId: string): string | undefined {
    const cached = this.memory.get(providerId)
    if (cached !== undefined) return cached
    const cipher = this.load().keys[providerId]
    if (cipher === undefined || !this.crypto.isEncryptionAvailable()) return undefined
    try {
      const key = this.crypto.decryptString(Buffer.from(cipher, 'base64'))
      this.memory.set(providerId, key)
      return key
    } catch {
      // Keychain item reset or file copied from another machine: the user has to enter the key again.
      return undefined
    }
  }

  private load(): KeyFile {
    return readJson<KeyFile>(this.file, { version: 1, keys: {} })
  }

  private writeKey(providerId: string, cipher: string | null): void {
    const data = this.load()
    if (cipher === null && !(providerId in data.keys)) return
    if (cipher === null) delete data.keys[providerId]
    else data.keys[providerId] = cipher
    writeJson(this.file, data)
  }
}
