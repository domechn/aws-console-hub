import { describe, expect, it } from 'vitest'
import { auditCsv, auditDigest, createdIndex, filterAudit, parseSince, summarize, type AuditRow } from './auditDigest'

const NOW = Date.parse('2026-10-29T12:00:00Z')
const row = (t: string, type: string, data: Record<string, unknown>, accountId = 'acc-1'): AuditRow => ({ t: Date.parse(t), type, accountId, data })

describe('auditDigest', () => {
  it('answers "what did the AI change this week", per account, with outcomes and forbidden attempts', () => {
    const rows = [
      row('2026-10-10T00:00:00Z', 'proposal_executed', { proposalId: 'p-old', status: 'succeeded' }),
      row('2026-10-28T06:00:00Z', 'proposal_created', { proposalId: 'p-1', service: 'ec2', action: 'StopInstances', targets: ['i-0abc'], risk: 'medium', params: '{"InstanceIds":["i-0abc"]}' }),
      row('2026-10-28T06:01:00Z', 'proposal_confirmed', { proposalId: 'p-1', actor: 'user' }),
      row('2026-10-28T06:01:01Z', 'proposal_executed', { proposalId: 'p-1', status: 'succeeded', requestId: 'req-1', summary: 'i-0abc: stopping' }),
      row('2026-10-28T07:00:00Z', 'proposal_created', { proposalId: 'p-2', service: 'rds', action: 'DeleteDBInstance', targets: ['db-1'], risk: 'destructive' }),
      row('2026-10-28T07:01:00Z', 'proposal_drift', { proposalId: 'p-2', changes: ['db-1.status：available → stopped'] }),
      row('2026-10-28T08:00:00Z', 'proposal_cancelled', { proposalId: 'p-3' }),
      row('2026-10-28T09:00:00Z', 'forbidden_attempt', { service: 'iam', action: 'CreateAccessKey' }),
      row('2026-10-28T09:01:00Z', 'forbidden_attempt', { service: 'iam', action: 'CreateAccessKey' }),
      row('2026-10-28T09:02:00Z', 'tool_call', { tool: 'list_ec2_instances' }),
      row('2026-10-28T10:00:00Z', 'proposal_refused', { service: 'ec2', action: 'StopInstances', cause: 'policy' }, 'acc-2')
    ]
    const text = auditDigest(rows, { now: NOW, days: 7, accountName: (id) => (id === 'acc-1' ? 'Prod · 123456789012' : undefined) })
    expect(text).toContain('过去 7 天（2026-10-22 ~ 2026-10-29，UTC）')
    expect(text).toContain('账号 Prod · 123456789012（acc-1）')
    expect(text).toContain('提出 2 · 确认 1 · 已执行 1 · 失败 0 · 漂移未执行 1 · 取消 1 · 过期 0 · 确认被拒 0 · 提案被拒 0 · 禁止的尝试 2')
    expect(text).toContain('   2026-10-28\n    06:01  ec2:StopInstances  i-0abc  中风险  ✓ 成功 · req-1 · i-0abc: stopping  [p-1]')
    expect(text).toContain('rds:DeleteDBInstance  db-1  破坏性风险  ⚠ 状态已变化，未执行 · db-1.status：available → stopped')
    expect(text).toContain('被禁止的尝试：iam:CreateAccessKey ×2')
    expect(text).toContain('账号 acc-2')
    expect(text).not.toContain('p-old')
    expect(text).not.toContain('InstanceIds')
  })

  it('filters by time, account, risk and scope; risk comes from the proposal row', () => {
    const rows = [
      row('2026-10-20T00:00:00Z', 'proposal_created', { proposalId: 'p-1', service: 'ec2', action: 'TerminateInstances', risk: 'destructive', targets: ['i-1'] }),
      row('2026-10-28T00:00:00Z', 'proposal_executed', { proposalId: 'p-1', status: 'succeeded' }),
      row('2026-10-28T01:00:00Z', 'proposal_created', { proposalId: 'p-2', risk: 'low' }, 'acc-2'),
      row('2026-10-28T02:00:00Z', 'tool_call', { tool: 'list_ec2_instances' })
    ]
    const ids = (q: Parameters<typeof filterAudit>[1]) => filterAudit(rows, q).map((r) => r.data.proposalId ?? r.type)
    expect(ids({ since: Date.parse('2026-10-27T00:00:00Z') })).toEqual(['p-1', 'p-2', 'tool_call'])
    expect(ids({ accounts: new Set(['acc-2']) })).toEqual(['p-2'])
    expect(ids({ risks: new Set(['destructive']) })).toEqual(['p-1', 'p-1'])
    expect(ids({ changesOnly: true, until: Date.parse('2026-10-28T01:30:00Z') })).toEqual(['p-1', 'p-1', 'p-2'])
  })

  it('summarizes rows without params or tool arguments, and exports CSV safe for spreadsheets', () => {
    const rows = [
      row('2026-10-28T06:00:00Z', 'proposal_created', { proposalId: 'p-1', service: 'ec2', action: 'StopInstances', risk: 'medium', targets: ['i-0abc'], params: '{"InstanceIds":["i-0abc"]}', actor: 'model' }),
      row('2026-10-28T06:01:01Z', 'proposal_failed', { proposalId: 'p-1', error: 'UnauthorizedOperation: "no", sorry\nline2' }),
      row('2026-10-28T06:02:00Z', 'tool_call', { tool: 'aws_read', args: 'service=ec2 action=DescribeInstances', ok: true }),
      row('2026-10-28T06:03:00Z', 'proposal_refused', { service: 'ec2', action: 'StopInstances', reason: '=HYPERLINK("http://x")' })
    ].map((r, i) => ({ ...r, id: i + 1 }))
    const created = createdIndex(rows)
    const s = rows.map((r) => summarize(r, created))
    expect(s[1]).toEqual({ id: 2, t: rows[1].t, type: 'proposal_failed', accountId: 'acc-1', proposalId: 'p-1', service: 'ec2', action: 'StopInstances', risk: 'medium', targets: ['i-0abc'], detail: 'UnauthorizedOperation: "no", sorry line2' })
    expect(s[2].detail).toBe('aws_read')
    expect(JSON.stringify(s)).not.toContain('InstanceIds')
    expect(JSON.stringify(s)).not.toContain('DescribeInstances')
    const csv = auditCsv(s, (id) => (id === 'acc-1' ? 'Prod · 123456789012' : undefined)).split('\r\n')
    expect(csv[0]).toBe('time_utc,type,accountId,proposalId,service,action,risk,targets,actor,detail,requestId,conversationId,account_name')
    expect(csv[1]).toBe('2026-10-28T06:00:00.000Z,proposal_created,acc-1,p-1,ec2,StopInstances,medium,i-0abc,model,,,,Prod · 123456789012')
    expect(csv[2]).toContain(',"UnauthorizedOperation: ""no"", sorry line2",')
    expect(csv[4]).toContain(`,"'=HYPERLINK(""http://x"")",`)
  })

  it('counts approvals as changes-and-policy rows, summarized without params', () => {
    const rows = [
      row('2026-10-29T01:00:00Z', 'approval_requested', { approvalId: 'a-1', service: 'sqs', action: 'ListQueues', params: '{"QueueNamePrefix":"x"}', actor: 'model' }),
      row('2026-10-29T01:00:01Z', 'approval_denied', { approvalId: 'a-1', service: 'sqs', action: 'ListQueues', decision: 'deny', actor: 'user' }),
      row('2026-10-29T01:00:02Z', 'approval_auto', { service: 'sqs', action: 'ListQueues', cause: 'session-allow' }),
      row('2026-10-29T01:00:03Z', 'tool_call', { tool: 'aws_read' })
    ]
    expect(filterAudit(rows, { changesOnly: true }).map((r) => r.type)).toEqual(['approval_requested', 'approval_denied', 'approval_auto'])
    const s = summarize(rows[1], new Map())
    expect(s).toMatchObject({ service: 'sqs', action: 'ListQueues', actor: 'user', detail: 'deny' })
    expect(JSON.stringify(summarize(rows[0], new Map()))).not.toContain('QueueNamePrefix')
    expect(auditDigest(rows, { now: NOW, days: 7 })).toContain('审批拒绝')
  })

  it('an impact analysis row is a change row, summarized as status, calls and the risk it raised', () => {
    const a = row('2026-10-29T01:00:00Z', 'proposal_analysis', { proposalId: 'p-1', status: 'done', calls: 3, analysisHash: 'sha256:0123', riskRaised: { from: 'high', to: 'destructive' } })
    expect(filterAudit([a], { changesOnly: true })).toHaveLength(1)
    expect(summarize(a, new Map()).detail).toBe('done · 3 次查询 · 风险 高 → 破坏性')
  })

  it('parses --since as a date or a day count', () => {
    expect(parseSince('2026-10-01', NOW)).toBe(Date.parse('2026-10-01T00:00:00Z'))
    expect(parseSince('14d', NOW)).toBe(NOW - 14 * 86400_000)
    expect(parseSince('last week', NOW)).toBeNaN()
  })

  it('prints no terminal escape sequences from stored strings', () => {
    const rows = [
      row('2026-10-28T06:00:00Z', 'proposal_created', { proposalId: 'p-1', service: 'ec2', action: 'StopInstances', targets: ['\u001b[2Jx'] }),
      row('2026-10-28T06:01:00Z', 'proposal_drift', { proposalId: 'p-1', changes: ['web.Tags.note：a → \u001b]0;pwned\u0007'] }),
      row('2026-10-28T06:02:00Z', 'forbidden_attempt', { service: '\u001b[31miam', action: 'X' })
    ]
    expect(auditDigest(rows, { now: NOW, days: 7 })).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
  })

  it('says so when nothing was proposed', () => {
    expect(auditDigest([row('2026-10-28T09:02:00Z', 'tool_call', {})], { now: NOW, days: 7 })).toContain('没有任何变更提案')
  })
})
