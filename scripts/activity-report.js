/**
 * Digest the activity log into something small enough to hand to an AI (or to
 * read yourself), to answer "which of my habits deserves a quick action?".
 *
 *   npm run activity                       (default log location)
 *   npm run activity -- /path/activity.jsonl
 *   node scripts/activity-report.js --selftest
 *
 * The raw log is one JSON object per line, appended by src/main/activity.ts.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Consecutive pages this far apart or less count as one workflow step. */
const HOP_MS = 120_000
const userData = path.join(os.homedir(), 'Library/Application Support/aws-console-hub')

function accountNames() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(userData, 'accounts.json'), 'utf8'))
    return new Map(list.map((a) => [a.id, a.name]))
  } catch {
    return new Map()
  }
}

/** Where the event happened, at the granularity worth counting. */
function label(e) {
  if (e.type === 'resource') return `${e.service}/${e.resourceType} ${e.name}`
  if (e.type === 'page') return e.page.replace(/^[a-z0-9-]+\.console\.aws\.amazon\.com/, '')
  return null
}

function tally(map, key, n = 1) {
  map.set(key, (map.get(key) ?? 0) + n)
}

const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)

function aggregate(events) {
  const types = new Map()
  const resources = new Map()
  const pages = new Map()
  const hops = new Map()
  const sources = new Map()
  const pickKinds = new Map()
  const misordered = new Map()
  const misses = new Map()
  const repeats = new Map()
  let previous = null

  for (const e of events) {
    tally(types, e.type)
    const where = label(e)
    if (where) {
      tally(e.type === 'resource' ? resources : pages, `${where}\t${e.accountId}`)
      if (previous && previous.where !== where && e.ts - previous.ts <= HOP_MS) {
        tally(hops, `${previous.where} → ${where}`)
      }
      previous = { where, ts: e.ts }
    }
    if (e.type === 'switch') tally(sources, e.source)
    if (e.type === 'palette-pick') {
      tally(pickKinds, e.kind)
      if (e.index > 0) tally(misordered, `"${e.query}" → 第 ${e.index + 1} 项 (${e.id})`)
    }
    if (e.type === 'palette-miss') tally(misses, `"${e.query}" (${e.results} 个结果)`)
    if (e.type === 'reload' || e.type === 'back') tally(repeats, `${e.type} ${e.accountId}`)
  }
  return { types, resources, pages, hops, sources, pickKinds, misordered, misses, repeats }
}

function render(events, names) {
  const a = aggregate(events)
  const out = []
  const day = (ts) => new Date(ts).toISOString().slice(0, 10)
  const withAccount = (key) => {
    const [where, accountId] = key.split('\t')
    return `${where}  [${names.get(accountId) ?? accountId ?? '-'}]`
  }
  const section = (title, rows) => {
    out.push('', `## ${title}`)
    if (rows.length === 0) out.push('(无)')
    for (const [key, count] of rows) out.push(`${String(count).padStart(4)}  ${key}`)
  }

  out.push(
    `# 操作日志摘要 — ${events.length} 条事件，${day(events[0].ts)} ~ ${day(events[events.length - 1].ts)}`
  )
  out.push('', '## 事件类型', top(a.types, 20).map(([k, v]) => `${k}=${v}`).join('  '))
  section('访问最多的资源', top(a.resources, 20).map(([k, v]) => [withAccount(k), v]))
  section('访问最多的服务页面', top(a.pages, 15).map(([k, v]) => [withAccount(k), v]))
  section(`连续跳转（间隔 <${HOP_MS / 1000}s）`, top(a.hops, 15).filter(([, v]) => v > 1))
  section('⌘K 选中类型', top(a.pickKinds, 10))
  section('⌘K 命中但不在首位（排序或别名不够好）', top(a.misordered, 10))
  section('⌘K 输入后放弃（缺少的功能）', top(a.misses, 15))
  section('账号切换入口', top(a.sources, 10))
  section('刷新 / 后退次数', top(a.repeats, 10).map(([k, v]) => [withAccount(k.replace(' ', '\t')), v]))
  return out.join('\n')
}

function read(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

function selftest() {
  const assert = require('node:assert')
  const t = Date.parse('2026-09-01T10:00:00Z')
  const events = [
    { ts: t, type: 'resource', accountId: 'a', service: 'lambda', resourceType: 'function', name: 'pay' },
    { ts: t + 1000, type: 'resource', accountId: 'a', service: 'logs', resourceType: 'log-group', name: '/aws/lambda/pay' },
    { ts: t + 2000, type: 'resource', accountId: 'a', service: 'lambda', resourceType: 'function', name: 'pay' },
    { ts: t + 3000, type: 'resource', accountId: 'a', service: 'logs', resourceType: 'log-group', name: '/aws/lambda/pay' },
    // Too far apart to be one workflow step.
    { ts: t + 3000 + HOP_MS + 1, type: 'page', accountId: 'a', page: 'us-east-1.console.aws.amazon.com/sqs/home' },
    { ts: t + 4000 + HOP_MS, type: 'palette-miss', query: 'sqs dlq', results: 0 },
    { ts: t + 5000 + HOP_MS, type: 'switch', accountId: 'a', source: 'hotkey' }
  ]
  const a = aggregate(events)
  assert.equal(a.resources.get('lambda/function pay\ta'), 2)
  assert.equal(a.hops.get('lambda/function pay → logs/log-group /aws/lambda/pay'), 2)
  assert.equal(a.hops.size, 2, 'the >HOP_MS gap must not become a hop')
  assert.equal(a.misses.get('"sqs dlq" (0 个结果)'), 1)
  assert.equal(a.sources.get('hotkey'), 1)
  assert.ok(render(events, new Map([['a', 'prod']])).includes('[prod]'))
  console.log('selftest ok')
}

const arg = process.argv[2]
if (arg === '--selftest') {
  selftest()
} else {
  const file = arg || path.join(userData, 'activity.jsonl')
  const events = fs.existsSync(file) ? read(file) : []
  if (events.length === 0) {
    console.error(`没有操作日志：${file}`)
    process.exit(1)
  }
  console.log(render(events, accountNames()))
}
