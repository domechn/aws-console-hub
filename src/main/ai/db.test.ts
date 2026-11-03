import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-db-test-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))
const redactedInputs = vi.hoisted(() => [] as string[])
vi.mock('./redact', async (importOriginal) => {
  const original = await importOriginal<typeof import('./redact')>()
  return { ...original, redactSecrets: (text: string) => { redactedInputs.push(text); return original.redactSecrets(text) } }
})

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
    expect(again.prepare('pragma user_version').get()).toEqual({ user_version: 10 })
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

  it('finds Chinese substrings and English word prefixes without exposing internal turns', () => {
    const { store } = fresh()
    const id = store.createConversation('a1', 'search')
    store.addMessage(id, { role: 'user', content: '列出运行中的 EC2' })
    store.addMessage(id, { role: 'assistant', content: 'Instances are running' })
    store.addMessage(id, { role: 'user', content: '[card_action] internal action' })
    store.addMessage(id, { role: 'user', content: '[proposal_result] internal result' })
    store.addMessage(id, { role: 'user', content: '[answer_request] internal request' })
    expect(store.search('a1', '运行')).toMatchObject([{ id, snippet: expect.stringContaining('运行') }])
    expect(store.search('a1', 'runn')).toMatchObject([{ id, snippet: expect.stringContaining('running') }])
    expect(store.search('a1', 'internal action')).toEqual([])
    expect(store.search('a1', 'internal result')).toEqual([])
    expect(store.search('a1', 'internal request')).toEqual([])
  })
  it('matches Unicode case pairs and keeps snippet offsets in the original text', () => {
    const { store } = fresh()
    for (const [body, query] of [
      ['before Ä after', 'ä'],
      ['before Σ after', 'σ'],
      ['before ПРИВЕТ after', 'привет']
    ]) {
      const id = store.createConversation('a1', query)
      store.addMessage(id, { role: 'user', content: body })
      expect(store.search('a1', query)).toMatchObject([{ id, snippet: expect.stringContaining(body.slice(-8)) }])
    }
    const shifted = store.createConversation('a1', 'shifted')
    store.addMessage(shifted, { role: 'user', content: `${'İ'.repeat(60)}target` })
    expect(store.search('a1', 'target')).toMatchObject([{ id: shifted, snippet: expect.stringContaining('target') }])
  })
  it('does not redact unrelated rows for an ASCII search', () => {
    const { store } = fresh()
    const id = store.createConversation('a1')
    store.addMessage(id, { role: 'user', content: 'ordinary unrelated text' })
    store.addMessage(id, { role: 'user', content: 'a needle here' })
    redactedInputs.length = 0
    expect(store.search('a1', 'needle')).toMatchObject([{ id }])
    expect(redactedInputs).toEqual(['a needle here'])
  })
  it('excludes internal turns with an underscore and falls back to an older visible match', () => {
    const { db, store } = fresh()
    const id = store.createConversation('a1', 'search')
    store.addMessage(id, { role: 'user', content: 'visible EXAMPLE' })
    store.addMessage(id, { role: 'user', content: '[card_action] EXAMPLE' })
    // A legacy unredacted row can match SQL but must be dropped after snippet redaction.
    db.prepare('insert into messages (conversation_id, role, content_json, created_at) values (?, ?, ?, ?)').run(
      id, 'assistant', JSON.stringify({ role: 'assistant', content: 'AKIAEXAMPLE123456789' }), Date.now()
    )
    expect(store.search('a1', 'EXAMPLE')).toMatchObject([{ id, snippet: expect.stringContaining('visible EXAMPLE') }])
  })

  it('returns another conversation after 250 newer matches in one conversation', () => {
    const { store } = fresh()
    const older = store.createConversation('a1', 'older')
    const noisy = store.createConversation('a1', 'noisy')
    store.addMessage(older, { role: 'user', content: 'needle older' })
    for (let i = 0; i < 250; i++) store.addMessage(noisy, { role: 'user', content: `needle ${i}` })
    expect(store.search('a1', 'needle').map((r) => r.id)).toEqual([noisy, older])
  })
  it('searches visible text containing JSON escapes beyond 200 metadata matches', () => {
    const { store } = fresh()
    const id = store.createConversation('a1', 'search')
    store.addMessage(id, { role: 'user', content: { role: 'user', content: [{ type: 'text', text: 'quote " and slash \\ here' }] } })
    for (let i = 0; i < 205; i++) store.addMessage(id, { role: 'user', content: { role: 'user', content: [{ type: 'text', text: 'other' }], text: 'needle' } })
    expect(store.search('a1', 'quote "')).toMatchObject([{ id, snippet: expect.stringContaining('quote "') }])
    expect(store.search('a1', 'slash \\')).toMatchObject([{ id, snippet: expect.stringContaining('slash \\') }])
    expect(store.search('a1', 'needle')).toEqual([])
  })
  it('applies the result window after ignoring internal control turns', () => {
    const { store } = fresh()
    const id = store.createConversation('a1', 'search')
    store.addMessage(id, { role: 'user', content: { role: 'user', content: [{ type: 'text', text: 'visible needle' }] } })
    for (let i = 0; i < 205; i++) store.addMessage(id, { role: 'user', content: { role: 'user', content: [{ type: 'text', text: '[proposal_result] needle' }] } })
    expect(store.search('a1', 'needle')).toMatchObject([{ id, snippet: expect.stringContaining('visible needle') }])
  })

  it('keeps token usage per reply, beyond its conversation, and backfills replies stored before v2', () => {
    const old = new DatabaseSync(':memory:')
    old.exec('pragma foreign_keys = on')
    old.exec('pragma user_version = 0')
    // A v1 database with one priced reply.
    migrate(old)
    old.exec('pragma user_version = 1; drop table attachments; drop table usage; drop table meta; drop index audit_by_t;')
    const v1 = new AiStore(old)
    const c = v1.createConversation('a1')
    old.prepare("insert into messages (conversation_id, role, content_json, created_at) values (?, 'assistant', ?, ?)").run(c, JSON.stringify({ role: 'assistant', provider: 'deepseek', model: 'm', usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 } }), NOW)
    old.exec('alter table conversations drop column page_context')
    old.exec('alter table conversations drop column pinned; alter table messages drop column feedback')
    migrate(old)
    expect(old.prepare('pragma user_version').get()).toEqual({ user_version: 10 })
    // v3: conversations from before it send the current page (the default).
    expect(v1.pageContext(c)).toBe(true)
    v1.setPageContext(c, false)
    expect(v1.pageContext(c)).toBe(false)
    expect(v1.usageSince(0)).toEqual([{ provider: 'deepseek', model: 'm', input: 100, output: 20, cacheRead: 5, cacheWrite: 0 }])
    expect(v1.conversationUsage(c)).toEqual([{ provider: 'deepseek', model: 'm', input: 100, output: 20, cacheRead: 5, cacheWrite: 0 }])

    const { store } = fresh()
    const id = store.createConversation('a1')
    store.addMessage(id, { role: 'assistant', content: { role: 'assistant', provider: 'openai', model: 'g', usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0 } } })
    store.addMessage(id, { role: 'assistant', content: { role: 'assistant', provider: 'openai', model: 'g', usage: { input: 1, output: 1, cacheRead: -5, cacheWrite: 'x' } } })
    store.addMessage(id, { role: 'user', content: { usage: { input: 999 } } })
    store.truncateMessages(id, 0)
    expect(store.conversationUsage(id)).toEqual([{ provider: 'openai', model: 'g', input: 11, output: 4, cacheRead: 0, cacheWrite: 0 }])
    store.deleteConversation(id)
    expect(store.usageSince(0)).toEqual([{ provider: 'openai', model: 'g', input: 11, output: 4, cacheRead: 0, cacheWrite: 0 }])
    expect(store.usageSince(Date.now() + DAY)).toEqual([])
  })

  it('backfills analysis conversation usage when upgrading v5, including repeated migration', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    db.exec('drop table attachments; pragma user_version = 5')
    db.exec('alter table conversations drop column pinned; alter table messages drop column feedback')
    db.prepare("insert into usage (t, account_id, provider, model, input, output, analysis_of) values (?, ?, ?, ?, ?, ?, ?)").run(NOW, 'a1', 'deepseek', 'm', 7, 3, 'conversation-1')
    migrate(db)
    migrate(db)
    expect(db.prepare('select conversation_id from usage where analysis_of = ?').get('conversation-1')).toEqual({ conversation_id: 'conversation-1' })
    expect(new AiStore(db).conversationUsage('conversation-1')).toMatchObject([{ input: 7, output: 3 }])
  })

  it('matches rounded reply usage during v5 backfill and creates the time index', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new AiStore(db)
    const id = store.createConversation('a1')
    db.prepare("insert into messages (conversation_id, role, content_json, created_at) values (?, 'assistant', ?, ?)").run(
      id, JSON.stringify({ role: 'assistant', model: 'm', usage: { input: 1.6, output: 2.6 } }), NOW
    )
    db.exec('drop table attachments; drop index usage_by_conversation; alter table usage drop column conversation_id; pragma user_version = 4')
    db.exec('alter table conversations drop column pinned; alter table messages drop column feedback')
    db.prepare("insert into usage (t, account_id, provider, model, input, output) values (?, 'a1', '', 'm', 2, 3)").run(NOW)
    migrate(db)
    expect(db.prepare("select conversation_id from usage where model = 'm'").get()).toEqual({ conversation_id: id })
    expect(db.prepare("select name from sqlite_master where type = 'index' and name = 'messages_by_created'").get()).toEqual({ name: 'messages_by_created' })
    expect(store.conversationUsage(id)).toMatchObject([{ input: 2, output: 3 }])
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

  it('pins per account and keeps feedback local to a message', () => {
    const { store } = fresh()
    const a = store.createConversation('a1', 'first')
    const b = store.createConversation('a1', 'second')
    const other = store.createConversation('a2', 'other')
    store.setPinned(a, true)
    expect(store.conversations('a1').map((c) => [c.id, c.pinned])).toEqual([[a, true], [b, false]])
    store.addMessage(a, { role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } })
    const row = store.messages(a)[0]
    store.setFeedback(a, row.id, 'up')
    expect(store.messages(a)[0].feedback).toBe('up')
    expect(() => store.setFeedback(other, row.id, 'down')).toThrow()
    store.deleteConversation(a)
    expect(store.messages(a)).toEqual([])
    const keep = store.createConversation('a1')
    store.addMessage(keep, { role: 'assistant', content: { role: 'assistant', content: 'answer' } })
    store.setFeedback(keep, store.messages(keep)[0].id, 'down')
    store.deleteAll({ audit: false, now: Date.now() })
    expect(store.messages(keep)).toEqual([])
    expect(store.conversations('a1')).toEqual([])
  })

  it('searches stored user and assistant text within one account with literal wildcards', () => {
    const { store } = fresh()
    const a = store.createConversation('a1', 'one')
    const b = store.createConversation('a2', 'two')
    store.addMessage(a, { role: 'user', content: { role: 'user', content: [{ type: 'text', text: 'find 100% usage' }] } })
    store.addMessage(b, { role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'find 100% usage' }] } })
    expect(store.search('a1', '100%')).toMatchObject([{ id: a, title: 'one' }])
    expect(store.search('a1', '%')).toHaveLength(1)
    expect(store.search('a1', 'no match')).toEqual([])
    expect(store.search('a1', '100%')).toMatchObject([{ id: a }])
    expect(store.search('a1', '_')).toEqual([])
  })

  it('drops a P3 FTS index safely and searches only visible text', () => {
    const { db, store } = fresh()
    db.exec("create virtual table messages_fts using fts5(content); create trigger messages_fts_delete after delete on messages begin delete from messages_fts where rowid = old.id; end;")
    migrate(db)
    expect(db.prepare("select name from sqlite_master where name = 'messages_fts'").get()).toBeUndefined()
    const id = store.createConversation('a1')
    store.addMessage(id, { role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'regional latency trend' }] } })
    store.addMessage(id, { role: 'assistant', content: { role: 'assistant', content: [{ type: 'toolCall', name: 'aws_read', arguments: { note: 'private-marker' } }] } })
    expect(store.search('a1', 'latency')).toHaveLength(1)
    expect(store.search('a1', 'private-marker')).toEqual([])
    store.deleteConversation(id)
    expect(store.search('a1', 'latency')).toEqual([])
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

