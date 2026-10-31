/** Argument checks for the ai:* IPC channels. Pure. Everything from the renderer is untrusted input. */
import { AI_PROVIDERS, APPROVAL_DECISIONS, RISK_LEVELS, type ApprovalDecision, type AuditFilter, type Risk } from '../../shared/ai'
import { MAX_TEXT_VALUE } from '../../shared/cardRules'
import { ACTION_ID_RE, CARD_LIMITS, FIELD_NAME_RE, ROW_ID_RE, type FormValues } from '../../shared/cards'

export const MAX_PROMPT_CHARS = 8000
export const MAX_TITLE_CHARS = 100

const ID_RE = /^[A-Za-z0-9-]{1,64}$/

/** An account id (AccountStore uuid) or conversation id (randomUUID). */
export function checkId(v: unknown, what = 'id'): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new Error(`无效的 ${what}`)
  return v
}

export function checkFlag(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('无效的开关值')
  return v
}

export function checkPrompt(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error('消息不能为空')
  if (v.length > MAX_PROMPT_CHARS) throw new Error(`消息不能超过 ${MAX_PROMPT_CHARS} 个字符`)
  return v.trim()
}

export function checkUserIndex(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('无效的消息位置')
  return v
}

export function checkTitle(v: unknown): string {
  if (typeof v !== 'string') throw new Error('无效的标题')
  const title = v.replace(/[\r\n\t]+/g, ' ').trim()
  if (!title || title.length > MAX_TITLE_CHARS) throw new Error(`标题需为 1–${MAX_TITLE_CHARS} 个字符`)
  return title
}

/** API key as typed or pasted: one line, printable ASCII (KeyStore re-checks). */
export function checkApiKey(v: unknown): string {
  if (typeof v !== 'string') throw new Error('无效的 API key')
  const key = v.trim()
  if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw new Error('API key 必须是一行可打印字符，最长 4096')
  return key
}

export function checkProvider(v: unknown): string {
  if (typeof v !== 'string' || !AI_PROVIDERS.some((p) => p.id === v)) throw new Error('不支持的 provider')
  return v
}

/** A card id (main's `c-` + 12 hex). */
export function checkCardId(v: unknown): string {
  if (typeof v !== 'string' || !/^c-[0-9a-f]{12}$/.test(v)) throw new Error('无效的卡片 id')
  return v
}

export function checkActionId(v: unknown): string {
  if (typeof v !== 'string' || !new RegExp(ACTION_ID_RE).test(v)) throw new Error('无效的按钮 id')
  return v
}

export function checkRowId(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !new RegExp(ROW_ID_RE).test(v)) throw new Error('无效的行 id')
  return v
}

/** Form values: shape only (field names, scalar types, sizes). Main checks them against the card's fields. */
export function checkFormValues(v: unknown): FormValues | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw new Error('无效的表单值')
  const entries = Object.entries(v)
  const nameRe = new RegExp(FIELD_NAME_RE)
  if (entries.length > CARD_LIMITS.fields) throw new Error('表单值太多')
  for (const [k, x] of entries) {
    const ok = typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length <= MAX_TEXT_VALUE)
    if (!nameRe.test(k) || !ok) throw new Error('无效的表单值')
  }
  return v as FormValues
}

/** A proposal id (main's `p-` + 12 hex). */
export function checkProposalId(v: unknown): string {
  if (typeof v !== 'string' || !/^p-[0-9a-f]{12}$/.test(v)) throw new Error('无效的提案 id')
  return v
}

/** An approval id (main's `a-` + 12 hex). */
export function checkApprovalId(v: unknown): string {
  if (typeof v !== 'string' || !/^a-[0-9a-f]{12}$/.test(v)) throw new Error('无效的审批 id')
  return v
}

export function checkApprovalDecision(v: unknown): ApprovalDecision {
  if (typeof v !== 'string' || !APPROVAL_DECISIONS.includes(v as ApprovalDecision)) throw new Error('无效的审批决定')
  return v as ApprovalDecision
}

/** An "always allow" key: service:action:region, the names checked as classify.ts does. */
export function checkAllowKey(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-z0-9-]{1,40}:[A-Z][A-Za-z0-9]{1,100}:[a-z0-9-]{1,30}$/.test(v)) throw new Error('无效的允许记录')
  return v
}

/** What the user typed to confirm: one line of text, compared with the expected id / name in main. Never params. */
export function checkTypedConfirmation(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v.length > 300 || /[\u0000-\u001f\u007f]/.test(v)) throw new Error('无效的确认输入')
  return v
}

/**
 * IPC from the app's own page only: the main window's webContents and its top frame. Console tabs have no preload
 * (so no IPC at all); this is the second lock, and it also keeps any subframe out.
 */
export function trustedSender(e: { sender: unknown; senderFrame?: unknown }, win: { webContents: { mainFrame?: unknown } }): boolean {
  return e.sender === win.webContents && e.senderFrame !== undefined && e.senderFrame !== null && e.senderFrame === win.webContents.mainFrame
}

/** The audit viewer's filter: known keys only, each checked. */
export function checkAuditFilter(v: unknown): AuditFilter {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw new Error('无效的审计筛选')
  const f = v as Record<string, unknown>
  if (Object.keys(f).some((k) => !['accountId', 'days', 'risk', 'scope'].includes(k))) throw new Error('无效的审计筛选')
  const out: AuditFilter = {}
  if (f.accountId !== undefined) out.accountId = checkId(f.accountId, '账号 id')
  if (f.days !== undefined) {
    if (typeof f.days !== 'number' || !Number.isInteger(f.days) || f.days < 1 || f.days > 3650) throw new Error('无效的天数')
    out.days = f.days
  }
  if (f.risk !== undefined) {
    if (!RISK_LEVELS.includes(f.risk as Risk)) throw new Error('无效的风险级别')
    out.risk = f.risk as Risk
  }
  if (f.scope !== undefined) {
    if (f.scope !== 'changes' && f.scope !== 'all') throw new Error('无效的审计范围')
    out.scope = f.scope
  }
  return out
}

/** "删除全部 AI 数据": whether the audit log goes too, and the phrase typed for that (compared in the service). */
export function checkDeleteData(audit: unknown, typed: unknown): { audit: boolean; typed?: string } {
  if (typeof audit !== 'boolean') throw new Error('无效的删除范围')
  if (typed !== undefined && (typeof typed !== 'string' || typed.length > 50)) throw new Error('无效的确认输入')
  return { audit, typed: typed as string | undefined }
}

/** Links clicked in a reply; main re-checks them against the URL policy before opening. */
export function checkUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length > 4000) throw new Error('无效的链接')
  return v
}
