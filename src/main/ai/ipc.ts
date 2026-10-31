import { ipcMain, type BrowserWindow } from 'electron'
import type { AiService } from './service'
import type { CardActionResult } from '../../shared/ai'
import {
  checkActionId,
  checkAllowKey,
  checkApiKey,
  checkApprovalDecision,
  checkApprovalId,
  checkAuditFilter,
  checkDeleteData,
  checkCardId,
  checkFlag,
  checkFormValues,
  checkId,
  checkPrompt,
  checkUserIndex,
  checkProposalId,
  checkProvider,
  checkRowId,
  checkTitle,
  checkTypedConfirmation,
  checkUrl,
  checkResourceContext,
  checkSearchQuery,
  checkFeedback,
  checkQueueId,
  trustedSender
} from './validate'

/**
 * The fixed ai:* channel list (plan §11). Each argument is validated here; there is no generic invoke, and
 * nothing returns a key: the renderer can store one, never read it back.
 */
export function registerAiIpc(win: BrowserWindow, ai: AiService, openLink: (accountId: string, url: string) => void): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (e, ...args) => {
      // Only the app's own page, top frame. Console tabs have no preload; this is the second lock.
      if (!trustedSender(e, win)) throw new Error('forbidden')
      return fn(...args)
    })
  }
  const conversation = (v: unknown): string | null => (v === null ? null : checkId(v, '对话 id'))
  // A refusal is an answer for the card ({ ok: false, error }), not an exception.
  const answer = async (fn: () => unknown): Promise<CardActionResult> => {
    try {
      await fn()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  handle('ai:config-get', () => ai.configView())
  handle('ai:config-save', (input) => {
    const saved = ai.saveConfig(input)
    // A shorter retention applies now, not tomorrow ("不保留" still waits for the next start or quit).
    ai.maintain(false)
    return saved
  })
  handle('ai:key-set', (key) => ai.setKey(checkApiKey(key)))
  handle('ai:key-clear', () => ai.clearKey())
  handle('ai:models', (provider) => ai.models(checkProvider(provider)))
  handle('ai:test', () => ai.test())
  handle('ai:conversations', (accountId) => ai.conversations(checkId(accountId, '账号 id')))
  handle('ai:history', (accountId, id) => ai.view(checkId(accountId, '账号 id'), checkId(id, '对话 id')))
  handle('ai:send', (accountId, id, text, page, context) => ai.send(checkId(accountId, '账号 id'), conversation(id), checkPrompt(text), checkFlag(page ?? true), checkResourceContext(context)))
  handle('ai:resource-candidates', (accountId, query) => ai.resourceCandidates(checkId(accountId, '账号 id'), checkSearchQuery(query, true)))
  handle('ai:pin', (accountId, id, pinned) => ai.pin(checkId(accountId, '账号 id'), checkId(id, '对话 id'), checkFlag(pinned)))
  handle('ai:search', (accountId, query) => ai.search(checkId(accountId, '账号 id'), checkSearchQuery(query)))
  handle('ai:feedback', (accountId, id, ordinal, value) => ai.feedback(checkId(accountId, '账号 id'), checkId(id, '对话 id'), checkUserIndex(ordinal), checkFeedback(value)))
  handle('ai:queue-cancel', (accountId, id, queueId) => ai.queueCancel(checkId(accountId, '账号 id'), checkId(id, '对话 id'), checkQueueId(queueId)))
  handle('ai:deny-all', (accountId, id) => ai.denyAll(checkId(accountId, '账号 id'), checkId(id, '对话 id')))
  handle('ai:regenerate', (accountId, id, index, expectedText, text, context) =>
    ai.regenerate(checkId(accountId, '账号 id'), checkId(id, '对话 id'), checkUserIndex(index), checkPrompt(expectedText), text === undefined ? undefined : checkPrompt(text), checkResourceContext(context)))
  // The chip: what main would send as the current page (sanitized URL, title, parsed resource), or null.
  handle('ai:page-context', (accountId) => ai.pageContext(checkId(accountId, '账号 id')))
  handle('ai:page-toggle', (accountId, id, on) => ai.setPageContext(checkId(accountId, '账号 id'), checkId(id, '对话 id'), checkFlag(on)))
  handle('ai:abort', (id) => ai.abort(checkId(id, '对话 id')))
  handle('ai:rename', (accountId, id, title) => ai.rename(checkId(accountId, '账号 id'), checkId(id, '对话 id'), checkTitle(title)))
  handle('ai:delete', (accountId, id) => ai.delete(checkId(accountId, '账号 id'), checkId(id, '对话 id')))
  handle('ai:clear', (accountId) => ai.clearAccount(checkId(accountId, '账号 id')))
  handle('ai:open-link', (accountId, url) => openLink(checkId(accountId, '账号 id'), checkUrl(url)))
  handle('ai:card-action', (accountId, id, cardId, actionId, rowId, values) =>
    answer(() => ai.cardAction(checkId(accountId, '账号 id'), checkId(id, '对话 id'), checkCardId(cardId), checkActionId(actionId), checkRowId(rowId), checkFormValues(values)))
  )
  // Ids and the typed text only: what runs is the proposal main stored. Extra arguments are not read.
  handle('ai:proposal-confirm', (accountId, id, proposalId, typed) =>
    answer(() => ai.confirmProposal(checkId(accountId, '账号 id'), checkId(id, '对话 id'), checkProposalId(proposalId), checkTypedConfirmation(typed)))
  )
  handle('ai:proposal-cancel', (accountId, id, proposalId) => answer(() => ai.cancelProposal(checkId(accountId, '账号 id'), checkId(id, '对话 id'), checkProposalId(proposalId))))
  // Ids and the decision only: what runs is the request main froze and hashed. Extra arguments are not read.
  handle('ai:approval-decide', (accountId, id, approvalId, decision) =>
    answer(() => ai.decideApproval(checkId(accountId, '账号 id'), checkId(id, '对话 id'), checkApprovalId(approvalId), checkApprovalDecision(decision)))
  )
  handle('ai:approval-allows', () => ai.sessionAllows())
  handle('ai:approval-revoke', (accountId, id, key) => ai.revokeAllow(checkId(accountId, '账号 id'), checkId(id, '对话 id'), checkAllowKey(key)))
  handle('ai:usage', () => ai.monthUsage())
  // Summaries only (no params, results or keys); read-only.
  handle('ai:audit-list', (filter) => ai.auditList(checkAuditFilter(filter)))
  handle('ai:data-delete', (audit, typed) => {
    const o = checkDeleteData(audit, typed)
    ai.deleteAllData(o.audit, o.typed)
  })
}
