import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ApprovalView } from '../../../../shared/ai'

vi.stubGlobal('window', { api: { ai: {} } })
const { Item, QueueView } = await import('./AssistantPanel')

it('shows queued user messages and a per-item cancellation control', () => {
  const html = renderToStaticMarkup(<QueueView queue={[{ id: 'q1', text: '<b>next</b>' }]} onCancel={() => {}} />)
  expect(html).toContain('排队中')
  expect(html).toContain('&lt;b&gt;next&lt;/b&gt;')
  expect(html).toContain('取消排队')
  expect(html).not.toContain('<b>')
})

it('shows queued attachments and user file metadata without exposing content', () => {
  const attachment = { id: 'safe', kind: 'file' as const, name: 'notes.txt', size: 42, redactions: 2, truncated: true }
  const html = renderToStaticMarkup(<QueueView queue={[{ id: 'q1', text: 'read', attachments: [attachment] }]} onCancel={() => {}} />)
  expect(html).toContain('notes.txt')
  expect(html).toContain('已隐藏 2 处疑似密钥')
  expect(html).toContain('已截断')
})

it('shows trusted resources on a user turn as plain text', () => {
  const html = renderToStaticMarkup(<Item item={{ kind: 'user', text: '<b>question</b>', resources: [{ type: 'ec2', id: 'i-1', region: 'us-east-1', label: '<img>' }] }} index={0} userIndex={0}
    retryable={false} actionsDisabled={false} cardDisabled={false} editing={false} editText="" onEditText={() => {}}
    onEdit={() => {}} onCancelEdit={() => {}} onRegenerate={() => {}} onCopy={() => {}} onOpenModel={() => {}}
    older={false} onLink={() => {}} onCardAction={async () => ({ ok: true })} onProposal={async () => ({ ok: true })}
    onApproval={async () => ({ ok: true })} accountColor="#123456" />)
  expect(html).toContain('&lt;img&gt; · i-1 · us-east-1')
  expect(html).not.toContain('<img>')
})
it('shows inherited resource chips with removal controls while editing', () => {
  const html = renderToStaticMarkup(<Item item={{ kind: 'user', text: 'question', resources: [{ type: 'ec2/Instance', id: 'i-1', region: 'us-east-1', label: 'server' }] }} index={0} userIndex={0}
    retryable={false} actionsDisabled={false} cardDisabled={false} editing editText="question" editResources={[{ type: 'ec2/Instance', id: 'i-1', region: 'us-east-1', label: 'server' }]} onEditText={() => {}} onRemoveEditResource={() => {}}
    onEdit={() => {}} onCancelEdit={() => {}} onRegenerate={() => {}} onCopy={() => {}} onOpenModel={() => {}}
    older={false} onLink={() => {}} onCardAction={async () => ({ ok: true })} onProposal={async () => ({ ok: true })}
    onApproval={async () => ({ ok: true })} accountColor="#123456" />)
  expect(html).toContain('移除资源引用：server')
  expect(html).toContain('server · i-1 · us-east-1')
})

it('adds the proposal comparison to an executed result card when provided', () => {
  const html = renderToStaticMarkup(<Item item={{ kind: 'card', id: 'r-p-1', card: {
    v: 2, id: 'c-0123456789ab', origin: 'system', title: '已执行 · 修改',
    blocks: [{ type: 'kv', items: [{ label: '结果', value: '成功' }] }],
    createdAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, state: 'active'
  } }} resultChange={{ type: 'change', kind: 'modify', summary: '提案', rows: [{ item: '容量', before: '1', after: '2' }] }} index={0} userIndex={0}
    retryable={false} actionsDisabled={false} cardDisabled={false} editing={false} editText="" onEditText={() => {}}
    onEdit={() => {}} onCancelEdit={() => {}} onRegenerate={() => {}} onCopy={() => {}} onOpenModel={() => {}}
    older={false} onLink={() => {}} onCardAction={async () => ({ ok: true })} onProposal={async () => ({ ok: true })}
    onApproval={async () => ({ ok: true })} accountColor="#123456" />)
  expect(html).toContain('已执行的变更（提案时 → 执行目标）')
  expect(html).toContain('<th scope="row">容量</th><td class="before">1</td><td class="after">2</td>')
})

it('does not pass message action disabled state to a pending approval', () => {
  const approval: ApprovalView = {
    id: 'a-0123456789ab',
    toolCallId: 'call-1',
    state: 'pending',
    service: 'sqs',
    action: 'GetQueueUrl',
    region: 'us-east-1',
    accountName: 'Dev',
    awsAccountId: '123456789012',
    params: '{"QueueName":"q"}',
    reason: 'check',
    why: ['requires approval'],
    sessionAllowed: true,
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    hash: `sha256:${'a'.repeat(64)}`
  }
  const html = renderToStaticMarkup(<Item item={{ kind: 'approval', id: approval.id, approval }} index={0} userIndex={0}
    retryable={false} actionsDisabled cardDisabled={false} editing={false} editText="" onEditText={() => {}}
    onEdit={() => {}} onCancelEdit={() => {}} onRegenerate={() => {}} onCopy={() => {}} onOpenModel={() => {}}
    older={false} onLink={() => {}} onCardAction={async () => ({ ok: true })} onProposal={async () => ({ ok: true })}
    onApproval={async () => ({ ok: true })} accountColor="#123456" />)
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>拒绝/)
  expect(html).toContain('本对话始终允许此操作')
  expect(html).toContain('QueueName')
})
