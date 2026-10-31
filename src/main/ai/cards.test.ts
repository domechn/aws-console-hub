import { describe, expect, it } from 'vitest'
import { fieldError, patternError } from '../../shared/cardRules'
import { CARD_LIMITS, type Card } from '../../shared/cards'
import { buildModelCard, cardActionLabel, cardActionText, cardState, checkCardAction, modelCardProblems, parseCardAction } from './cards'

const CONSOLE = 'https://ap-northeast-1.console.aws.amazon.com/ec2/home?region=ap-northeast-1#InstanceDetails:instanceId={row}'
const none = (): boolean => false

/** §10.5 ①: a resource table with row actions. */
const TABLE_CARD = {
  title: 'ap-northeast-1 · 运行中的 EC2（2）',
  blocks: [
    {
      type: 'table',
      columns: [
        { key: 'name', label: '名称' },
        { key: 'id', label: '实例 ID' }
      ],
      rows: [
        { id: 'i-0abc', cells: { name: 'web-1', id: 'i-0abc' }, actions: ['open', 'detail'] },
        { id: 'i-0def', cells: { name: 'web-2', id: 'i-0def' }, actions: ['open'] }
      ]
    }
  ],
  actions: [
    { id: 'open', label: '在 Console 打开', kind: 'open-console', url: CONSOLE },
    { id: 'detail', label: '详情', kind: 'reply' },
    { id: 'more', label: '再查 10 台', kind: 'reply', style: 'primary' }
  ]
}

/** §10.5 ②: a form. */
const FORM_CARD = {
  blocks: [
    {
      type: 'form',
      submitActionId: 'go',
      fields: [
        { type: 'text', name: 'name', label: '名称', pattern: '[a-z][a-z0-9-]{0,30}', required: true },
        { type: 'select', name: 'type', label: '实例类型', options: [{ value: 't3.micro', label: 't3.micro' }, { value: 't3.large', label: 't3.large' }] },
        { type: 'number', name: 'count', label: '数量', min: 1, max: 3 },
        { type: 'checkbox', name: 'publicIp', label: '公网 IP' }
      ]
    }
  ],
  actions: [{ id: 'go', label: '提交', kind: 'reply' }]
}

/** §10.5 ④: cost summary. */
const COST_CARD = {
  title: '本月成本',
  blocks: [
    { type: 'kv', items: [{ label: '本月至今', value: '$1,234.00', copy: true }, { label: '环比', value: '+12%' }] },
    { type: 'badges', items: [{ text: '预估', tone: 'warn' }] },
    { type: 'markdown', text: '数据来源 **ce:GetCostAndUsage**' },
    { type: 'console-link', label: '账单', url: 'https://us-east-1.console.aws.amazon.com/billing/home' }
  ]
}

const build = (input: unknown, known: (id: string) => boolean = none): Card => buildModelCard(input, { id: 'c-0123456789ab', now: 1000, known })
const problems = (input: unknown): string => modelCardProblems(input, none).join('\n')
const withAction = (patch: Record<string, unknown>) => ({ ...TABLE_CARD, actions: TABLE_CARD.actions.map((a) => (a.id === 'open' ? { ...a, ...patch } : a)) })

