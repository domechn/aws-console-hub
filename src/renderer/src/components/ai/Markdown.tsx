import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isConsoleUrl } from '../../../../shared/consoleUrl'

/** Only web links are clickable (console pages only, in cards), and main still decides where they open (ai:open-link). */
export function safeHref(href: string | undefined, consoleOnly = false): string | null {
  if (!href) return null
  try {
    if (consoleOnly) return isConsoleUrl(href) ? href : null
    return ['https:', 'http:'].includes(new URL(href).protocol) ? href : null
  } catch {
    return null
  }
}

interface Props {
  text: string
  onLink: (url: string) => void
  /** Card markdown (§10.4): links other than console pages show as plain text. */
  consoleOnly?: boolean
}

/**
 * Model output is untrusted. Raw HTML is dropped (skipHtml, no rehype-raw), images are not rendered (a remote
 * image would be a beacon, and CSP blocks it anyway), and links go through main instead of navigating.
 */
export function Markdown({ text, onLink, consoleOnly }: Props): React.JSX.Element {
  const components: Components = {
    img: () => null,
    table: ({ children }) => <div className="md-table"><table>{children}</table></div>,
    a: ({ href, children }) => {
      const url = safeHref(href, consoleOnly)
      if (!url) return <span>{children}</span>
      return (
        <a
          href={url}
          title={url}
          onClick={(e) => {
            e.preventDefault()
            onLink(url)
          }}
        >
          {children}
        </a>
      )
    }
  }
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
