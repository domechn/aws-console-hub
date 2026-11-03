import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AiConfigView, AiModelInfo, MonthUsage, UsageTotals } from '../../../../shared/ai'
import { Composer, composerKey, draftKey, draftStore, modelLabel, recall, scopedContent, restoreFailedSend, recallForScope, resourceToken, insertResource } from './Composer'

const key = (k: string, patch: Partial<Parameters<typeof composerKey>[0]> = {}): Parameters<typeof composerKey>[0] => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  ...patch
})

const config = { provider: 'amazon-bedrock', model: 'sonnet', readPage: true } as AiConfigView
const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }
const MODELS: AiModelInfo[] = [
  { id: 'sonnet', name: 'Claude Sonnet 5.5', contextWindow: 1, reasoning: true, cost: rates },
  { id: 'haiku', name: 'Claude Haiku 5.5', contextWindow: 1, reasoning: false, cost: { ...rates, input: 1, output: 5 } }
]
const usage: UsageTotals = { input: 2000, output: 1100, cacheRead: 0, cacheWrite: 0, cost: 0.0312, costUnknown: false } as UsageTotals
const month = { totals: { ...usage, input: 1_000_000, output: 240_000, cost: 4.1 }, budget: null, blocked: false } as unknown as MonthUsage

const render = (patch: Partial<Parameters<typeof Composer>[0]> = {}): string =>
  renderToStaticMarkup(
    <Composer
      scope="account/conversation"
      value=""
      onChange={() => {}}
      onSend={() => {}}
      onStop={() => {}}
      onClose={() => {}}
      busy={false}
      history={[]}
      inputRef={createRef()}
      chip={<span className="ai-page-chip">当前页面：EC2 · web-1</span>}
      config={config}
      models={MODELS}
      onModel={() => {}}
      onOpenSettings={() => {}}
      usage={null}
      month={null}
      {...patch}
    />
  )

describe('composerKey', () => {
  it('↵ sends, ⇧↵ is a new line, esc stops a run and otherwise closes the panel', () => {
    expect(composerKey(key('Enter'), false)).toBe('send')
    expect(composerKey(key('Enter', { shiftKey: true }), false)).toBeNull()
    expect(composerKey(key('Escape'), true)).toBe('stop')
    expect(composerKey(key('Escape'), false)).toBe('close')
    expect(composerKey(key('a'), false)).toBeNull()
  })

  it('IME-safe: no send (or close) while a candidate is being composed', () => {
    expect(composerKey(key('Enter', { isComposing: true }), false)).toBeNull()
    // Chromium's commit Enter can arrive with isComposing already false but keyCode 229.
    expect(composerKey(key('Enter', { keyCode: 229 }), false)).toBeNull()
    expect(composerKey(key('Escape', { isComposing: true }), true)).toBeNull()
  })

  it('↑ / ↓ only without modifiers (⌘↑ and ⇧↑ keep their caret meaning)', () => {
    expect(composerKey(key('ArrowUp'), false)).toBe('history-up')
    expect(composerKey(key('ArrowDown'), false)).toBe('history-down')
    expect(composerKey(key('ArrowUp', { metaKey: true }), false)).toBeNull()
    expect(composerKey(key('ArrowUp', { shiftKey: true }), false)).toBeNull()
  })
})

describe('recall (↑ history)', () => {
  const sent = ['第一条', '第二条', '第三条']

  it('starts from an empty input (or the caret at the start), newest first, and stops at the oldest', () => {
    let r = recall(sent, '', true, null, 'up')!
    expect(r.value).toBe('第三条')
    r = recall(sent, r.value, false, r.at, 'up')!
    expect(r.value).toBe('第二条')
    r = recall(sent, r.value, false, r.at, 'up')!
    expect(r.value).toBe('第一条')
    expect(recall(sent, r.value, false, r.at, 'up')!.value).toBe('第一条')
  })

  it('↓ walks forward and gives back what was typed before', () => {
    const first = recall(sent, '草稿', true, null, 'up')!
    expect(first.at).toEqual({ index: 2, stash: '草稿' })
    const back = recall(sent, first.value, false, first.at, 'down')!
    expect(back).toEqual({ value: '草稿', at: null })
  })

  it('leaves the key alone mid-text, with no history, after an edit, and for ↓ when not browsing', () => {
    expect(recall(sent, '正在写', false, null, 'up')).toBeNull()
    expect(recall([], '', true, null, 'up')).toBeNull()
    const r = recall(sent, '', true, null, 'up')!
    expect(recall(sent, `${r.value}（改过）`, false, r.at, 'up')).toBeNull()
    expect(recall(sent, '', true, null, 'down')).toBeNull()
  })
})

