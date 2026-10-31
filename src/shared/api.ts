import type { AwsAccount, ConnectionTestStep, FindOptions, FindResult, NavState, Rect, RecentResource, ToastInput } from './types'
import type {
  AiConfig,
  AiConfigView,
  AiEventEnvelope,
  AiModelInfo,
  AiSendResult,
  AiTestResult,
  ApprovalDecision,
  AuditFilter,
  SessionAllowView,
  AuditView,
  CardActionResult,
  MonthUsage,
  ConversationSummary,
  ConversationView,
  PageContext,
  SetKeyResult
} from './ai'
import type { FormValues } from './cards'

/** API of the toast overlay view (window.toastApi), and nothing else: it shows text. */
export interface ToastApi {
  onToast(cb: (toast: ToastInput) => void): () => void
  /** Subscribed; main holds pushes back until then. */
  ready(): void
  /** Height of the toast stack in CSS px; 0 hides the overlay. */
  resize(height: number): void
  /** A toast was closed by hand; main hands focus back to the app. */
  dismissed(): void
  copy(text: string): void
}

/** Where an account switch came from — logged to spot unused entry points. */
export type SwitchSource = 'switcher' | 'hotkey' | 'palette' | 'new-account'

export interface SaveAccountResult {
  accounts: AwsAccount[]
  saved: AwsAccount
}

/** API exposed to the renderer via contextBridge (window.api). */
export interface Api {
  /** process.platform, so shortcuts can use ⌘ on macOS and Ctrl elsewhere. */
  platform: string
  listAccounts(): Promise<AwsAccount[]>
  saveAccount(input: Partial<AwsAccount>): Promise<SaveAccountResult>
  /** Fails with `error` when a base account still has dependent accounts. */
  deleteAccount(id: string): Promise<{ accounts: AwsAccount[]; error?: string }>
  /**
   * Test a login with these (unsaved) fields, validated like saveAccount (rejects when invalid).
   * Resolves to the final checklist; onTestProgress streams it, tagged with `runId`, as steps run.
   */
  testConnection(input: Partial<AwsAccount>, runId: number): Promise<ConnectionTestStep[]>
  onTestProgress(cb: (runId: number, steps: ConnectionTestStep[]) => void): () => void
  /** Show (and lazily create + federate) the console view for an account. */
  openAccount(id: string, source?: SwitchSource): Promise<void>
  /** Force a fresh federation login for the account. */
  relogin(id: string): Promise<void>
  /** Navigate an account's console view to a URL (switches to that account). */
  navigate(accountId: string, url: string): Promise<void>
  goBack(): void
  goForward(): void
  reloadView(): void
  setConsoleBounds(rect: Rect): void
  setConsoleVisible(visible: boolean): void
  /** Keyboard back to the on-screen console tab (e.g. after closing the AI panel). */
  focusConsole(): void
  /** Find `text` in the active console view; empty text clears the highlights. */
  find(text: string, options: FindOptions): void
  stopFind(): void
  /** Bring a tab of its account forward (tab ids come from NavState.tabs). */
  activateTab(tabId: number): void
  /** Close a tab; an account's last tab stays open. */
  closeTab(tabId: number): void
  /** Append a renderer-side action to the activity log (see main/activity.ts). */
  logAction(event: { type: string; [key: string]: unknown }): void
  listRecents(): Promise<RecentResource[]>
  setPinned(key: string, pinned: boolean): Promise<void>
  deleteRecent(key: string): Promise<void>
  onRecents(cb: (items: RecentResource[]) => void): () => void
  onNavState(cb: (state: NavState) => void): () => void
  onPaletteOpen(cb: () => void): () => void
  /** ⌘⇧A pressed while focus was inside the console view. */
  onSwitcherOpen(cb: () => void): () => void
  onSwitchAccount(cb: (index: number) => void): () => void
  /** ⌘F pressed while focus was inside the console view. */
  onFindOpen(cb: () => void): () => void
  /** Esc pressed inside the console page while the find bar was open. */
  onFindClose(cb: () => void): () => void
  /** ⌘J pressed while focus was inside the console view. */
  onRecentsToggle(cb: () => void): () => void
  onFindResult(cb: (result: FindResult) => void): () => void
  /** Show an error toast. Login errors are toasted by the main process itself. */
  showError(message: string): void
  /** A login needs the account edited first (a base account without a credential command). */
  onEditAccount(cb: (account: AwsAccount) => void): () => void
  /** A user-facing login for the account started (true) or finished, failed included (false). Not sent for background refreshes. */
  onFederationState(cb: (accountId: string, active: boolean) => void): () => void
  /** ⌘I pressed while focus was inside the console view. */
  onAssistantToggle(cb: () => void): () => void
  ai: AiApi
}

