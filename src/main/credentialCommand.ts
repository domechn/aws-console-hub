import { execFile } from 'node:child_process'
import os from 'node:os'
import { userCommandEnv } from './ambientEnv'

/**
 * Base credentials come from a command the user configures, following the AWS
 * CLI `credential_process` contract: it prints
 * `{"Version":1,"AccessKeyId","SecretAccessKey","SessionToken","Expiration"}`
 * on stdout. The command runs through the user's login shell, with the PATH
 * an interactive login shell ends up with (see loginPath), so tools that
 * ~/.zshrc or ~/.bashrc put on PATH resolve even when the app is launched
 * from the Dock.
 */

export interface AwsCredentials {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
  /** ISO timestamp */
  Expiration: string
}

export const ACCOUNT_ID_RE = /^\d{12}$/
/**
 * IAM role name, optionally with a path; the first char keeps it from reading
 * as a CLI flag. None of these chars mean anything to a shell, which is what
 * makes substituting it into the credential command safe.
 */
export const ROLE_RE = /^[\w+=,.@][\w+=,.@/-]{0,127}$/
export const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d$/
export const COMMAND_MAX_LENGTH = 2000

const COMMAND_TIMEOUT_MS = 45_000
const PATH_TIMEOUT_MS = 10_000
const PATH_MARKER = '__AWS_HUB_PATH__'

export interface CommandTarget {
  accountId: string
  role: string
  region: string
}

/** Thrown before running anything when a base account has no command yet. */
export class MissingCommandError extends Error {}

/** The renderer is untrusted: the command must be one line of bounded length. */
export function checkCommand(command: unknown): string {
  if (typeof command !== 'string') throw new Error('无效的凭证命令')
  if (command.length > COMMAND_MAX_LENGTH) throw new Error(`凭证命令不能超过 ${COMMAND_MAX_LENGTH} 个字符`)
  if (/[\r\n\0]/.test(command)) throw new Error('凭证命令只能是一行')
  return command
}

/**
 * Fill `{accountId}` `{role}` `{region}` in. Only values that passed the
 * account validation are ever substituted, so they cannot break out of the
 * command line — checked again here rather than trusted.
 */
export function expandCommand(command: string, target: CommandTarget): string {
  if (!ACCOUNT_ID_RE.test(target.accountId)) throw new Error(`无效的账号 ID：${target.accountId}`)
  if (!ROLE_RE.test(target.role)) throw new Error(`无效的 role：${target.role}`)
  if (!REGION_RE.test(target.region)) throw new Error(`无效的 region：${target.region}`)
  return checkCommand(command)
    .replaceAll('{accountId}', target.accountId)
    .replaceAll('{role}', target.role)
    .replaceAll('{region}', target.region)
}

/** stdout may hold secrets, so nothing from it is ever echoed in an error. */
export function parseCredentialOutput(stdout: string): AwsCredentials {
  const invalid = new Error(
    '凭证命令的输出不是有效的 credential_process JSON（需要 AccessKeyId、SecretAccessKey、SessionToken 和 Expiration）'
  )
  const out = extractJsonObject(stdout) as Partial<Record<keyof AwsCredentials | 'Version', unknown>> | null | undefined
  const { AccessKeyId, SecretAccessKey, SessionToken, Expiration, Version } = out ?? {}
  if (Version !== undefined && Version !== 1) {
    throw new Error(`凭证命令输出的 Version 是 ${String(Version)}，只支持 1`)
  }
  const strings = [AccessKeyId, SecretAccessKey, SessionToken, Expiration]
  if (!strings.every((v) => typeof v === 'string' && v !== '') || Number.isNaN(Date.parse(Expiration as string))) {
    throw invalid
  }
  return { AccessKeyId, SecretAccessKey, SessionToken, Expiration } as AwsCredentials
}

function truncate(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}

/** Index of the `}` closing the object that opens at `start`, or -1. */
function closingBrace(s: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/**
 * The JSON object in a command's stdout. Shell profiles and wrappers may
 * print banners before or after it, so when the whole output is not JSON,
 * take the first balanced `{…}` that parses, preferring one with AccessKeyId.
 */
export function extractJsonObject(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    // Noise around the object: look for it.
  }
  let fallback: unknown
  for (let start = stdout.indexOf('{'); start >= 0; start = stdout.indexOf('{', start + 1)) {
    const end = closingBrace(stdout, start)
    if (end < 0) continue
    try {
      const value: unknown = JSON.parse(stdout.slice(start, end + 1))
      if (value && typeof value === 'object' && 'AccessKeyId' in value) return value
      fallback ??= value
    } catch {
      // Braces in the noise; keep scanning.
    }
  }
  return fallback
}

