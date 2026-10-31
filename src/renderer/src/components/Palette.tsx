import { useEffect, useMemo, useRef, useState } from 'react'
import type { AwsAccount, RecentResource } from '../../../shared/types'
import { REGIONS, SERVICES } from '../../../shared/catalog'
import { scoreQuery } from '../../../shared/fuzzy'
import { badgeColor, relativeTime } from './ResourceList'

interface Props {
  accounts: AwsAccount[]
  activeAccount: AwsAccount | null
  recents: RecentResource[]
  onClose: () => void
  onSwitchAccount: (id: string) => void
  onOpenUrl: (accountId: string, url: string) => void
  onOpenRecent: (r: RecentResource) => void
}

interface Item {
  id: string
  badge: string
  badgeColor: string
  title: string
  subtitle: string
  score: number
  run: () => void
}

export function Palette({
  accounts,
  activeAccount,
  recents,
  onClose,
  onSwitchAccount,
  onOpenUrl,
  onOpenRecent
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const picked = useRef(false)
  const lastState = useRef({ query: '', results: 0 })

  useEffect(() => inputRef.current?.focus(), [])

  const items = useMemo<Item[]>(() => {
    const accountName = (id: string): string => accounts.find((a) => a.id === id)?.name ?? '未知账号'

    // Pull region / account override tokens out of the query, e.g. "prod lambda tokyo".
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    let regionOverride: string | null = null
    let accountOverride: AwsAccount | null = null
    const rest: string[] = []
    for (const token of tokens) {
      if (!regionOverride) {
        const region = REGIONS.find((r) => r.id === token || r.keywords.includes(token))
        if (region) {
          regionOverride = region.id
          continue
        }
      }
      if (!accountOverride) {
        const account = accounts.find((a) => a.name.toLowerCase() === token || a.accountId === token)
        if (account) {
          accountOverride = account
          continue
        }
      }
      rest.push(token)
    }
    const q = rest.join(' ')
    const target = accountOverride ?? activeAccount ?? accounts[0] ?? null
    const results: Item[] = []

    // Recent / pinned resources
    for (const r of recents) {
      const score = q
        ? scoreQuery(q, [
            r.displayName ?? '',
            r.name,
            r.serviceLabel,
            r.resourceType,
            accountName(r.accountId),
            r.region
          ])
        : r.pinned
          ? 40
          : 20
      if (score < 0) continue
      results.push({
        id: `recent:${r.key}`,
        badge: r.serviceLabel.slice(0, 2).toUpperCase(),
        badgeColor: badgeColor(r.serviceLabel),
        title: r.displayName || r.name,
        subtitle: `${r.pinned ? '★ ' : ''}${r.displayName ? `${r.name} · ` : ''}${accountName(r.accountId)} · ${r.region} · ${relativeTime(r.lastVisited)}`,
        score: score + (r.pinned ? 15 : 5),
        run: () => onOpenRecent(r)
      })
    }

    // Switch account
    for (const account of accounts) {
      const score = q ? scoreQuery(q, [account.name, account.accountId, account.role]) : 30
      if (score < 0) continue
      results.push({
        id: `account:${account.id}`,
        badge: '⇄',
        badgeColor: account.color,
        title: `切换到 ${account.name}`,
        subtitle: `${account.accountId} · ${account.role}`,
        score: score + 10,
        run: () => onSwitchAccount(account.id)
      })
    }

    // Open a service console page in the target account
    if (target) {
      const region = regionOverride ?? target.defaultRegion
      for (const service of SERVICES) {
        const score = q ? scoreQuery(q, [service.label, service.id, ...service.keywords]) : accountOverride || regionOverride ? 15 : -1
        if (score < 0) continue
        const effectiveRegion = service.global ? 'global' : region
        results.push({
          id: `service:${service.id}`,
          badge: service.label.slice(0, 2).toUpperCase(),
          badgeColor: badgeColor(service.label),
          title: service.label,
          subtitle: `打开 · ${target.name} · ${effectiveRegion}`,
          score,
          run: () => onOpenUrl(target.id, service.url(region))
        })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, 12)
  }, [query, accounts, activeAccount, recents, onOpenRecent, onOpenUrl, onSwitchAccount])

  useEffect(() => setSelected(0), [query])

  useEffect(() => {
    lastState.current = { query, results: items.length }
  }, [query, items.length])

  // A query typed and then abandoned is the clearest "missing quick action"
  // signal there is, so it gets logged too.
  useEffect(
    () => () => {
      if (picked.current || !lastState.current.query.trim()) return
      window.api.logAction({ type: 'palette-miss', ...lastState.current })
    },
    []
  )

  const run = (item: Item, index: number): void => {
    picked.current = true
    window.api.logAction({
      type: 'palette-pick',
      query,
      kind: item.id.split(':')[0],
      id: item.id,
      index,
      results: items.length
    })
    item.run()
  }

  useEffect(() => {
    listRef.current
      ?.querySelector('.palette-item.selected')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[selected]
      if (item) run(item, selected)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="backdrop palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="搜索服务 / 账号 / 资源，例如：prod lambda tokyo"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" ref={listRef}>
          {items.map((item, i) => (
            <div
              key={item.id}
              className={'palette-item' + (i === selected ? ' selected' : '')}
              onMouseEnter={() => setSelected(i)}
              onClick={() => run(item, i)}
            >
              <span className="badge" style={{ background: item.badgeColor }}>
                {item.badge}
              </span>
              <div className="palette-meta">
                <div className="palette-title">{item.title}</div>
                <div className="palette-sub">{item.subtitle}</div>
              </div>
              {i === selected && <span className="enter-hint">↵</span>}
            </div>
          ))}
          {items.length === 0 && <div className="empty-hint">没有匹配结果</div>}
        </div>
        <div className="palette-footer">
          <span>↑↓ 选择</span>
          <span>↵ 打开</span>
          <span>esc 关闭</span>
          <span className="tip">支持 region 词：tokyo / pdx / us-east-1 …</span>
        </div>
      </div>
    </div>
  )
}
