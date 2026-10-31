import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { redactSecrets } from './redact'

type SqlValue = string | number | null

/** What this module needs from a driver. node:sqlite's DatabaseSync and better-sqlite3's Database both fit as-is. */
export interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: SqlValue[]): unknown
    get(...params: SqlValue[]): unknown
    all(...params: SqlValue[]): unknown[]
  }
  close(): void
}

/** Append-only: entry N moves user_version N → N+1. Never edit a shipped entry; add a new one. */
const MIGRATIONS = [
  `create table conversations (
     id text primary key,
     account_id text not null,
     title text not null default '',
     created_at integer not null,
     updated_at integer not null
   );
   create index conversations_by_account on conversations (account_id, updated_at);
   create table messages (
     id integer primary key,
     conversation_id text not null references conversations (id) on delete cascade,
     role text not null,
     content_json text not null,
     tokens_in integer,
     tokens_out integer,
     created_at integer not null
   );
   create index messages_by_conversation on messages (conversation_id, id);
   create table audit (
     id integer primary key,
     t integer not null,
     type text not null,
     account_id text,
     data_json text not null
   );`,
  // Token usage outlives its conversation (the monthly total and budget must not drop when a chat is deleted);
  // backfilled from the replies already stored. meta: housekeeping timestamps.
  `create table usage (
     id integer primary key,
     t integer not null,
     account_id text,
     provider text not null default '',
     model text not null default '',
     input integer not null default 0,
     output integer not null default 0,
     cache_read integer not null default 0,
     cache_write integer not null default 0
   );
   create index usage_by_t on usage (t);
   create index audit_by_t on audit (t);
   create table meta (key text primary key, value text not null);
   insert into usage (t, account_id, provider, model, input, output, cache_read, cache_write)
     select m.created_at, c.account_id,
       coalesce(json_extract(m.content_json, '$.provider'), ''), coalesce(json_extract(m.content_json, '$.model'), ''),
       coalesce(json_extract(m.content_json, '$.usage.input'), 0), coalesce(json_extract(m.content_json, '$.usage.output'), 0),
       coalesce(json_extract(m.content_json, '$.usage.cacheRead'), 0), coalesce(json_extract(m.content_json, '$.usage.cacheWrite'), 0)
     from messages m join conversations c on c.id = m.conversation_id
     where m.role = 'assistant' and json_extract(m.content_json, '$.usage') is not null;`,
  // Per conversation: the current page goes to the model each turn (the chip's ×). On for the ones already there.
  `alter table conversations add column page_context integer not null default 1;`,
  // An impact analysis's replies are not in the transcript: their usage rows name the conversation they were for.
  `alter table usage add column analysis_of text;`,
  `alter table usage add column conversation_id text;
   create index if not exists messages_by_created on messages (created_at);
   update usage set conversation_id = (
     select m.conversation_id from messages m join conversations c on c.id = m.conversation_id
     where m.role = 'assistant' and m.created_at = usage.t and c.account_id = usage.account_id
       and coalesce(json_extract(m.content_json, '$.model'), '') = usage.model
       and round(coalesce(json_extract(m.content_json, '$.usage.input'), 0)) = usage.input
       and round(coalesce(json_extract(m.content_json, '$.usage.output'), 0)) = usage.output
     limit 1
   ) where analysis_of is null;
   create index usage_by_conversation on usage (conversation_id);`,
  `update usage set conversation_id = analysis_of where analysis_of is not null and conversation_id is null;`
]

const DAY = 86400_000
/** Usage rows are kept this long whatever the audit retention: the monthly view needs the whole month. */
const USAGE_KEEP_DAYS = 400
const VACUUM_EVERY_MS = 7 * DAY