describe('render_card input', () => {
  it.each([
    ['resource table', TABLE_CARD],
    ['form', FORM_CARD],
    ['cost summary', COST_CARD]
  ])('accepts a %s', (_name, input) => {
    expect(modelCardProblems(input, none)).toEqual([])
  })

  it('builds the card with main’s id, origin=model, 30-minute expiry, and ignores model-supplied id/origin/state', () => {
    const card = build({ ...COST_CARD, id: 'model-id', origin: 'system', state: 'resolved', v: 9 })
    expect(card).toMatchObject({ v: 1, id: 'c-0123456789ab', origin: 'model', state: 'active', createdAt: 1000, expiresAt: 1000 + CARD_LIMITS.ttlMs })
    expect(JSON.stringify(card)).not.toContain('model-id')
    // A lock or bidi override in the title would pass for main's own card.
    expect(build({ ...COST_CARD, title: '🔒 已执行‮ 提案' }).title).toBe('已执行 提案')
  })

  it.each(['diff', 'consequences', 'risk', 'progress', 'error', 'request'])('rejects the system-only %s block from the model', (type) => {
    const block = {
      diff: { type, lines: [{ path: 'State', op: 'change', before: 'running', after: 'stopped' }] },
      consequences: { type, items: [{ kind: 'downtime', text: '停机' }] },
      risk: { type, level: 'low', reasons: [] },
      progress: { type, label: '执行中' },
      error: { type, message: 'x' },
      request: { type, action: 'iam:AttachRolePolicy', region: 'us-east-1', params: '{}' }
    }[type]
    expect(problems({ blocks: [{ type: 'markdown', text: 'ok' }, block] })).toContain(`/blocks/1: "${type}" 块只能由应用生成`)
    expect(() => build({ blocks: [block] })).toThrow(/卡片无效，请修正后重新调用 render_card/)
  })

  it.each<[string, unknown, RegExp]>([
    ['no blocks', { blocks: [] }, /blocks/],
    ['unknown block type', { blocks: [{ type: 'html', html: '<b>x</b>' }] }, /未知的块类型 "html"/],
    ['too many blocks', { blocks: Array.from({ length: 21 }, () => ({ type: 'markdown', text: 'x' })) }, /blocks/],
    ['markdown over 4000', { blocks: [{ type: 'markdown', text: 'x'.repeat(4001) }] }, /\/blocks\/0\/text/],
    ['table over 100 rows', { blocks: [{ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: Array.from({ length: 101 }, (_, i) => ({ id: `r${i}`, cells: { a: 'x' } })) }] }, /rows/],
    ['kv over 30 items', { blocks: [{ type: 'kv', items: Array.from({ length: 31 }, () => ({ label: 'a', value: 'b' })) }] }, /items/],
    ['over 6 actions', { blocks: [{ type: 'markdown', text: 'x' }], actions: Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, label: 'x', kind: 'reply' })) }, /actions/],
    ['cell too long', { blocks: [{ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ id: 'r', cells: { a: 'x'.repeat(501) } }] }] }, /cells/],
    ['whole card too big', { blocks: Array.from({ length: 20 }, () => ({ type: 'markdown', text: 'x'.repeat(3999) })) }, /卡片太大/],
    ['bad action id', { blocks: [{ type: 'markdown', text: 'x' }], actions: [{ id: 'a b', label: 'x', kind: 'reply' }] }, /actions/],
    ['unknown action kind', { blocks: [{ type: 'markdown', text: 'x' }], actions: [{ id: 'x', label: 'x', kind: 'execute' }] }, /kind/],
    ['console-link to another site', { blocks: [{ type: 'console-link', label: 'x', url: 'https://evil.example/console.aws.amazon.com' }] }, /只能链接到 AWS console/],
    ['javascript: console-link', { blocks: [{ type: 'console-link', label: 'x', url: 'javascript:alert(1)//console.aws.amazon.com' }] }, /只能链接到 AWS console/],
    ['http console-link', { blocks: [{ type: 'console-link', label: 'x', url: 'http://console.aws.amazon.com/' }] }, /只能链接到 AWS console/],
    ['open-console to another site', withAction({ url: 'https://evil.example/?{row}' }), /open-console 需要 AWS console/],
    ['open-console javascript:', withAction({ url: 'javascript:alert({row})' }), /open-console 需要 AWS console/],
    ['open-console without url', withAction({ url: undefined }), /open-console 需要/],
    ['copy without text', { blocks: [{ type: 'markdown', text: 'x' }], actions: [{ id: 'c', label: '复制', kind: 'copy' }] }, /copy 按钮需要 text/],
    ['row action that does not exist', { ...TABLE_CARD, actions: TABLE_CARD.actions.filter((a) => a.id !== 'detail') }, /引用了不存在的 action "detail"/],
    ['duplicate action ids', { ...TABLE_CARD, actions: [...TABLE_CARD.actions, { id: 'more', label: 'x', kind: 'reply' }] }, /id "more" 重复/],
    ['duplicate row ids', { blocks: [{ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ id: 'r', cells: {} }, { id: 'r', cells: {} }] }] }, /行 id "r" 重复/],
    ['duplicate column keys', { blocks: [{ type: 'table', columns: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }], rows: [] }] }, /key "a" 重复/],
    ['{row} in a footer action', { blocks: [{ type: 'markdown', text: 'x' }], actions: [{ id: 'o', label: 'x', kind: 'open-console', url: CONSOLE }] }, /含 \{row\} 的按钮只能用作表格行按钮/],
    ['form submit that does not exist', { ...FORM_CARD, actions: [] }, /submitActionId: 引用了不存在的 action "go"/],
    ['form submit that is not a reply', { ...FORM_CARD, actions: [{ id: 'go', label: 'x', kind: 'copy', text: 'x' }] }, /必须是 kind=reply/],
    ['duplicate form field names', { ...FORM_CARD, blocks: [{ ...FORM_CARD.blocks[0], fields: [FORM_CARD.blocks[0].fields[0], FORM_CARD.blocks[0].fields[0]] }] }, /name "name" 重复/],
    ['nested-quantifier pattern', { ...FORM_CARD, blocks: [{ type: 'form', submitActionId: 'go', fields: [{ type: 'text', name: 'n', label: 'n', pattern: '(a+)+$' }] }] }, /嵌套量词/],
    ['min above max', { ...FORM_CARD, blocks: [{ type: 'form', submitActionId: 'go', fields: [{ type: 'number', name: 'n', label: 'n', min: 5, max: 1 }] }] }, /min 大于 max/],
    ['supersedes an unknown card', { ...COST_CARD, supersedes: 'c-ffffffffffff' }, /没有卡片 "c-ffffffffffff"/]
  ])('rejects %s', (_name, input, error) => {
    expect(problems(input)).toMatch(error)
  })

  it('lists every rule problem at once, so the model can fix them in one go', () => {
    const bad = { ...TABLE_CARD, actions: [{ id: 'open', label: 'x', kind: 'open-console', url: 'https://evil.example/' }] }
    const lines = modelCardProblems(bad, none)
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining('"detail"'), expect.stringContaining('open-console 需要')]))
  })

  it('accepts supersedes of a known card', () => {
    expect(build({ ...COST_CARD, supersedes: 'c-aaaaaaaaaaaa' }, (id) => id === 'c-aaaaaaaaaaaa').supersedes).toBe('c-aaaaaaaaaaaa')
  })
})

