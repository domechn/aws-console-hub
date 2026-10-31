import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Append-only event log (JSONL), one line per user action, for offline analysis
 * — "which resources do I open, which shortcuts do I actually use, and what
 * deserves to become a quick action". recents.json can't answer that: it keeps
 * only the last visit per resource, deduped and capped.
 */

/** Rolling window: the oldest lines are dropped once, at startup. */
const MAX_LINES = 20_000

// Resolved per call: index.ts rewrites userData after this module is imported.
const logFile = (): string => path.join(app.getPath('userData'), 'activity.jsonl')

export interface ActivityEvent {
  type: string
  [key: string]: unknown
}

/** Fire-and-forget: a lost log line must never break navigation. */
export function logActivity(event: ActivityEvent): void {
  fs.appendFile(logFile(), JSON.stringify({ ts: Date.now(), ...event }) + '\n', () => {})
}

export function trimActivityLog(): void {
  try {
    const file = logFile()
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    if (lines.length <= MAX_LINES) return
    fs.writeFileSync(file, lines.slice(-MAX_LINES).join('\n'))
  } catch {
    // No log yet, or unreadable — nothing to trim.
  }
}

/**
 * Host + path of a console URL, never the query or hash: the federation URL
 * carries a SigninToken and console URLs carry resource ids we already log in
 * structured form. The service still shows up, it lives in the path
 * (/lambda/home, /cloudwatch/home).
 */
export function pageLabel(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname + u.pathname
  } catch {
    return 'invalid'
  }
}
