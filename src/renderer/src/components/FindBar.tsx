import { useEffect, useRef, useState } from 'react'
import type { FindResult } from '../../../shared/types'
import { IconChevronDown, IconChevronUp, IconClose } from './icons'

interface Props {
  query: string
  onQueryChange: (query: string) => void
  /** Bumped on every ⌘F so a repeat press refocuses and selects the query. */
  focusToken: number
  onClose: () => void
}

/**
 * ⌘F find bar for the console view. It sits above the view in normal flow
 * rather than floating over it — the view is a native layer painted on top of
 * the DOM, so anything overlapping it would be invisible.
 */
export function FindBar({ query, onQueryChange, focusToken, onClose }: Props): React.JSX.Element {
  const [result, setResult] = useState<FindResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => window.api.onFindResult(setResult), [])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

  // Search as you type; each edit restarts the session at the top of the page.
  useEffect(() => {
    if (!query) setResult(null)
    window.api.find(query, { forward: true, findNext: true })
  }, [query])

  // Leaving the bar should not leave highlights behind.
  useEffect(() => () => window.api.stopFind(), [])

  const step = (forward: boolean): void => {
    if (query) window.api.find(query, { forward, findNext: false })
  }

  const matches = result?.matches ?? 0
  const empty = query !== '' && matches === 0

  return (
    <div className="findbar">
      <input
        ref={inputRef}
        value={query}
        placeholder="页内搜索"
        spellCheck={false}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(!e.shiftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />

      <span className={'find-count' + (empty ? ' empty' : '')}>
        {query === '' ? '' : empty ? '无结果' : `${result?.activeMatchOrdinal ?? 0}/${matches}`}
      </span>

      <button className="find-btn" title="上一个（⇧↵）" disabled={matches === 0} onClick={() => step(false)}>
        <IconChevronUp />
      </button>
      <button className="find-btn" title="下一个（↵）" disabled={matches === 0} onClick={() => step(true)}>
        <IconChevronDown />
      </button>
      <button className="find-btn" title="关闭（esc）" onClick={onClose}>
        <IconClose />
      </button>
    </div>
  )
}
