import type { NavState } from '../../shared/types'

/**
 * What the UI shows while the active account is busy: the slim bar under the
 * top bar, and a centered panel only while no page is on screen (the native
 * view would paint over it otherwise).
 */
export function loadingView(
  accountName: string | undefined,
  nav: NavState | undefined,
  federating: boolean
): { bar: boolean; panel: string | null } {
  if (accountName === undefined) return { bar: false, panel: null }
  const bar = federating || Boolean(nav?.loading)
  if (!bar || nav?.hasPage) return { bar, panel: null }
  return { bar, panel: federating ? `正在登录 ${accountName}…` : '正在加载…' }
}