describe('pattern guard (ReDoS)', () => {
  it.each(['^[a-z0-9-]{1,63}$', '[a-z][a-z0-9-]*', '\\d{1,5}', 'i-[0-9a-f]{8,17}', '(?:prod|dev)-\\d+', '(?<env>prod)-web', '[(+*)]+', 'a\\(b+\\)+'])('accepts %s', (p) => {
    expect(patternError(p)).toBeNull()
  })

  it.each([
    ['(a+)+$', /嵌套量词/],
    ['(a*)*', /嵌套量词/],
    ['(a|aa)+', /嵌套量词/],
    ['((ab)+c)*', /嵌套量词/],
    ['(?:\\w+\\s?)+$', /嵌套量词/],
    ['(x+x+)+y', /嵌套量词/],
    ['(a{1,3}){2,}', /嵌套量词/],
    ['(a)\\1', /反向引用/],
    ['(?<n>a)\\k<n>', /反向引用/],
    ['a'.repeat(101), /不能超过 100/],
    ['(abc', /括号不匹配/],
    ['abc)', /括号不匹配/],
    ['[z-a]', /写法无效/]
  ])('refuses %s', (p, error) => {
    expect(patternError(p)).toMatch(error)
  })

  it('a refused pattern never runs: fieldError treats it as a mismatch', () => {
    expect(fieldError({ type: 'text', name: 'n', label: 'n', pattern: '(a+)+$' }, 'a'.repeat(40) + '!')).toBe('格式不符合要求')
  })
})

describe('card state', () => {
  const card = build(TABLE_CARD)
  it('resolved beats superseded beats expired', () => {
    expect(cardState(card, 1000, false, false)).toBe('active')
    expect(cardState(card, card.expiresAt + 1, false, false)).toBe('expired')
    expect(cardState(card, card.expiresAt + 1, false, true)).toBe('superseded')
    expect(cardState(card, card.expiresAt + 1, true, true)).toBe('resolved')
  })
})