describe('drafts', () => {
  it('each conversation keeps its own unsent text across switching away and back', () => {
    const d = draftStore()
    const a = draftKey('acc', 'c1')
    const b = draftKey('acc', 'c2')
    d.set(a, '还没发出去的问题')
    expect(d.get(b)).toBe('')
    d.set(b, '另一个')
    expect(d.get(a)).toBe('还没发出去的问题')
    // A new conversation of another account is a different draft.
    expect(d.get(draftKey('acc2', null))).toBe('')
    d.set(a, '')
    expect(d.get(a)).toBe('')
  })

  it('a switch clears visible messages and ↑ history while the new history loads', () => {
    const old = draftKey('a', 'one')
    const next = draftKey('b', 'one')
    const shown = scopedContent(next, old, ['old message'], 'old draft')
    expect(shown).toEqual({ items: [], input: '' })
    expect(recall(shown.items, shown.input, true, null, 'up')).toBeNull()
  })

  it('a failed send restores empty draft but preserves newer typing', () => {
    expect(restoreFailedSend('', 'failed text')).toBe('failed text')
    expect(restoreFailedSend('newer typing', 'failed text')).toBe('newer typing\n\nfailed text')
    expect(restoreFailedSend(restoreFailedSend('draft', 'first'), 'second')).toBe('draft\n\nfirst\n\nsecond')
    expect(restoreFailedSend('  draft ', ' next  ')).toBe('  draft \n\n next  ')
  })
  it('caps a restored draft within the send limit with a visible truncation notice', () => {
    const restored = restoreFailedSend('x'.repeat(7_990), 'queued message')
    expect(restored.length).toBeLessThanOrEqual(8_000)
    expect(restored).toContain('已截断')
  })

  it('scope changes reset recall without changing the textarea or its focus', () => {
    const browsing = { index: 1, stash: '' }
    expect(recallForScope('account/new', 'account/new', browsing)).toEqual(browsing)
    expect(recallForScope('account/new', 'account/', browsing)).toBeNull()
  })
})

