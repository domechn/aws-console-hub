import { describe, expect, it } from 'vitest'
import type { AiConfigView, ChatItem, ProposalView } from '../../shared/ai'
import type { Card } from '../../shared/cards'
import { aiReady, allowWriteWarning, applyEvent, formatCountdown, formatMonth, formatRates, formatUsage, formatUsd, ipcError, pendingProposals } from './ai'

describe('applyEvent', () => {
  it('keeps elapsed time on a completed live tool and puts provider errors inline', () => {
    let items = applyEvent([{ kind: 'user', text: 'q' }], { type: 'tool-start', id: 'a', label: '查询', t: 100 })
    items = applyEvent(items, { type: 'tool-end', id: 'a', ok: true, t: 1900 })
    expect(items[1]).toMatchObject({ kind: 'tool', ms: 1800 })
    items = applyEvent(items, { type: 'error', message: '限流' })
    expect(items[2]).toMatchObject({ kind: 'assistant', error: '限流' })
  })
  it('streams text into a new assistant item after the user message, then into the same one', () => {
    let items: ChatItem[] = [{ kind: 'user', text: 'hi' }]
    items = applyEvent(items, { type: 'text-delta', text: '你' })
    items = applyEvent(items, { type: 'text-delta', text: '好' })
    expect(items).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: '你好' }
    ])
  })
  it('shows a dequeued user turn with its resource chips after the prior answer', () => {
    const resources = [{ type: 'ec2/Instance', id: 'i-1', region: 'us-east-1', label: 'server' }]
    expect(applyEvent([{ kind: 'user', text: 'A' }, { kind: 'assistant', text: 'answer A' }], { type: 'user', text: 'B', resources })).toEqual([
      { kind: 'user', text: 'A' }, { kind: 'assistant', text: 'answer A' }, { kind: 'user', text: 'B', resources }
    ])
  })

  it('shows tool progress and starts a fresh reply after it', () => {
    let items: ChatItem[] = [{ kind: 'user', text: 'q' }]
    items = applyEvent(items, { type: 'text-delta', text: '查一下' })
    items = applyEvent(items, { type: 'tool-start', id: 't1', label: '查询 EC2 实例' })
    expect(items.at(-1)).toEqual({ kind: 'tool', id: 't1', label: '查询 EC2 实例', status: 'running' })
    items = applyEvent(items, { type: 'tool-end', id: 't1', ok: true, summary: '3 台' })
    items = applyEvent(items, { type: 'text-delta', text: '有 3 台' })
    expect(items.slice(2)).toEqual([
      { kind: 'tool', id: 't1', label: '查询 EC2 实例', status: 'ok', summary: '3 台' },
      { kind: 'assistant', text: '有 3 台' }
    ])
  })

  it('shows a card skeleton, then the card in its place; a failed card becomes a failed tool row', () => {
    const card: Card = { v: 1, id: 'c-0123456789ab', origin: 'model', blocks: [{ type: 'markdown', text: 'x' }], createdAt: 0, expiresAt: 1, state: 'active' }
    let items: ChatItem[] = [{ kind: 'user', text: 'q' }, { kind: 'assistant', text: '如下：' }]
    items = applyEvent(items, { type: 'card-pending', id: 't1' })
    items = applyEvent(items, { type: 'card-pending', id: 't1' })
    expect(items.slice(2)).toEqual([{ kind: 'card', id: 't1', card: null }])
    items = applyEvent(items, { type: 'card', id: 't1', card })
    items = applyEvent(items, { type: 'text-delta', text: '完' })
    expect(items.slice(2)).toEqual([{ kind: 'card', id: 't1', card }, { kind: 'assistant', text: '完' }])
    items = applyEvent(items, { type: 'card-state', cardId: card.id, state: 'resolved' })
    expect(items[2]).toMatchObject({ card: { state: 'resolved' } })
    items = applyEvent(items, { type: 'user', text: '「详情」' })
    expect(items.at(-1)).toEqual({ kind: 'user', text: '「详情」' })
    items = applyEvent(items, { type: 'card-pending', id: 't2' })
    items = applyEvent(items, { type: 'tool-end', id: 't2', ok: false, summary: '卡片无效' })
    expect(items.at(-1)).toEqual({ kind: 'tool', id: 't2', label: '生成卡片', status: 'error', summary: '卡片无效' })
  })

  it('a note is its own quiet line; the reply after it is a new assistant item', () => {
    let items: ChatItem[] = [{ kind: 'user', text: 'q' }, { kind: 'assistant', text: '我查一下' }]
    items = applyEvent(items, { type: 'note', text: '已达到步骤上限，以下基于已有结果' })
    items = applyEvent(items, { type: 'text-delta', text: '有 8 个桶' })
    expect(items.slice(2)).toEqual([
      { kind: 'note', text: '已达到步骤上限，以下基于已有结果' },
      { kind: 'assistant', text: '有 8 个桶' }
    ])
  })

  it('leaves items alone for non-display events', () => {
    const items: ChatItem[] = [{ kind: 'user', text: 'q' }]
    expect(applyEvent(items, { type: 'done' })).toBe(items)
  })

  it('places a queued turn error after its own user item', () => {
    const items: ChatItem[] = [
      { kind: 'user', text: 'first' },
      { kind: 'assistant', text: 'done' },
      { kind: 'user', text: 'second' }
    ]
    expect(applyEvent(items, { type: 'error', message: 'failed' })).toEqual([
      ...items,
      { kind: 'assistant', text: '', error: 'failed' }
    ])
  })

  it('does not attach a queued failure to the previous reply', () => {
    const items: ChatItem[] = [{ kind: 'user', text: 'first' }, { kind: 'assistant', text: 'prior reply' }]
    expect(applyEvent(items, { type: 'error', message: 'setup failed', retryable: false })).toEqual([
      ...items,
      { kind: 'assistant', text: '', error: 'setup failed', retryable: false }
    ])
  })
  it('shows a live failure separately from a completed reply', () => {
    const items: ChatItem[] = [{ kind: 'user', text: 'first' }, { kind: 'assistant', text: 'finished' }]
    expect(applyEvent(items, { type: 'error', message: 'failed' })).toEqual([
      ...items,
      { kind: 'assistant', text: '', error: 'failed' }
    ])
  })
})

