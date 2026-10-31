/** URL decisions for the console views. Pure, so they can be tested without Electron. */
import { isConsoleUrl } from '../shared/consoleUrl'

/** URLs on these domains stay inside the app, sharing the account's session. */
const IN_APP_DOMAINS = [
  'amazon.com',
  // Not amazonaws.com: anyone can host pages there (S3, ELB, API Gateway).
  'amazonaws.cn',
  'awsapps.com',
  'awsstatic.com'
]

export function isInAppUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const host = u.hostname
  return u.protocol === 'https:' && IN_APP_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
}

/** Only web links may reach the OS; file:, smb: and custom schemes could launch anything. */
export function isWebUrl(url: string): boolean {
  try {
    return ['https:', 'http:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * Auth flows (SSO and other identity providers) routinely call window.open() with no URL
 * or about:blank and navigate the handle afterwards. Those are the only opens
 * that still get a real window — denying them is what silently swallows the
 * login prompt.
 */
export function isDeferredOpen(url: string): boolean {
  return !url || url === 'about:blank'
}

/**
 * An expired console session redirects to the AWS sign-in page. Our own
 * federation URL sits on the same host, so the path has to be checked too,
 * or every login would look like a logout.
 */
export function isSignInUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (!/(^|\.)signin\.aws\.amazon\.com$/.test(u.hostname)) return false
    return u.pathname !== '/federation'
  } catch {
    return false
  }
}

/** Only a console URL is a valid federation `Destination`. */
export { isConsoleUrl }

/** The region a console page is in: its `region=` parameter, else the `<region>.console…` host. */
export function consoleRegion(url: string): string | undefined {
  if (!isConsoleUrl(url)) return undefined
  const u = new URL(url)
  const region = u.searchParams.get('region') ?? /^([a-z]{2}(?:-[a-z]+)+-\d)\.console\./.exec(u.hostname)?.[1]
  return region && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) ? region : undefined
}

/**
 * What a `target="_blank"` link or `window.open(url)` turns into: a real popup
 * only for the URL-less auth-flow shape, a new tab in the same account for
 * Amazon / AWS pages, the system browser for other web URLs, nothing otherwise.
 */
export function windowOpenAction(url: string): 'popup' | 'tab' | 'external' | 'deny' {
  if (isDeferredOpen(url)) return 'popup'
  if (isInAppUrl(url)) return 'tab'
  return isWebUrl(url) ? 'external' : 'deny'
}
