import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/api'

function subscribe(channel: string) {
  return (cb: (...args: never[]) => void): (() => void) => {
    const listener = (_e: unknown, ...args: unknown[]): void => (cb as (...a: unknown[]) => void)(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const api: Api = {
  platform: process.platform,
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  saveAccount: (input) => ipcRenderer.invoke('accounts:save', input),
  deleteAccount: (id) => ipcRenderer.invoke('accounts:delete', id),
  testConnection: (input, runId) => ipcRenderer.invoke('accounts:test-connection', input, runId),
  onTestProgress: subscribe('accounts:test-progress'),
  openAccount: (id, source) => ipcRenderer.invoke('accounts:open', id, source),
  relogin: (id) => ipcRenderer.invoke('accounts:relogin', id),
  navigate: (accountId, url) => ipcRenderer.invoke('console:navigate', accountId, url),
  goBack: () => ipcRenderer.send('console:back'),
  goForward: () => ipcRenderer.send('console:forward'),
  reloadView: () => ipcRenderer.send('console:reload'),
  setConsoleBounds: (rect) => ipcRenderer.send('console:bounds', rect),
  setConsoleVisible: (visible) => ipcRenderer.send('console:visible', visible),
  focusConsole: () => ipcRenderer.send('console:focus'),
  find: (text, options) => ipcRenderer.send('console:find', text, options),
  stopFind: () => ipcRenderer.send('console:find-stop'),
  activateTab: (tabId) => ipcRenderer.send('tabs:activate', tabId),
  closeTab: (tabId) => ipcRenderer.send('tabs:close', tabId),
  logAction: (event) => ipcRenderer.send('activity:log', event),
  listRecents: () => ipcRenderer.invoke('recents:list'),
  setPinned: (key, pinned) => ipcRenderer.invoke('recents:pin', key, pinned),
  deleteRecent: (key) => ipcRenderer.invoke('recents:delete', key),
  onRecents: subscribe('recents:updated'),
  onNavState: subscribe('nav:state'),
  onPaletteOpen: subscribe('palette:open'),
  onSwitcherOpen: subscribe('switcher:open'),
  onSwitchAccount: subscribe('ui:switch-account'),
  onFindOpen: subscribe('find:open'),
  onFindClose: subscribe('find:close'),
  onRecentsToggle: subscribe('recents:toggle'),
  onFindResult: subscribe('find:result'),
  showError: (message) => ipcRenderer.send('toast:show', message),
  onFederationState: subscribe('federation:state'),
  onEditAccount: subscribe('account:edit'),
  onAssistantToggle: subscribe('assistant:toggle'),
  ai: {
    getConfig: () => ipcRenderer.invoke('ai:config-get'),
    saveConfig: (input) => ipcRenderer.invoke('ai:config-save', input),
    setKey: (key) => ipcRenderer.invoke('ai:key-set', key),
    clearKey: () => ipcRenderer.invoke('ai:key-clear'),
    models: (provider) => ipcRenderer.invoke('ai:models', provider),
    test: () => ipcRenderer.invoke('ai:test'),
    conversations: (accountId) => ipcRenderer.invoke('ai:conversations', accountId),
    history: (accountId, conversationId) => ipcRenderer.invoke('ai:history', accountId, conversationId),
    send: (accountId, conversationId, text, page) => ipcRenderer.invoke('ai:send', accountId, conversationId, text, page),
    pageContext: (accountId) => ipcRenderer.invoke('ai:page-context', accountId),
    setPageContext: (accountId, conversationId, on) => ipcRenderer.invoke('ai:page-toggle', accountId, conversationId, on),
    abort: (conversationId) => ipcRenderer.invoke('ai:abort', conversationId),
    rename: (accountId, conversationId, title) => ipcRenderer.invoke('ai:rename', accountId, conversationId, title),
    delete: (accountId, conversationId) => ipcRenderer.invoke('ai:delete', accountId, conversationId),
    clear: (accountId) => ipcRenderer.invoke('ai:clear', accountId),
    openLink: (accountId, url) => ipcRenderer.invoke('ai:open-link', accountId, url),
    cardAction: (accountId, conversationId, cardId, actionId, rowId, values) =>
      ipcRenderer.invoke('ai:card-action', accountId, conversationId, cardId, actionId, rowId, values),
    confirmProposal: (accountId, conversationId, proposalId, typed) => ipcRenderer.invoke('ai:proposal-confirm', accountId, conversationId, proposalId, typed),
    cancelProposal: (accountId, conversationId, proposalId) => ipcRenderer.invoke('ai:proposal-cancel', accountId, conversationId, proposalId),
    decideApproval: (accountId, conversationId, approvalId, decision) => ipcRenderer.invoke('ai:approval-decide', accountId, conversationId, approvalId, decision),
    sessionAllows: () => ipcRenderer.invoke('ai:approval-allows'),
    revokeAllow: (accountId, conversationId, key) => ipcRenderer.invoke('ai:approval-revoke', accountId, conversationId, key),
    usage: () => ipcRenderer.invoke('ai:usage'),
    auditList: (filter) => ipcRenderer.invoke('ai:audit-list', filter),
    deleteAllData: (audit, typed) => ipcRenderer.invoke('ai:data-delete', audit, typed),
    onEvent: subscribe('ai:event')
  }
}

contextBridge.exposeInMainWorld('api', api)
