// What the AI assistant changed: a digest of the audit table in ai.sqlite (read-only).
//
//   npm run ai-audit                                  (default location, last 7 days, per account, grouped by day)
//   npm run ai-audit -- --days 30
//   npm run ai-audit -- --since 2026-10-01            (or --since 14d)
//   npm run ai-audit -- --account Prod                (app account id, 12-digit AWS id, or part of the name)
//   npm run ai-audit -- --risk high,destructive       (proposal rows of these risks)
//   npm run ai-audit -- --csv > audit.csv             (summaries: no params, no results)
//   npm run ai-audit -- /path/to/ai.sqlite --json     (raw audit rows of the period, for export)
//
// The digest logic is src/main/ai/auditDigest.ts, loaded through Node's type stripping (Node >= 22.18).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const { auditCsv, auditDigest, createdIndex, filterAudit, parseSince, summarize } = await import('../src/main/ai/auditDigest.ts')

/** Electron's appData on each platform; main/index.ts puts userData in appData/aws-console-hub. */
function userData() {
  const home = os.homedir()
  const appData =
    process.platform === 'darwin'
      ? path.join(home, 'Library/Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? path.join(home, 'AppData/Roaming'))
        : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'))
  return path.join(appData, 'aws-console-hub')
}

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const VALUED = new Set(['--days', '--since', '--account', '--risk'])
const args = process.argv.slice(2)
const value = (name) => {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const v = args[at + 1]
  if (v === undefined || v.startsWith('--')) fail(`${name} needs a value`)
  return v
}
for (const a of args) if (a.startsWith('--') && !VALUED.has(a) && a !== '--json' && a !== '--csv') fail(`unknown option ${a}`)

const now = Date.now()
const days = value('--days') !== undefined ? Number(value('--days')) : 7
if (!Number.isFinite(days) || days <= 0) fail('--days needs a positive number')
const since = value('--since') !== undefined ? parseSince(value('--since'), now) : now - days * 86400_000
if (!Number.isFinite(since)) fail('--since needs YYYY-MM-DD or <n>d')
const risks = value('--risk')?.split(',').map((r) => r.trim())
if (risks?.some((r) => !['low', 'medium', 'high', 'destructive'].includes(r))) fail('--risk takes low, medium, high, destructive (comma separated)')

const file = args.find((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1])) ?? path.join(userData(), 'ai.sqlite')
if (!fs.existsSync(file)) fail(`No AI database at ${file}`)

let accounts = []
try {
  accounts = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'accounts.json'), 'utf8'))
} catch {
  // No accounts file next to the database: ids only.
}
const names = new Map(accounts.map((a) => [a.id, `${a.name} · ${a.accountId}`]))
let accountIds
const wanted = value('--account')
if (wanted !== undefined) {
  const q = wanted.toLowerCase()
  accountIds = new Set([wanted, ...accounts.filter((a) => a.id === wanted || a.accountId === wanted || String(a.name).toLowerCase().includes(q)).map((a) => a.id)])
}

const db = new DatabaseSync(file, { readOnly: true })
// A day of slack before the period, so executions there still find their proposal_created row.
const rows = db
  .prepare('select id, t, type, account_id as accountId, data_json from audit where t >= ? order by id')
  .all(since - 86400_000)
  .map(({ data_json, ...r }) => ({ ...r, data: JSON.parse(data_json) }))
db.close()

const picked = filterAudit(rows, { since, until: now, accounts: accountIds, risks: risks && new Set(risks) })
if (args.includes('--json')) console.log(JSON.stringify(picked, null, 2))
else if (args.includes('--csv')) {
  const created = createdIndex(rows)
  console.log(auditCsv(picked.map((r) => summarize(r, created)), (id) => names.get(id)))
} else {
  // The digest joins executions to their proposal rows: give it the whole window, filtered by account and risk only.
  const scoped = filterAudit(rows, { accounts: accountIds, risks: risks && new Set(risks) })
  console.log(auditDigest(scoped, { now, days, since, accountName: (id) => names.get(id) }))
}