describe('attachment persistence', () => {
  it('stores content outside message JSON and cascades on message, conversation, account, and retention deletion', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('pragma foreign_keys = on')
    migrate(db)
    const store = new AiStore(db)
    const id = store.createConversation('a')
    store.addMessage(id, { role: 'user', content: { role: 'user', content: [{ type: 'text', text: 'hi' }], attachments: [{ id: 'x', kind: 'image', name: 'x.png', size: 9 }] } })
    const messageId = store.messages(id)[0].id
    store.addAttachment(id, messageId, { id: 'x', kind: 'image', name: 'x.png', mime: 'image/jpeg', size: 9, width: 1, height: 1, sha256: 'abc', bytes: Uint8Array.of(1,2,3), thumb: Uint8Array.of(4) })
    expect(store.attachment('a', id, 'x')?.bytes).toEqual(Uint8Array.of(1,2,3))
    expect(JSON.stringify(store.messages(id))).not.toContain('base64')
    store.truncateMessages(id, messageId)
    expect(store.attachment('a', id, 'x')).toBeUndefined()
    db.close()
  })
})

describe('attachment deletion paths', () => {
  const add = (store: InstanceType<typeof AiStore>, conversationId: string, suffix: string) => {
    const messageId = store.addMessage(conversationId, { role: 'user', content: { role: 'user', content: [{ type: 'text', text: 'hi' }], attachments: [{ id: suffix, kind: 'file', name: 'note.txt', size: 5 }] } })
    store.addAttachment(conversationId, messageId, { id: suffix, kind: 'file', name: 'note.txt', mime: 'text/plain', size: 5, sha256: 'abc', text: 'hello' })
  }
  it('deletes image and file rows through retention, clear account, and delete all', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('pragma foreign_keys = on')
    migrate(db)
    const store = new AiStore(db)
    const old = store.createConversation('a')
    add(store, old, 'old')
    db.prepare('update conversations set updated_at = 1 where id = ?').run(old)
    store.prune({ now: Date.now(), auditDays: 180, conversationDays: 1 })
    expect(store.attachment('a', old, 'old')).toBeUndefined()
    const account = store.createConversation('a')
    add(store, account, 'account')
    store.clearAccount('a')
    expect(store.attachment('a', account, 'account')).toBeUndefined()
    const all = store.createConversation('b')
    add(store, all, 'all')
    store.deleteAll({ audit: false, now: Date.now() })
    expect(store.attachment('b', all, 'all')).toBeUndefined()
    db.close()
  })
})