describe('checkCardAction (a click from the renderer)', () => {
  const table = build(TABLE_CARD)
  const form = build(FORM_CARD)

  it('a row reply needs a row that has the action', () => {
    expect(checkCardAction(table, 'detail', 'i-0abc', undefined)).toMatchObject({ action: { id: 'detail' } })
    expect(() => checkCardAction(table, 'detail', 'i-0def', undefined)).toThrow('这一行没有这个按钮')
    expect(() => checkCardAction(table, 'detail', 'i-nope', undefined)).toThrow('这一行没有这个按钮')
    expect(() => checkCardAction(table, 'detail', undefined, undefined)).toThrow('这个按钮属于表格的某一行')
  })

  it('a footer reply needs no row; unknown and copy actions are refused', () => {
    expect(checkCardAction(table, 'more', undefined, undefined).action.id).toBe('more')
    expect(() => checkCardAction(table, 'more', 'i-0abc', undefined)).toThrow('这一行没有这个按钮')
    expect(() => checkCardAction(table, 'nope', undefined, undefined)).toThrow('卡片上没有这个按钮')
    expect(() => checkCardAction(table, 'more', undefined, { x: 1 })).toThrow('这个按钮不带表单值')
  })

  it('open-console fills {row} (encoded) and re-checks the URL', () => {
    expect(checkCardAction(table, 'open', 'i-0abc', undefined).url).toBe(CONSOLE.replace('{row}', 'i-0abc'))
    // A row id cannot steer the URL off the console: it is encoded, and the result checked again.
    const sneaky = { ...table, blocks: [{ ...table.blocks[0], rows: [{ id: 'x#@evil.example/', cells: {}, actions: ['open'] }] }] } as Card
    expect(checkCardAction(sneaky, 'open', 'x#@evil.example/', undefined).url).toContain('x%23%40evil.example%2F')
    const hostTemplate = { ...sneaky, actions: [{ id: 'open', label: 'x', kind: 'open-console', url: 'https://{row}.console.aws.amazon.com/' }] } as Card
    expect(() => checkCardAction(hostTemplate, 'open', 'x#@evil.example/', undefined)).toThrow('链接不是 AWS console 页面')
  })

  it.each<[string, Card['state']]>([
    ['这张卡片已经处理过了', 'resolved'],
    ['卡片已过期', 'expired'],
    ['已被新卡片替代', 'superseded']
  ])('refuses a %s card', (error, state) => {
    expect(() => checkCardAction({ ...table, state }, 'more', undefined, undefined)).toThrow(error)
  })

  it('form values must fit the fields: types, pattern, options, required, no extras', () => {
    const ok = { name: 'web-1', type: 't3.large', count: 2, publicIp: true }
    expect(checkCardAction(form, 'go', undefined, ok)).toMatchObject({ values: ok })
    // Left-out optional fields are dropped; an unchecked box is false.
    expect(checkCardAction(form, 'go', undefined, { name: 'web-1', type: 't3.micro' })).toMatchObject({ values: { name: 'web-1', type: 't3.micro', publicIp: false } })
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ type: 't3.micro' }, /名称：必填/],
      [{ ...ok, name: 'Web_1' }, /名称：格式不符合要求/],
      [{ ...ok, name: 'x'.repeat(1001) }, /名称/],
      [{ ...ok, type: 'm7i.48xlarge' }, /实例类型：请选择一个选项/],
      [{ ...ok, count: 9 }, /数量：不能大于 3/],
      [{ ...ok, count: '2' }, /数量：需要数字/],
      [{ ...ok, publicIp: 'yes' }, /公网 IP：无效的勾选值/],
      [{ ...ok, extra: 'x' }, /表单里没有字段 extra/]
    ]
    for (const [values, error] of bad) expect(() => checkCardAction(form, 'go', undefined, values as never)).toThrow(error)
  })
})

describe('[card_action] message', () => {
  it('round-trips and labels the click for the panel', () => {
    const m = { cardId: 'c-0123456789ab', action: 'detail', label: '详情', row: 'i-0abc', values: { n: 1 } }
    const text = cardActionText(m)
    expect(text).toBe('[card_action] {"cardId":"c-0123456789ab","action":"detail","label":"详情","row":"i-0abc","values":{"n":1}}')
    expect(parseCardAction(text)).toEqual(m)
    expect(parseCardAction('[card_action] not json')).toBeNull()
    expect(parseCardAction('hello')).toBeNull()
    expect(cardActionLabel(m)).toBe('「详情」 · i-0abc · n=1')
  })
})