/**
 * The AI assistant (window.api.ai). Fixed channels, each validated in main. The API key is write-only:
 * nothing here returns it, and LLM / AWS calls happen in main, never in the renderer.
 */
export interface AiApi {
  getConfig(): Promise<AiConfigView>
  /** Rejects with a message when a field is invalid. */
  saveConfig(input: Partial<AiConfig>): Promise<AiConfigView>
  /** Stores the key for the configured provider, as its key mode says. */
  setKey(key: string): Promise<SetKeyResult>
  clearKey(): Promise<void>
  models(provider: string): Promise<AiModelInfo[]>
  /** A tiny completion with one tool call against the saved config. */
  test(): Promise<AiTestResult>
  conversations(accountId: string): Promise<ConversationSummary[]>
  history(accountId: string, conversationId: string): Promise<ConversationView>
  /**
   * null starts a new conversation (`page`: its page toggle, default on). Rejects when the provider or key is missing.
   * Progress comes via onEvent.
   */
  send(accountId: string, conversationId: string | null, text: string, page?: boolean): Promise<AiSendResult>
  /** The current page as the model would get it (sanitized URL, title, parsed resource); null off the console. */
  pageContext(accountId: string): Promise<PageContext | null>
  /** The chip's ×: the conversation stops (or starts again) sending the current page. */
  setPageContext(accountId: string, conversationId: string, on: boolean): Promise<void>
  abort(conversationId: string): Promise<void>
  rename(accountId: string, conversationId: string, title: string): Promise<void>
  delete(accountId: string, conversationId: string): Promise<void>
  /** Delete every conversation of the account. */
  clear(accountId: string): Promise<void>
  /** A link in a reply: console pages open in the account, other web links by the app's tab / browser policy. */
  openLink(accountId: string, url: string): Promise<void>
  /**
   * A card button (not copy, which the renderer does itself). Main checks it against the stored card; a reply
   * resolves the card and is sent to the assistant, open-console opens the page.
   */
  cardAction(accountId: string, conversationId: string, cardId: string, actionId: string, rowId?: string, values?: FormValues): Promise<CardActionResult>
  /**
   * The final click on a proposal card. Main checks everything again (owner, state, TTL, hash, the typed text, the
   * account's write switch, drift) and executes the params it stored; resolves once it ran (or was refused).
   */
  confirmProposal(accountId: string, conversationId: string, proposalId: string, typed?: string): Promise<CardActionResult>
  cancelProposal(accountId: string, conversationId: string, proposalId: string): Promise<CardActionResult>
  /**
   * A decision on an approval card. Only the ids and the decision go to main, which runs the request it froze (or
   * answers the paused call with the denial); never params.
   */
  decideApproval(accountId: string, conversationId: string, approvalId: string, decision: ApprovalDecision): Promise<CardActionResult>
  /** Every "本对话内一直允许" entry (in memory: gone with the conversation or an app restart). */
  sessionAllows(): Promise<SessionAllowView[]>
  revokeAllow(accountId: string, conversationId: string, key: string): Promise<void>
  /** This month's tokens and estimated cost, all conversations, and the budget's verdict. */
  usage(): Promise<MonthUsage>
  /** The audit log, read-only: summaries (no params, results or keys), newest first, at most 500. */
  auditList(filter: AuditFilter): Promise<AuditView[]>
  /**
   * Delete every conversation and the usage history; with `audit`, the audit log too, which needs
   * DELETE_AUDIT_PHRASE typed (checked in main).
   */
  deleteAllData(audit: boolean, typed?: string): Promise<void>
  onEvent(cb: (e: AiEventEnvelope) => void): () => void
}
