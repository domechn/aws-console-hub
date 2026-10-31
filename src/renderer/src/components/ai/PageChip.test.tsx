import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PageContext } from '../../../../shared/ai'
import { PageChip } from './PageChip'

const S3: PageContext = {
  url: 'https://s3.console.aws.amazon.com/s3/buckets/b?region=us-east-1&tab=objects',
  title: 'b | S3',
  region: 'us-east-1',
  label: 'S3 · b · 对象',
  resource: { service: 's3', serviceLabel: 'S3', resourceType: 'Bucket', name: 'b', section: '对象' }
}
const render = (page: PageContext | null | undefined, on = true, readPage = true): string =>
  renderToStaticMarkup(<PageChip page={page} on={on} readPage={readPage} onToggle={() => {}} />)

describe('PageChip', () => {
  it('shows the recognised page, with a tooltip listing exactly what is sent', () => {
    const html = render(S3)
    expect(html).toContain('当前页面：S3 · b · 对象')
    expect(html).toContain(`地址（已去除令牌）${S3.url.replace(/&/g, '&amp;')}`)
    expect(html).toContain('不发送页面内容')
    expect(html).toContain('读取当前页面')
    expect(html).toContain('aria-label="本对话不发送当前页面"')
    expect(render(S3, true, false)).toContain('读取页面内容已在 AI 设置里关闭')
  })

  it('says when the page is not recognised, not the console, or turned off; nothing before main answered', () => {
    const home = render({ url: 'https://console.aws.amazon.com/console/home', title: 'Home', region: 'global', label: 'Console 首页' })
    expect(home).toContain('>当前页面：Console 首页<')
    expect(home).toContain('未识别出具体资源')
    expect(home).toContain('用工具查询')
    expect(render({ url: 'https://console.aws.amazon.com/x/home', title: '', region: 'global', label: 'AWS Console' })).toContain('>当前页面：AWS Console<')
    expect(render(null)).toContain('当前页面不是 AWS Console')
    expect(render(S3, false)).toContain('本对话不发送当前页面')
    expect(render(S3, false)).toContain('开启')
    expect(render(undefined)).toBe('')
  })
})
