import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recents-test-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const { RecentsStore } = await import('./recents')

const lambda = (i: number): string =>
  `https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/fn-${i}`
const file = path.join(dir, 'recents.json')

describe('RecentsStore', () => {
  beforeEach(() => {
    fs.rmSync(file, { force: true })
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('records every resource of a long browsing session', () => {
    const store = new RecentsStore(() => {})
    for (let i = 0; i < 300; i++) store.record('a', lambda(i))
    expect(store.list().filter((r) => !r.isPage)).toHaveLength(300)
  })

  it('records unrecognised console pages, without letting them evict resources', () => {
    const store = new RecentsStore(() => {})
    store.record('a', lambda(1))
    const page = store.record('a', 'https://us-east-1.console.aws.amazon.com/glue/home?region=us-east-1#/v2/etl-configuration/jobs')
    expect(page).toMatchObject({ isPage: true, service: 'glue', name: 'v2/etl-configuration/jobs' })
    for (let i = 0; i < 500; i++) store.record('a', `https://us-east-1.console.aws.amazon.com/glue/home#/p${i}`)
    const items = store.list()
    expect(items.filter((r) => r.isPage)).toHaveLength(100)
    expect(items.find((r) => r.name === 'fn-1')).toBeDefined()
    expect(store.record('a', 'https://us-east-1.console.aws.amazon.com/console/home')).toBeNull()
  })

  it('saves during a continuous burst instead of postponing until quit', () => {
    const store = new RecentsStore(() => {})
    for (let i = 0; i < 20; i++) {
      store.record('a', lambda(i))
      vi.advanceTimersByTime(100)
    }
    // The first save fired 300ms into the burst, despite a change every 100ms.
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[]
    expect(saved.length).toBeGreaterThanOrEqual(3)
    store.flush()
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(20)
  })

  it('keeps pins and display names across revisits', () => {
    const store = new RecentsStore(() => {})
    const item = store.record('a', lambda(1))!
    store.setPinned(item.key, true)
    store.setDisplayName(item.key, 'Nice')
    expect(store.record('a', lambda(1))).toMatchObject({ pinned: true, displayName: 'Nice' })
  })
})