export interface UsageRow {
  provider: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface StoredAudit {
  id: number
  t: number
  type: string
  accountId: string | null
  data: Record<string, any>
}

export function migrate(db: SqlDatabase): void {
  const { user_version: from } = db.prepare('pragma user_version').get() as { user_version: number }
  // A newer app wrote this file; migrating "back" would mean guessing, and guessing can destroy history.
  if (from > MIGRATIONS.length) throw new Error(`ai.sqlite is schema v${from}, this build knows v${MIGRATIONS.length}`)
  for (let v = from; v < MIGRATIONS.length; v++) {
    db.exec('begin')
    try {
      db.exec(`${MIGRATIONS[v]}; pragma user_version = ${v + 1}; commit;`)
    } catch (err) {
      db.exec('rollback')
      throw err
    }
  }
}

export function openAiDb(file = path.join(app.getPath('userData'), 'ai.sqlite')): SqlDatabase {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on;')
  try {
    migrate(db)
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

export interface StoredMessage {
  id: number
  role: string
  content: unknown
  tokensIn: number | null
  tokensOut: number | null
  createdAt: number
}

/** Chat history and audit log. Everything written passes redactSecrets first: no credentials or keys on disk. */
export class AiStore {
  constructor(private db: SqlDatabase) {}

  createConversation(accountId: string, title = '', pageContext = true): string {
    const id = randomUUID()
    const now = Date.now()
    this.db
      .prepare('insert into conversations (id, account_id, title, created_at, updated_at, page_context) values (?, ?, ?, ?, ?, ?)')
      .run(id, accountId, redactSecrets(title), now, now, pageContext ? 1 : 0)
    return id
  }

  conversations(accountId: string): { id: string; title: string; updatedAt: number }[] {
    return this.db
      .prepare('select id, title, updated_at as updatedAt from conversations where account_id = ? order by updated_at desc')
      .all(accountId) as { id: string; title: string; updatedAt: number }[]
  }

  /** Owner of a conversation; undefined when there is none with this id. */
  conversationAccount(id: string): string | undefined {
    return (this.db.prepare('select account_id as accountId from conversations where id = ?').get(id) as { accountId: string } | undefined)?.accountId
  }

  /** Whether the conversation sends the current page; false for an unknown id. */
  pageContext(id: string): boolean {
    return (this.db.prepare('select page_context as on_ from conversations where id = ?').get(id) as { on_: number } | undefined)?.on_ === 1
  }

  setPageContext(id: string, on: boolean): void {
    this.db.prepare('update conversations set page_context = ? where id = ?').run(on ? 1 : 0, id)
  }

  renameConversation(id: string, title: string): void {
    this.db.prepare('update conversations set title = ? where id = ?').run(redactSecrets(title), id)
  }

  deleteConversation(id: string): void {
    this.db.prepare('delete from conversations where id = ?').run(id)
  }

  addMessage(conversationId: string, m: { role: string; content: unknown; tokensIn?: number; tokensOut?: number }): void {
    const now = Date.now()
    this.db
      .prepare('insert into messages (conversation_id, role, content_json, tokens_in, tokens_out, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(conversationId, m.role, redactSecrets(JSON.stringify(m.content)), m.tokensIn ?? null, m.tokensOut ?? null, now)
    this.db.prepare('update conversations set updated_at = ? where id = ?').run(now, conversationId)
    const c = m.content as { usage?: Partial<Record<keyof Omit<UsageRow, 'provider' | 'model'>, unknown>>; provider?: unknown; model?: unknown } | null
    if (m.role === 'assistant' && c?.usage) {
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
      this.db
        .prepare('insert into usage (t, account_id, provider, model, input, output, cache_read, cache_write, conversation_id) select ?, account_id, ?, ?, ?, ?, ?, ?, ? from conversations where id = ?')
        .run(now, String(c.provider ?? ''), String(c.model ?? ''), n(c.usage.input), n(c.usage.output), n(c.usage.cacheRead), n(c.usage.cacheWrite), conversationId, conversationId)
    }
  }

  /** One reply of an impact analysis (analysis.ts): counted in the month and the budget, and in its conversation's total. */
  addAnalysisUsage(accountId: string, conversationId: string, r: UsageRow): void {
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
    this.db
        .prepare('insert into usage (t, account_id, provider, model, input, output, cache_read, cache_write, analysis_of, conversation_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), accountId, r.provider, r.model, n(r.input), n(r.output), n(r.cacheRead), n(r.cacheWrite), conversationId, conversationId)
  }

  conversationUsage(conversationId: string): UsageRow[] {
    return this.db.prepare(
      'select provider, model, sum(input) as input, sum(output) as output, sum(cache_read) as cacheRead, sum(cache_write) as cacheWrite from usage where conversation_id = ? group by provider, model'
    ).all(conversationId) as unknown as UsageRow[]
  }

  /** Usage since `from` (ms), summed per model; deleted conversations included. */
  usageSince(from: number): UsageRow[] {
    return this.db
      .prepare(
        'select provider, model, sum(input) as input, sum(output) as output, sum(cache_read) as cacheRead, sum(cache_write) as cacheWrite from usage where t >= ? group by provider, model'
      )
      .all(from) as unknown as UsageRow[]
  }

  /**
   * Retention: audit rows older than `auditDays`, conversations whose last message is older than `conversationDays`
   * (0: all of them; null: none). Rows younger than a cutoff are never touched. Vacuums at most weekly, after a prune
   * that deleted something.
   */
  prune(o: { now: number; auditDays: number; conversationDays: number | null }): { audit: number; conversations: number } {
    const count = (sql: string, ...p: SqlValue[]): number => Number((this.db.prepare(sql).run(...p) as { changes?: number | bigint }).changes ?? 0)
    const audit = count('delete from audit where t < ?', o.now - o.auditDays * DAY)
    const conversations = o.conversationDays === null ? 0 : count('delete from conversations where updated_at < ?', o.conversationDays === 0 ? Number.MAX_SAFE_INTEGER : o.now - o.conversationDays * DAY)
    const usage = count('delete from usage where t < ?', o.now - USAGE_KEEP_DAYS * DAY)
    const last = Number((this.db.prepare("select value from meta where key = 'vacuumed_at'").get() as { value?: string } | undefined)?.value ?? 0)
    if (audit + conversations + usage > 0 && o.now - last > VACUUM_EVERY_MS) this.vacuum(o.now)
    return { audit, conversations }
  }

  private vacuum(now: number): void {
    this.db.prepare("insert into meta (key, value) values ('vacuumed_at', ?) on conflict (key) do update set value = excluded.value").run(String(now))
    this.db.exec('vacuum')
  }

  /** "删除全部 AI 数据": conversations (messages cascade) and usage; the audit log only when asked. Then vacuum. */
  deleteAll(o: { audit: boolean; now: number }): void {
    this.db.exec(`begin; delete from conversations; delete from usage;${o.audit ? ' delete from audit;' : ''} commit;`)
    this.vacuum(o.now)
  }

  /** Newest first, at most `limit`, from `since` (ms), optionally one account's. */
  auditRows(o: { since: number; accountId?: string; limit: number }): StoredAudit[] {
    const rows = (
      o.accountId
        ? this.db.prepare('select id, t, type, account_id as accountId, data_json from audit where t >= ? and account_id = ? order by id desc limit ?').all(o.since, o.accountId, o.limit)
        : this.db.prepare('select id, t, type, account_id as accountId, data_json from audit where t >= ? order by id desc limit ?').all(o.since, o.limit)
    ) as (Omit<StoredAudit, 'data'> & { data_json: string })[]
    return rows.map(({ data_json, ...r }) => ({ ...r, data: JSON.parse(data_json) }))
  }

  messages(conversationId: string): StoredMessage[] {
    const rows = this.db
      .prepare(
        'select id, role, content_json, tokens_in as tokensIn, tokens_out as tokensOut, created_at as createdAt from messages where conversation_id = ? order by id'
      )
      .all(conversationId) as (Omit<StoredMessage, 'content'> & { content_json: string })[]
    return rows.map(({ content_json, ...r }) => ({ ...r, content: JSON.parse(content_json) }))
  }

  /** Remove transcript rows from a selected message; usage and audit are separate append-only records. */
  truncateMessages(conversationId: string, fromId: number, keepIds: number[] = []): void {
    const keep = keepIds.length ? ` and id not in (${keepIds.map(() => '?').join(',')})` : ''
    this.db.prepare(`delete from messages where conversation_id = ? and id >= ?${keep}`).run(conversationId, fromId, ...keepIds)
    this.db.prepare('update conversations set updated_at = ? where id = ?').run(Date.now(), conversationId)
  }

  /** Messages go with their conversations (on delete cascade). The audit log is kept: it is a safety record. */
  clearAccount(accountId: string): void {
    this.db.prepare('delete from conversations where account_id = ?').run(accountId)
  }

  audit(type: string, accountId: string | null, data: unknown): void {
    this.db.prepare('insert into audit (t, type, account_id, data_json) values (?, ?, ?, ?)').run(Date.now(), type, accountId, redactSecrets(JSON.stringify(data)))
  }

  auditEntries(): { t: number; type: string; accountId: string | null; data: unknown }[] {
    const rows = this.db.prepare('select t, type, account_id as accountId, data_json from audit order by id').all() as {
      t: number
      type: string
      accountId: string | null
      data_json: string
    }[]
    return rows.map(({ data_json, ...r }) => ({ ...r, data: JSON.parse(data_json) }))
  }
}
