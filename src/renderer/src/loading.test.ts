import { describe, expect, it } from 'vitest'
import type { NavState } from '../../shared/types'
import { loadingView } from './loading'

const nav = (over: Partial<NavState>): NavState => ({
  accountId: 'a',
  url: '',
  hasPage: false,
  canGoBack: false,
  canGoForward: false,
  loading: false,
  activeTabId: 1,
  tabs: [],
  ...over
})

describe('loadingView', () => {
  it('shows nothing without an active account', () => {
    expect(loadingView(undefined, undefined, true)).toEqual({ bar: false, panel: null })
  })

  it('shows the login panel while federating with nothing on screen', () => {
    expect(loadingView('prod', undefined, true)).toEqual({ bar: true, panel: '正在登录 prod…' })
    expect(loadingView('prod', nav({ loading: true }), true)).toEqual({ bar: true, panel: '正在登录 prod…' })
  })

  it('shows a loading panel for a first load after federation', () => {
    expect(loadingView('prod', nav({ loading: true }), false)).toEqual({ bar: true, panel: '正在加载…' })
  })

  it('keeps only the bar once a page is on screen', () => {
    expect(loadingView('prod', nav({ hasPage: true }), true)).toEqual({ bar: true, panel: null })
    expect(loadingView('prod', nav({ hasPage: true, loading: true }), false)).toEqual({ bar: true, panel: null })
  })

  it('is idle when nothing is loading', () => {
    expect(loadingView('prod', nav({}), false)).toEqual({ bar: false, panel: null })
    expect(loadingView('prod', nav({ hasPage: true }), false)).toEqual({ bar: false, panel: null })
  })
})