/** The PATH that loginPath's probe printed between markers; undefined when missing. */
export function parsePathOutput(stdout: string): string | undefined {
  const parts = stdout.split(PATH_MARKER)
  // The last pair: anything echoing the probe itself would print markers earlier.
  const path = parts.length >= 3 ? parts[parts.length - 2].trim() : ''
  return path || undefined
}

let loginPathPromise: Promise<string | undefined> | undefined

/**
 * PATH as an interactive login shell sets it. A Dock-launched app inherits
 * the bare launchd PATH, and `-lc` alone skips ~/.zshrc / ~/.bashrc, where
 * PATH is commonly extended. Probed once per app run (aliases and functions
 * do not carry over, only PATH); undefined keeps process.env.PATH.
 */
export function loginPath(shell: string): Promise<string | undefined> {
  // printf and a quoted "$PATH" (colon-joined in fish too) behave the same in sh, bash, zsh and fish.
  loginPathPromise ??= new Promise((resolve) => {
    const child = execFile(
      shell,
      ['-ilc', `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`],
      { cwd: os.homedir(), timeout: PATH_TIMEOUT_MS },
      // A broken rc file can make the shell exit non-zero after printing PATH anyway.
      (_err, stdout) => resolve(parsePathOutput(stdout))
    )
    // An interactive shell must never sit waiting for input.
    child.stdin?.end()
  })
  return loginPathPromise
}

/** zsh / bash, fish, and sh / dash wordings. */
const NOT_FOUND_RE = /command not found|unknown command|: not found/i

/** Run one command line through the login shell and resolve its stdout. Errors carry stderr only, never stdout. */
async function runInLoginShell(line: string, env: Record<string, string>, what: string): Promise<string> {
  const shell = process.env.SHELL || '/bin/sh'
  const path = await loginPath(shell)
  return new Promise((resolve, reject) => {
    const child = execFile(
      shell,
      ['-lc', line],
      { cwd: os.homedir(), timeout: COMMAND_TIMEOUT_MS, env: { ...userCommandEnv(), ...(path && { PATH: path }), ...env } },
      (err, stdout, stderr) => {
        if (err) {
          const detail = err.killed ? `超时（${COMMAND_TIMEOUT_MS / 1000} 秒）` : stderr.trim() || err.message
          const hint = NOT_FOUND_RE.test(stderr)
            ? `\n提示：应用使用从登录 shell（$SHELL -il）读到的 PATH。命令装在别处时，请在${what}里写它的绝对路径（在终端里用 \`command -v 命令名\` 查看）。`
            : ''
          reject(new Error(`${what}执行失败。请确认命令在终端里能直接运行（例如登录态是否过期）。\n${truncate(detail)}${hint}`))
          return
        }
        resolve(stdout)
      }
    )
    // A command that prompts gets EOF instead of hanging until the timeout.
    child.stdin?.end()
  })
}

/** Run the credential command for `target` and parse what it prints. */
export async function runCredentialCommand(command: string, target: CommandTarget): Promise<AwsCredentials> {
  if (!command.trim()) throw new MissingCommandError('还没有设置凭证命令')
  const line = expandCommand(command, target)
  const env = { AWS_HUB_ACCOUNT_ID: target.accountId, AWS_HUB_ROLE: target.role, AWS_HUB_REGION: target.region }
  return parseCredentialOutput(await runInLoginShell(line, env, '凭证命令'))
}

/** The AI "key command" mode: the command's whole stdout, trimmed, is the LLM API key. */
export async function runKeyCommand(command: string): Promise<string> {
  const line = checkCommand(command).trim()
  if (!line) throw new Error('还没有设置密钥命令')
  const key = (await runInLoginShell(line, {}, '密钥命令')).trim()
  if (!/^[\x21-\x7e]{1,512}$/.test(key)) throw new Error('密钥命令的输出不是一行 API key（需要一行可打印字符，最长 512）')
  return key
}
