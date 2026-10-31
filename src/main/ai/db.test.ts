import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-db-test-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const { AiStore, migrate, openAiDb } = await import('./db')

const KEY_ID = 'ASIAIOSFODNN7EXAMPLE'

describe('ai.sqlite', () => {
  it('creates the schema in userData and re-opens without re-migrating', () => {
    const db = openAiDb()
    expect(fs.existsSync(path.join(dir, 'ai.sqlite'))).toBe(true)
    const store = new AiStore(db)
    const id = store.createConversation('a1', 'first')
    store.addMessage(id, { role: 'user', content: 'hi' })
    db.close()

    const again = openAiDb()
    expect(again.prepare('pragma user_version').get()).toEqual({ user_version: 4 })
    expect(new AiStore(again).conversations('a1').map((c) => c.title)).toEqual(['first'])
    again.close()
  })

  it('refuses a database from a newer schema instead of touching it', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('pragma user_version = 99')
    expect(() => migrate(db)).toThrow(/schema v99/)
  })

  it('rolls a failed migration back completely', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('create table audit (x)') // collides with the migration's third table
    expect(() => migrate(db)).toThrow(/already exists/)
    expect(db.prepare('pragma user_version').get()).toEqual({ user_version: 0 })
    expect(db.prepare("select name from sqlite_master where name = 'conversations'").get()).toBeUndefined()
    expect(() => db.exec('begin')).not.toThrow() // no transaction left dangling
  })

  it('stores messages per account and clears them without touching the audit log', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('pragma foreign_keys = on')
    migrate(db)
    const store = new AiStore(db)
    const a = store.createConversation('a1')
    const b = store.createConversation('b2')
    store.addMessage(a, { role: 'user', content: [{ type: 'text', text: 'list ec2' }], tokensIn: 10 })
    store.addMessage(b, { role: 'assistant', content: 'other account' })
    store.audit('proposal_created', 'a1', { action: 'StopInstances' })

    expect(store.messages(a)).toMatchObject([{ role: 'user', content: [{ type: 'text', text: 'list ec2' }], tokensIn: 10, tokensOut: null }])
    store.clearAccount('a1')
    expect(store.conversations('a1')).toEqual([])
    expect(store.messages(a)).toEqual([])
    expect(store.messages(b)).toHaveLength(1)
    store.deleteAll({ audit: false, now: Date.now() })
    expect(store.conversations('b2')).toEqual([])
    expect(store.auditEntries()).toMatchObject([{ type: 'proposal_created', accountId: 'a1', data: { action: 'StopInstances' } }])
    store.deleteAll({ audit: true, now: Date.now() })
    expect(store.auditEntries()).toEqual([])
  })

  const fresh = () => {
    const db = new DatabaseSync(':memory:')
    db.exec('pragma foreign_keys = on')
    migrate(db)
    return { db, store: new AiStore(db) }
  }
  const DAY = 86400_000
  const NOW = Date.parse('2026-10-29T12:00:00Z')

  it('keeps token usage per reply, beyond its conversation, and backfills replies stored before v2', () => {
    const old = new DatabaseSync(':memory:')
    old.exec('pragma foreign_keys = on')
    old.exec('pragma user_version = 0')
    // A v1 database with one priced reply.
    migrate(old)
    old.exec('pragma user_version = 1; drop table usage; drop table meta; drop index audit_by_t;')
    const v1 = new AiStore(old)
    const c = v1.createConversation('a1')
    old.prepare("insert into messages (conversation_id, role, content_json, created_at) values (?, 'assistant', ?, ?)").run(c, JSON.stringify({ role: 'assistant', provider: 'deepseek', model: 'm', usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 } }), NOW)
    old.exec('alter table conversations drop column page_context')
    migrate(old)
    expect(old.prepare('pragma user_version').get()).toEqual({ user_version: 4 })
    // v3: conversations from before it send the current page (the default).
    expect(v1.pageContext(c)).toBe(true)
    v1.setPageContext(c, false)
    expect(v1.pageContext(c)).toBe(false)
    expect(v1.usageSince(0)).toEqual([{ provider: 'deepseek', model: 'm', input: 100, output: 20, cacheRead: 5, cacheWrite: 0 }])

    const { store } = fresh()
    const id = store.createConversation('a1')
    store.addMessage(id, { role: 'assistant', content: { role: 'assistant', provider: 'openai', model: 'g', usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0 } } })
    store.addMessage(id, { role: 'assistant', content: { role: 'assistant', provider: 'openai', model: 'g', usage: { input: 1, output: 1, cacheRead: -5, cacheWrite: 'x' } } })
    store.addMessage(id, { role: 'user', content: { usage: { input: 999 } } })
    store.deleteConversation(id)
    expect(store.usageSince(0)).toEqual([{ provider: 'openai', model: 'g', input: 11, output: 4, cacheRead: 0, cacheWrite: 0 }])
    expect(store.usageSince(Date.now() + DAY)).toEqual([])
  })

  it('prunes audit rows and conversations past their retention, never younger ones, and vacuums at most weekly', () => {
    const { db, store } = fresh()
    const at = (t: number) => db.prepare('update audit set t = ? where id = (select max(id) from audit)').run(t)
    store.audit('tool_call', 'a1', { n: 'old' })
    at(NOW - 181 * DAY)
    store.audit('tool_call', 'a1', { n: 'edge' })
    at(NOW - 180 * DAY + 1)
    store.audit('tool_call', 'a1', { n: 'new' })
    at(NOW - DAY)
    const old = store.createConversation('a1', 'old')
    const recent = store.createConversation('a1', 'recent')
    db.prepare('update conversations set updated_at = ? where id = ?').run(NOW - 31 * DAY, old)
    db.prepare('update conversations set updated_at = ? where id = ?').run(NOW - 29 * DAY, recent)

    expect(store.prune({ now: NOW, auditDays: 180, conversationDays: null })).toEqual({ audit: 1, conversations: 0 })
    expect(store.auditEntries().map((r) => (r.data as { n: string }).n)).toEqual(['edge', 'new'])
    expect(db.prepare("select value from meta where key = 'vacuumed_at'").get()).toEqual({ value: String(NOW) })
    expect(store.prune({ now: NOW, auditDays: 180, conversationDays: 30 })).toEqual({ audit: 0, conversations: 1 })
    expect(store.conversations('a1').map((c) => c.title)).toEqual(['recent'])
    // Vacuumed less than a week ago: not again.
    expect(db.prepare("select value from meta where key = 'vacuumed_at'").get()).toEqual({ value: String(NOW) })
    expect(store.prune({ now: NOW, auditDays: 180, conversationDays: 0 })).toEqual({ audit: 0, conversations: 1 })
    expect(store.prune({ now: NOW, auditDays: 180, conversationDays: 90 })).toEqual({ audit: 0, conversations: 0 })
  })

  it('lists audit rows newest first, by time and account, bounded', () => {
    const { store } = fresh()
    for (let i = 0; i < 5; i++) store.audit('tool_call', i % 2 ? 'a2' : 'a1', { i })
    expect(store.auditRows({ since: 0, limit: 3 }).map((r) => r.data.i)).toEqual([4, 3, 2])
    expect(store.auditRows({ since: 0, accountId: 'a2', limit: 10 }).map((r) => r.data.i)).toEqual([3, 1])
    expect(store.auditRows({ since: Date.now() + DAY, limit: 10 })).toEqual([])
  })

  it('renames, deletes and reports the owner of a conversation', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('pragma foreign_keys = on')
    migrate(db)
    const store = new AiStore(db)
    const a = store.createConversation('a1', 'old')
    store.addMessage(a, { role: 'user', content: 'hi' })
    expect(store.conversationAccount(a)).toBe('a1')
    expect(store.conversationAccount('nope')).toBeUndefined()
    store.renameConversation(a, `new ${KEY_ID}`)
    expect(store.conversations('a1')[0].title).toBe('new [redacted:aws-key-id]')
    store.deleteConversation(a)
    expect(store.conversations('a1')).toEqual([])
    expect(store.messages(a)).toEqual([])
  })

  it('never writes credentials to disk', () => {
    const db = openAiDb(path.join(dir, 'secrets.sqlite'))
    const store = new AiStore(db)
    const id = store.createConversation('a1', `creds ${KEY_ID}`)
    store.addMessage(id, { role: 'toolResult', content: { AccessKeyId: KEY_ID, SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' } })
    store.audit('change', 'a1', { params: { MasterUserPassword: 'x', note: `key ${KEY_ID}` } })
    expect(store.messages(id)[0].content).toEqual({ AccessKeyId: '[redacted:aws-key-id]', SecretAccessKey: '[redacted]' })
    db.close()
    for (const f of fs.readdirSync(dir).filter((f) => f.startsWith('secrets.sqlite'))) {
      const raw = fs.readFileSync(path.join(dir, f), 'latin1')
      expect(raw).not.toContain(KEY_ID)
      expect(raw).not.toContain('EXAMPLEKEY')
    }
  })
})
