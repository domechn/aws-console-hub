import { useEffect, useRef, useState } from 'react'
import type { AccountKind, AwsAccount } from '../../../shared/types'
import { scoreQuery } from '../../../shared/fuzzy'

interface Props {
  accounts: AwsAccount[]
  activeId: string | null
  /** Modifier label for the ⌘1-9 hints, e.g. "⌘". */
  mod: string
  /** A login or page load is in flight for the account. */
  busy: (id: string) => boolean
  onClose: () => void
  onSwitch: (id: string) => void
  onEdit: (account: AwsAccount) => void
  onDelete: (account: AwsAccount) => void
  onAdd: (kind: AccountKind) => void
  onRelogin: (account: AwsAccount) => void
}

const GROUPS: { kind: AccountKind; label: string }[] = [
  { kind: 'assume', label: '账号' },
  { kind: 'base', label: '基础账号' }
]

/** Dropdown under the top bar's account button: search, switch, edit and add accounts. */
export function AccountSwitcher({
  accounts,
  activeId,
  mod,
  busy,
  onClose,
  onSwitch,
  onEdit,
  onDelete,
  onAdd,
  onRelogin
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const main = accounts.filter((a) => a.kind === 'assume')
  // Same fallback as ⌘1-9 in App: the base accounts when there are no jump accounts.
  const hotkeyList = main.length > 0 ? main : accounts.filter((a) => a.kind === 'base')
  const active = accounts.find((a) => a.id === activeId)
  const q = query.trim()
  const groups = GROUPS.map((g) => ({
    ...g,
    items: accounts
      .filter((a) => a.kind === g.kind)
      .map((a) => ({ a, score: q ? scoreQuery(q, [a.name, a.accountId, a.role]) : 0 }))
      .filter((x) => x.score >= 0)
      .sort((x, y) => y.score - x.score)
      .map((x) => x.a)
  }))
  const flat = groups.flatMap((g) => g.items)

  useEffect(() => setSelected(0), [query])

  useEffect(() => {
    listRef.current?.querySelector('.account-row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const account = flat[selected]
      if (account) onSwitch(account.id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const emptyHint = (kind: AccountKind): string => {
    if (q) return '没有匹配的账号'
    if (kind === 'base') return '还没有基础账号'
    return accounts.length === 0 ? '先添加基础账号' : '还没有要跳转的账号'
  }

  return (
    <div className="backdrop switcher-backdrop" onMouseDown={onClose}>
      <div className="switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder="搜索账号名 / account id / role"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="switcher-list" ref={listRef}>
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="switcher-group">
                {g.label} · {g.items.length}
              </div>
              {g.items.map((account) => {
                const i = flat.indexOf(account)
                const hotkey = hotkeyList.indexOf(account)
                return (
                  <div
                    key={account.id}
                    className={
                      'account-row' +
                      (account.id === activeId ? ' active' : '') +
                      (i === selected ? ' selected' : '')
                    }
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => onSwitch(account.id)}
                  >
                    <span className="dot" style={{ background: account.color }} />
                    <div className="account-meta">
                      <div className="account-name">
                        {account.name}
                        {busy(account.id) && <span className="spinner" />}
                      </div>
                      <div className="account-sub">
                        {account.accountId} · {account.role}
                      </div>
                    </div>
                    <div className="row-actions">
                      <button
                        className="icon-btn"
                        title="编辑"
                        onClick={(e) => {
                          e.stopPropagation()
                          onEdit(account)
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="icon-btn"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(account)
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    {hotkey >= 0 && hotkey < 9 && (
                      <span className="hotkey">
                        {mod}
                        {hotkey + 1}
                      </span>
                    )}
                  </div>
                )
              })}
              {g.items.length === 0 && <div className="empty-hint">{emptyHint(g.kind)}</div>}
            </div>
          ))}
        </div>
        <div className="switcher-footer">
          <button title="通过基础账号 assume" onClick={() => onAdd('assume')}>
            ＋ 添加账号
          </button>
          <button onClick={() => onAdd('base')}>＋ 添加基础账号</button>
          {active && (
            <button className="relogin" title={`重新登录 ${active.name}`} onClick={() => onRelogin(active)}>
              重新登录
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