describe('Composer', () => {
  it('recognizes @ only at the caret and removes only the chosen token', () => {
    expect(resourceToken('why @web now', 8)).toEqual({ query: 'web', start: 4, end: 8 })
    expect(resourceToken('a@web', 5)).toBeNull()
    expect(resourceToken('@', 1)).toEqual({ query: '', start: 0, end: 1 })
    expect(resourceToken('why @web now', 7)).toEqual({ query: 'we', start: 4, end: 8 })
    expect(insertResource('why @web now', { start: 4, end: 8 })).toBe('why  now')
  })
  it('links resource suggestions to textarea and renders removable trusted chips', () => {
    const html = render({ value: '@web', resources: [{ type: 'ec2', id: 'i-1', region: 'us-east-1', label: 'web-1' }], candidates: [{ type: 'ec2', id: 'i-2', region: 'us-east-1', label: 'web-2' }], onRemoveResource: () => {}, onSelectResource: () => {}, onResourceQuery: () => {} })
    expect(html).toContain('role="listbox"')
    expect(html).toContain('aria-label="资源上下文候选"')
    expect(html).toMatch(/<textarea[^>]*aria-controls="[^"]+-resources"/)
    expect(html).toContain('移除资源 web-1')
    expect(html).toContain('web-2')
  })
  it('one line to start, the page chip inside the box, a send button that is off while empty', () => {
    const html = render()
    expect(html).toMatch(/<textarea[^>]*rows="1"/)
    expect(html).toContain('aria-label="给 AI 助手的消息"')
    expect(html.indexOf('ai-page-chip')).toBeLessThan(html.indexOf('<textarea'))
    expect(html.indexOf('ai-page-chip')).toBeGreaterThan(html.indexOf('class="ai-composer"'))
    expect(html).toMatch(/<button type="button" class="ai-send" aria-label="发送"[^>]*disabled=""/)
    expect(render({ value: '列出实例' })).not.toMatch(/class="ai-send"[^>]*disabled/)
  })

  it('send and stop are one button: ■ while a run is going', () => {
    const html = render({ busy: true, value: 'x' })
    expect(html).toContain('class="ai-send stop" aria-label="停止生成"')
    expect(html).not.toContain('aria-label="发送"')
  })
  it('labels stopping a paused answer without implying an approval decision', () => {
    const html = render({ busy: true, pausedOnApproval: true })
    expect(html).toContain('aria-label="停止回答（不会批准或拒绝审批）"')
    expect(html).toContain('class="ai-send stop paused"')
    expect(html).toContain('>停止回答</span>')
  })

  it('「服务商 · 模型」 opens the current provider’s models; the switch is said to be global', () => {
    expect(modelLabel(config, MODELS)).toBe('Bedrock · Claude Sonnet 5.5')
    expect(modelLabel({ ...config, provider: 'openai', model: 'gpt-x' }, [])).toBe('OpenAI · gpt-x')
    const html = render({ month })
    expect(html).toMatch(/class="ai-model-chip" popoverTarget="[^"]+-model"/)
    expect(html).toContain('对所有账号和对话生效')
    expect(html).toMatch(/class="ai-pop-i sel" aria-pressed="true"[^]*Claude Sonnet 5.5[^]*目录价 \$3 \/ \$15 每百万 token/)
    expect(html).toContain('Claude Haiku 5.5')
    expect(html).toContain('本月 1.2M tokens · $4.10')
    expect(html).toContain('>AI 设置…</button>')
  })

  it('nothing to switch to (custom endpoint, one model): the chip opens AI settings instead', () => {
    const html = render({ config: { ...config, provider: 'custom-openai', model: 'local' }, models: [] })
    expect(html).toContain('自定义端点 · local')
    expect(html).not.toContain('popoverTarget')
    expect(html).toContain('点击打开 AI 设置')
  })

  it('usage moved into the cost chip’s popover: this conversation and the month; nothing before any usage', () => {
    expect(render()).not.toContain('ai-cost-chip')
    const html = render({ usage, month })
    expect(html).toMatch(/class="ai-cost-chip always-visible" popoverTarget="[^"]+-cost"[^>]*>\$0.03</)
    expect(html).toContain('本对话 输入 2.0k / 输出 1.1k tokens · $0.03')
    expect(html).toContain('按模型目录价估算，仅供参考')
    // A new conversation: the chip still leads to the month.
    expect(render({ month })).toMatch(/class="ai-cost-chip always-visible"[^>]*>\$0</)
  })

  it('single-model and custom endpoints keep a narrow usage entry point', () => {
    for (const patch of [
      { config: { ...config, provider: 'custom-openai', model: 'local' }, models: [] },
      { models: MODELS.slice(0, 1) }
    ]) {
      const html = render({ ...patch, usage })
      expect(html).toMatch(/class="ai-cost-chip always-visible"[^>]*aria-label="查看用量"/)
      expect(html).toContain('本对话 输入 2.0k')
    }
  })

  it('the model popover shows both conversation and month usage', () => {
    const html = render({ usage, month })
    const footer = html.slice(html.indexOf('class="ai-pop-ft"'), html.indexOf('</div>', html.indexOf('class="ai-pop-ft"')))
    expect(footer).toContain('本对话 输入 2.0k')
    expect(footer).toContain('本月 1.2M tokens')
    expect(html).toMatch(/class="ai-cost-chip always-visible"/)
  })
})

it('shows each rejected filename and collapses excess with dismiss controls and a privacy note above the editor', () => {
  const attachments = [{ localId: 'ok', id: 'ok', kind: 'file' as const, name: 'ok.txt', size: 1, state: 'ready' as const, createdAt: 1 }, ...['a.pdf', 'b.zip', 'c.exe', 'd.doc'].map((name, i) => ({ localId: String(i), id: '', kind: 'file' as const, name, size: 1, state: 'error' as const, reason: '不支持此文件类型', createdAt: 1 }))]
  const html = render({ attachments })
  expect(html).toContain('a.pdf：不支持此文件类型')
  expect(html).toContain('b.zip：不支持此文件类型')
  expect(html).toContain('c.exe：不支持此文件类型')
  expect(html).toContain('另有 1 个被拒绝')
  expect(html).not.toContain('d.doc：不支持此文件类型')
  expect(html.indexOf('图片里的敏感信息不会被自动隐藏')).toBeLessThan(html.indexOf('<textarea'))
  expect(html.indexOf('ai-attachment-errors')).toBeLessThan(html.indexOf('ai-attachment-chips'))
  expect(html).not.toContain('ai-attachment-chip error')
})

it('keeps file metadata and privacy badges inline in a compact chip', () => {
  const html = render({ attachments: [{ localId: '1', id: '1', kind: 'file', name: 'report.txt', size: 2048, state: 'ready', createdAt: 1, redactions: 2, truncated: true }] })
  expect(html).toMatch(/ai-attachment-chip file[^]*ai-attachment-name[^]*report\.txt[^]*ai-attachment-size[^]*2 KB[^]*已截断[^]*title="已隐藏 2 处密钥"[^]*aria-label="已隐藏 2 处密钥"[^]*已隐藏 2 处/)
})
