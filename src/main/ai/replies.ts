/**
 * suggest_replies' chips (the tool is in tools.ts): up to 4 under the assistant's reply; a click sends the chip's
 * text as an ordinary user message, through the same send path (limits, budget, prefix checks) as typing it. Nothing
 * here can approve or confirm anything: approvals and proposals are decided only by their own cards' buttons, which
 * send ids over IPC. Pure.
 */
import type { QuickReply } from '../../shared/ai'

export const REPLY_LIMITS = { options: 4, label: 16, text: 200 }

/**
 * Turns main writes start with a bracketed word ([card_action], [proposal_result]); a chip starting with any such
 * word could pass for one, so none may.
 */
const CONTROL_PREFIX = /^\[[A-Za-z_]/

// Control and format characters (bidi overrides, zero-width) out, whitespace runs to one space.
const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim() : '')

/**
 * The chips main will show: each option checked on its own (empty, too long, control prefix: dropped), duplicates
 * (same label or text) dropped, at most 4. Also re-run on stored ones when history is read.
 */
export function checkReplies(input: unknown): QuickReply[] {
  const options = (input as { options?: unknown } | null)?.options
  const out: QuickReply[] = []
  for (const o of Array.isArray(options) ? options : []) {
    if (out.length >= REPLY_LIMITS.options) break
    const label = clean((o as { label?: unknown } | null)?.label)
    const text = clean((o as { text?: unknown } | null)?.text)
    if (!label || !text || [...label].length > REPLY_LIMITS.label || text.length > REPLY_LIMITS.text) continue
    if (CONTROL_PREFIX.test(label) || CONTROL_PREFIX.test(text)) continue
    if (out.some((r) => r.label === label || r.text === text)) continue
    out.push({ label, text })
  }
  return out
}
