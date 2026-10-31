import { app } from 'electron'
import path from 'node:path'
import { readJson, writeJson } from './store'
import { parseConsolePage, parseConsoleUrl } from './parser'
import type { RecentResource } from '../shared/types'

/** Unpinned caps, kept apart so a burst of list pages can never push resources out. */
const MAX_RESOURCES = 500
const MAX_PAGES = 100

/** Batch writes during a burst of navigations; at most this long between a change and its save. */
const PERSIST_DELAY_MS = 300

export class RecentsStore {
  private file = path.join(app.getPath('userData'), 'recents.json')
  private items = new Map<string, RecentResource>()
  private persistTimer: NodeJS.Timeout | null = null

  constructor(private onChange: (items: RecentResource[]) => void) {
    for (const item of readJson<RecentResource[]>(this.file, [])) {
      this.items.set(item.key, item)
    }
  }

  list(): RecentResource[] {
    return [...this.items.values()].sort((a, b) => b.lastVisited - a.lastVisited)
  }

  /**
   * Upsert a console navigation: a recognised resource, or else the page
   * itself. Null only for non-console URLs and the console home.
   */
  record(accountId: string, url: string): RecentResource | null {
    const parsed = parseConsoleUrl(url) ?? parseConsolePage(url)
    if (!parsed) return null
    const key = [accountId, parsed.service, parsed.region, parsed.resourceType, parsed.name].join('|')
    const prev = this.items.get(key)
    const item: RecentResource = {
      key,
      accountId,
      ...parsed,
      displayName: prev?.displayName,
      lastVisited: Date.now(),
      pinned: prev?.pinned ?? false
    }
    this.items.set(key, item)
    this.trim()
    this.emit()
    return item
  }

  setDisplayName(key: string, displayName: string): void {
    const item = this.items.get(key)
    if (!item || item.displayName === displayName) return
    item.displayName = displayName
    this.emit()
  }

  setPinned(key: string, pinned: boolean): void {
    const item = this.items.get(key)
    if (!item) return
    item.pinned = pinned
    this.emit()
  }

  remove(key: string): void {
    this.items.delete(key)
    this.emit()
  }

  private trim(): void {
    const unpinned = this.list().filter((i) => !i.pinned)
    const drop = [
      ...unpinned.filter((i) => !i.isPage).slice(MAX_RESOURCES),
      ...unpinned.filter((i) => i.isPage).slice(MAX_PAGES)
    ]
    for (const item of drop) this.items.delete(item.key)
  }

  /** Write a pending debounced save now (on quit). */
  flush(): void {
    if (!this.persistTimer) return
    clearTimeout(this.persistTimer)
    this.persistTimer = null
    writeJson(this.file, this.list())
  }

  private emit(): void {
    this.onChange(this.list())
    // Not restarted per change: SPA consoles rewrite their URL constantly, and
    // a restarting debounce would keep postponing the save until quit — so a
    // crash or a killed dev process lost every visit since launch.
    this.persistTimer ??= setTimeout(() => this.flush(), PERSIST_DELAY_MS)
  }
}