describe('aiReady', () => {
  const base: AiConfigView = {
    version: 8,
    customImageInput: false,
    scriptMaxMinutes: 5,
    provider: 'deepseek',
    model: 'deepseek-flash',
    baseUrl: null,
    keyMode: 'keychain',
    keyCommand: null,
    bedrockAuth: 'account',
    bedrockAccountId: null,
    bedrockRegion: 'us-east-1',
    awsCliPath: null,
    auditRetentionDays: 180,
    conversationRetention: null,
    budget: { monthlyTokens: null, monthlyUsd: null, block: false },
    readPage: true,
    quickReplies: true,
    impactAnalysis: true,
    hasKey: true,
    canPersistKey: true,
    canAttachImages: false
  }
  it('needs provider, model and key; a custom endpoint needs a baseURL but no key', () => {
    expect(aiReady(base)).toBe(true)
    expect(aiReady(null)).toBe(false)
    expect(aiReady({ ...base, hasKey: false })).toBe(false)
    expect(aiReady({ ...base, model: '' })).toBe(false)
    expect(aiReady({ ...base, provider: 'custom-openai', hasKey: false, baseUrl: 'http://localhost:11434/v1' })).toBe(true)
    expect(aiReady({ ...base, provider: 'custom-openai', baseUrl: null })).toBe(false)
  })

  it('Bedrock needs the account in account mode, the key in API-key mode', () => {
    const bedrock = { ...base, provider: 'amazon-bedrock', model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', hasKey: false }
    expect(aiReady(bedrock)).toBe(false)
    expect(aiReady({ ...bedrock, bedrockAccountId: 'acc-1' })).toBe(true)
    expect(aiReady({ ...bedrock, bedrockAuth: 'apiKey', bedrockAccountId: 'acc-1' })).toBe(false)
    expect(aiReady({ ...bedrock, bedrockAuth: 'apiKey', hasKey: true })).toBe(true)
  })
})

describe('formatting', () => {
  it('shows usage and estimated cost compactly', () => {
    const u = { input: 12_345, output: 678, cacheRead: 0, cacheWrite: 0, cost: 0.0042, costUnknown: false }
    expect(formatUsage(u)).toBe('输入 12.3k / 输出 678 tokens · $0.0042')
    expect(formatUsage({ ...u, cacheRead: 2048 })).toBe('输入 12.3k / 输出 678 / 缓存 2.0k tokens · $0.0042')
    expect(formatUsage({ ...u, costUnknown: true })).toBe('输入 12.3k / 输出 678 tokens · $0.0042+')
    expect(formatUsage({ ...u, cost: 0, costUnknown: true })).toBe('输入 12.3k / 输出 678 tokens · 费用未知')
    expect(formatMonth({ totals: u, budget: null, blocked: false })).toBe('本月 13.0k tokens · $0.0042')
    expect(formatMonth({ totals: { ...u, costUnknown: true }, budget: null, blocked: false })).toBe('本月 13.0k tokens · $0.0042+')
    expect(formatMonth({ totals: { ...u, cost: 0, costUnknown: true }, budget: null, blocked: false })).toBe('本月 13.0k tokens')
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(1.234)).toBe('$1.23')
  })

  it('shows catalog prices per 1M tokens', () => {
    expect(formatRates({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 })).toBe('输入 $0.3 · 输出 $1.2 · 缓存读 $0.006（每百万 token，目录价）')
    expect(formatRates({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toContain('没有价格')
  })

  it('strips Electron’s invoke prefix from errors', () => {
    expect(ipcError(new Error("Error invoking remote method 'ai:send': Error: 还没有设置 API key"))).toBe('还没有设置 API key')
  })
})

describe('proposal events', () => {
  const card: Card = { v: 1, id: 'c-0123456789ab', origin: 'system', blocks: [{ type: 'markdown', text: 'x' }], createdAt: 0, expiresAt: 1, state: 'active' }
  const proposal = (state: ProposalView['state'], expiresAt = Date.now() + 60_000): ProposalView => ({
    id: 'p-0123456789ab',
    state,
    title: 't',
    risk: 'medium',
    accountName: 'A',
    awsAccountId: '123456789012',
    region: 'us-east-1',
    production: false,
    createdAt: 0,
    expiresAt,
    card
  })

  it('replaces the propose_change row with the proposal, updates its state, appends the result card once', () => {
    let items: ChatItem[] = [{ kind: 'tool', id: 't1', label: '提议变更 ec2:StopInstances', status: 'running' }]
    items = applyEvent(items, { type: 'proposal', id: 't1', proposal: proposal('pending') })
    expect(items).toEqual([{ kind: 'proposal', id: 't1', proposal: proposal('pending', items[0].kind === 'proposal' ? items[0].proposal.expiresAt : 0) }])
    expect(pendingProposals(items)).toEqual(['p-0123456789ab'])
    items = applyEvent(items, { type: 'proposal-state', proposal: { ...proposal('executing'), outcome: '…' } })
    expect(items[0]).toMatchObject({ proposal: { state: 'executing' } })
    expect(pendingProposals(items)).toEqual([])
    items = applyEvent(items, { type: 'proposal-result', id: 'r-p-0123456789ab', card })
    items = applyEvent(items, { type: 'proposal-result', id: 'r-p-0123456789ab', card })
    expect(items.map((i) => i.kind)).toEqual(['proposal', 'card'])
  })

  it('does not count expired proposals as pending; formats the countdown', () => {
    expect(pendingProposals([{ kind: 'proposal', id: 't', proposal: proposal('pending', Date.now() - 1) }])).toEqual([])
    expect(formatCountdown(600_000)).toBe('10:00')
    expect(formatCountdown(61_001)).toBe('1:02')
    expect(formatCountdown(-5)).toBe('0:00')
  })

  it('warns before writes are turned on', () => {
    expect(allowWriteWarning('prod')).toContain('「prod」')
    expect(allowWriteWarning('prod')).toContain('两次确认')
  })
})

it('copies queued user attachment metadata into the live item', () => {
  const attachments = [{ id: 'image', kind: 'image' as const, name: 'shot.png', size: 10, thumbDataUrl: 'data:image/png;base64,AAAA' }]
  expect(applyEvent([], { type: 'user', text: 'queued', attachments })).toEqual([{ kind: 'user', text: 'queued', attachments }])
})
