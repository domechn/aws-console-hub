import { useEffect, useRef, useState } from 'react'
import type { AwsAccount, RecentResource } from '../../../shared/types'

interface Props {
  accounts: AwsAccount[]
  recents: RecentResource[]
  onOpen: (r: RecentResource) => void
  onHide: () => void
  /** Label of the hide shortcut, e.g. "⌘J". */
  shortcut: string
}

export function badgeColor(service: string): string {
  let h = 0
  for (const ch of service) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h} 42% 42%)`
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function Chip({
  r,
  account,
  onOpen
}: {
  r: RecentResource
  account: AwsAccount | undefined
  onOpen: (r: RecentResource) => void
}): React.JSX.Element {
  const label = r.displayName || r.name
  const title = [
    label,
    r.displayName && r.name,
    `${account?.name ?? '未知账号'} · ${r.region} · ${r.resourceType}`,
    relativeTime(r.lastVisited)
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <div className={'chip' + (r.pinned ? ' pinned' : '')} onClick={() => onOpen(r)} title={title}>
      <span className="mini-badge" style={{ background: badgeColor(r.serviceLabel) }}>
        {r.serviceLabel.slice(0, 2).toUpperCase()}
      </span>
      {r.pinned && <span className="chip-star">★</span>}
      <span className="chip-label">{label}</span>
      <span className="dot small" style={{ background: account?.color ?? 'var(--border-strong)' }} />
      {/* Overlays the chip's end on hover, so the row never grows. */}
      <div className="chip-actions">
        <button
          className={'icon-btn pin' + (r.pinned ? ' pinned' : '')}
          title={r.pinned ? '取消固定' : '固定'}
          onClick={(e) => {
            e.stopPropagation()
            void window.api.setPinned(r.key, !r.pinned)
          }}
        >
          {r.pinned ? '★' : '☆'}
        </button>
        <button
          className="icon-btn"
          title="移除"
          onClick={(e) => {
            e.stopPropagation()
            void window.api.deleteRecent(r.key)
          }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

/**
 * One-row strip under the console: pinned chips, then recents (newest first,
 * as main sends them). It scrolls sideways so it never costs more than its row.
 */
export function ResourceStrip({ accounts, recents, onOpen, onHide, shortcut }: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const pinned = recents.filter((r) => r.pinned)
  // Not truncated: the main process already caps what it keeps.
  const recent = recents.filter((r) => !r.pinned)
  const chip = (r: RecentResource): React.JSX.Element => (
    <Chip key={r.key} r={r} account={accounts.find((a) => a.id === r.accountId)} onOpen={onOpen} />
  )

  // Which ends have hidden chips: drives the fade masks and the arrows.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = (): void => {
      const left = el.scrollLeft > 0
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    el.addEventListener('scroll', update)
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [recents])

  const page = (dir: number): void => {
    const el = scrollRef.current
    el?.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' })
  }
  const overflowing = edges.left || edges.right

  return (
    <div className="resource-strip">
      <button className="strip-btn" title={`隐藏最近访问（${shortcut}）`} onClick={onHide}>
        ▾
      </button>
      {recents.length > 0 && (
        <>
          {overflowing && (
            <button className="strip-btn" title="向左" disabled={!edges.left} onClick={() => page(-1)}>
              ‹
            </button>
          )}
          <div
            ref={scrollRef}
            className={'strip-scroll' + (edges.left ? ' fade-left' : '') + (edges.right ? ' fade-right' : '')}
            // A plain mouse wheel only scrolls vertically; turn it sideways.
            onWheel={(e) => {
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
            }}
          >
            {pinned.map(chip)}
            {pinned.length > 0 && recent.length > 0 && <span className="strip-sep" />}
            {recent.map(chip)}
          </div>
          {overflowing && (
            <button className="strip-btn" title="向右" disabled={!edges.right} onClick={() => page(1)}>
              ›
            </button>
          )}
        </>
      )}
    </div>
  )
}
