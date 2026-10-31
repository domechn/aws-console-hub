import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PageContext, PageResource } from '../../../../shared/ai'
import type { AwsAccount } from '../../../../shared/types'
import { EmptyState, pageSuggestions } from './EmptyState'

const at = (resource?: PageResource, route?: PageResource, label = 'x'): PageContext => ({ url: 'https://console.aws.amazon.com/x', title: '', region: 'ap-northeast-1', label, resource, route })
const res = (service: string, resourceType: string, name: string, serviceLabel = service.toUpperCase()): PageResource => ({ service, serviceLabel, resourceType, name })

describe('pageSuggestions', () => {
  it('three questions per known resource type, naming the resource', () => {
    for (const [service, type, name] of [
      ['ec2', 'Instance', 'i-0abc'],
      ['s3', 'Bucket', 'logs-bucket'],
      ['lambda', 'Function', 'order-worker'],
      ['rds', 'Database', 'db-primary'],
      ['sqs', 'Queue', 'orders-queue']
    ]) {
      const s = pageSuggestions(at(res(service, type, name)))
      expect(s).toHaveLength(3)
      expect(new Set(s).size).toBe(3)
      for (const q of s) expect(q).toContain(name)
    }
    expect(pageSuggestions(at(res('ec2', 'Instance', 'web-1')))[1]).toBe('web-1 的安全组开放了哪些端口？')
    // Types differ per service: an EC2 security group is not an instance.
    expect(pageSuggestions(at(res('ec2', 'Security group', 'sg-1')))).not.toEqual(pageSuggestions(at(res('ec2', 'Instance', 'sg-1'))))
  })

  it('a generic three for any other resource, or for a service page without one', () => {
    const other = pageSuggestions(at(res('sns', 'Topic', 'alerts', 'SNS')))
    expect(other).toEqual(['介绍一下 SNS alerts 的配置', 'alerts 最近有报错或告警吗？', 'alerts 有哪些标签？'])
    const list = pageSuggestions(at(undefined, res('ec2', '页面', 'Instances', 'EC2')))
    expect(list).toHaveLength(3)
    expect(list[0]).toBe('列出当前 region 的 EC2 资源')
  })

  it('none off the console, before main answered, or on the console home', () => {
    expect(pageSuggestions(null)).toEqual([])
    expect(pageSuggestions(undefined)).toEqual([])
    expect(pageSuggestions(at(undefined, undefined, 'Console 首页'))).toEqual([])
  })
})

const account = { id: 'a1', name: '演示-测试', accountId: '111111111111', color: '#2e7d32', aiAllowWrite: false } as AwsAccount
const render = (page: PageContext | null, patch: Partial<AwsAccount> = {}): string =>
  renderToStaticMarkup(
    <EmptyState account={{ ...account, ...patch }} page={page} recent={[{ id: 'c1', title: '东京区 EC2 巡检', updatedAt: Date.now() }]} onPick={() => {}} onOpen={() => {}} onAllowWrite={() => {}} />
  )

describe('EmptyState', () => {
  it('the account, the page group (only on a console page), common questions with the cost one tagged, recent conversations', () => {
    const html = render(at(res('ec2', 'Instance', 'web-1'), undefined, 'EC2 实例 web-1'))
    expect(html).toContain('演示-测试')
    expect(html).toContain('111111111111 · 只在这个账号里查询')
    expect(html).toContain('基于当前页面 · EC2 实例 web-1')
    expect(html).toContain('web-1 过去 24 小时的 CPU 和网络怎么样？')
    expect(html).toMatch(/本月成本前五的服务是哪些？<\/span><span class="ai-sugg-tag">每次约 \$0.01/)
    expect(html).toContain('东京区 EC2 巡检')
    expect(render(null)).not.toContain('基于当前页面')
  })

  it('read-only says so and offers the switch (through the warning); write mode says every change is confirmed', () => {
    expect(render(null)).toContain('允许提出变更…')
    const write = render(null, { aiAllowWrite: true })
    expect(write).toContain('每一项都要你在卡片上确认后才会执行')
    expect(write).not.toContain('允许提出变更…')
  })

  it('suggestions are plain buttons that hand the text over (the panel fills the input, never sends)', () => {
    const picked: string[] = []
    const tree = EmptyState({ account, page: null, recent: [], onPick: (t) => picked.push(t), onOpen: () => {}, onAllowWrite: () => {} })
    const groups = tree.props.children as React.ReactElement<{ children: unknown }>[]
    const common = groups.find((g) => (g as { props: { 'aria-label'?: string } })?.props?.['aria-label'] === '常用问题')!
    const buttons = (common.props.children as unknown[])[1] as React.ReactElement<{ onClick: () => void }>[]
    buttons[2].props.onClick()
    expect(picked).toEqual(['本月成本前五的服务是哪些？'])
  })
})
