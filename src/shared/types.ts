import type { Risk } from './ai'

/**
 * base:   a base account, logged into directly with the credentials its
 *         user-configured credential command prints.
 * assume: a target account, reached by assuming a role with the base
 *         credentials of its linked base account. These are the
 *         day-to-day accounts.
 */
export type AccountKind = 'base' | 'assume'

export interface AwsAccount {
  id: string
  kind: AccountKind
  name: string
  /** 12-digit AWS account id */
  accountId: string
  /** base: role the credential command is run for; assume: role name to assume in the target account */
  role: string
  /** kind=assume only: id of the base account that mints base credentials */
  viaId?: string
  /** kind=base only: shell command printing credential_process JSON; may hold {accountId} {role} {region} */
  command?: string
  defaultRegion: string
  color: string
  /**
   * AI assistant may propose changes, each confirmed by the user in the panel. Absent = false: read-only, and
   * propose_change refuses. Checked again when a proposal is confirmed.
   */
  aiAllowWrite?: boolean
  /** Production account: AI change proposals are one risk level higher and need the resource id typed to confirm. */
  production?: boolean
  /**
   * Services (IAM prefixes, see AI_CHANGE_SERVICES) the AI may propose changes for; 'other' covers every service
   * without an adapter (generic requests). Absent = all of them.
   */
  aiServices?: string[]
  /** Highest risk (after escalation) the AI may propose on this account. Absent = no ceiling. */
  aiMaxRisk?: Risk
}

export interface RecentResource {
  /** stable dedupe key: accountId|service|region|type|name */
  key: string
  accountId: string
  service: string
  serviceLabel: string
  region: string
  resourceType: string
  /** raw identifier extracted from the URL (may be an opaque id like i-0abc…) */
  name: string
  /** human-readable name resolved via AWS APIs (e.g. the EC2 Name tag), if any */
  displayName?: string
  url: string
  lastVisited: number
  pinned: boolean
  /** A console page the parser has no resource rule for, recorded by its route. */
  isPage?: boolean
}

export interface TabInfo {
  /** The tab's webContents id. */
  id: number
  title: string
  url: string
  loading: boolean
}

/** An account's tabs, plus the navigation state of its active tab. */
export interface NavState {
  accountId: string
  url: string
  /** The active tab has committed a page, so its native view is on screen (unless overlays hide it). */
  hasPage: boolean
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  activeTabId: number
  tabs: TabInfo[]
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Progress of an in-page find (⌘F) on the active console view. */
export interface FindResult {
  /** 1-based position of the highlighted match; 0 when there are none. */
  activeMatchOrdinal: number
  matches: number
}

export type ToastKind = 'error' | 'info'

/** A transient message for the bottom-right toast overlay (main → overlay `toast:push`). */
export interface ToastInput {
  kind: ToastKind
  message: string
}

/** One row of the account modal's connection test checklist. Details never hold secrets. */
export interface ConnectionTestStep {
  id: 'command' | 'assume' | 'identity' | 'federation'
  label: string
  status: 'pending' | 'running' | 'ok' | 'fail' | 'skipped'
  detail?: string
}

export interface FindOptions {
  forward: boolean
  /** true starts a new session (incremental typing), false steps within it. */
  findNext: boolean
}
