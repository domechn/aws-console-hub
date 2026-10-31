import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ApprovalView } from '../../../../shared/ai'

vi.stubGlobal('window', { api: { ai: {} } })
const { Item } = await import('./AssistantPanel')

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
