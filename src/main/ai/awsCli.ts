import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, normalize, win32 } from 'node:path'
import { userCommandEnv } from '../ambientEnv'
import type { AwsCredentials } from '../credentialCommand'
import { redactSecrets } from './redact'
import { scrubParams } from './shape'
import { CANONICAL_TO_CLI, serviceNameProblem } from './serviceNames'

const MISSING = '这个服务需要 AWS CLI 才能执行；请安装 AWS CLI v2，或在设置里指定路径'
const MAX_OUTPUT = 1024 * 1024
const EMR_WRAPPER_APIS: Record<string, string> = {
  'create-cluster': 'RunJobFlow',
  'add-steps': 'AddJobFlowSteps',
  'install-applications': 'AddJobFlowSteps',
  'create-hbase-backup': 'AddJobFlowSteps',
  'restore-from-hbase-backup': 'AddJobFlowSteps',
  'schedule-hbase-backup': 'AddJobFlowSteps',
  'disable-hbase-backups': 'AddJobFlowSteps',
  'terminate-clusters': 'TerminateJobFlows'
}

/** AWS CLI local programs and customizations. API names remain available (for example EMR AddJobFlowSteps). */
export const NON_API_CLI_COMMANDS: Record<string, readonly string[]> = {
  configure: ['*'], sso: ['*'], login: ['*'], logout: ['*'], help: ['*'], history: ['*'], ddb: ['*'],
  deploy: ['*'], datapipeline: ['*'],
  emr: ['ssh', 'socks', 'get', 'put', 'sync', 'create-default-roles', ...Object.keys(EMR_WRAPPER_APIS)],
  codedeploy: ['install', 'uninstall', 'push', 'register', 'deregister'],
  config: ['subscribe', 'get-status'],
  dlm: ['create-default-role'],
  'emr-containers': ['update-role-trust-policy'],
  'ec2-instance-connect': ['open-tunnel', 'ssh'],
  ecr: ['get-login', 'get-login-password'],
  'ecr-public': ['get-login-password'],
  codecommit: ['credential-helper'],
  cloudtrail: ['validate-logs'],
  servicecatalog: ['generate'],
  gamelift: ['upload-build', 'get-game-session-log'],
  ecs: ['execute-command', 'monitor-express-gateway-service'],
  ssm: ['start-session'],
  eks: ['update-kubeconfig', 'get-token'],
  codeartifact: ['login'],
  opsworks: ['register'],
  cloudformation: ['package', 'deploy'],
  lightsail: ['push-container-image'],
  s3: ['presign'],
  cloudfront: ['sign'],
  logs: ['tail', 'start-live-tail'],
  rds: ['generate-db-auth-token'],
  '*': ['wait', 'help', 'get-token', 'generate-*-token', 'start-session', 'execute-command', 'update-kubeconfig', 'login', 'package', 'deploy', 'ssh', 'socks', 'register', 'tail', 'push']
}

export function nonApiCliReason(service: string, action: string): string | null {
  const alias = serviceNameProblem(service)
  if (alias) return alias
  const op = cliOperation(action)
  const names = NON_API_CLI_COMMANDS[service] ?? []
  if (service === 'emr' && EMR_WRAPPER_APIS[op]) return `这个 AWS CLI 命令不是 API 调用，应用不会执行：${service} ${op}；请使用 API 操作名：${EMR_WRAPPER_APIS[op]}`
  return names.includes('*') || names.includes(op) || NON_API_CLI_COMMANDS['*'].includes(op) ||
    (NON_API_CLI_COMMANDS['*'].includes('generate-*-token') && /^generate-.*-token$/.test(op))
    ? `这个 AWS CLI 命令不是 API 调用，应用不会执行：${service}`
    : null
}

export function validateAwsCliPath(path: string): string {
  const windows = process.platform === 'win32'
  if (path.length > 1024 || /[\u0000-\u001f]/.test(path) || !(windows ? win32.isAbsolute(path) : isAbsolute(path))) throw new Error('无效的 AWS CLI 路径：必须是绝对路径')
  const result = windows ? win32.normalize(path.replace(/^[\\/]{2,}/, '\\\\')) : normalize(path)
  if (windows && /^\\\\/.test(result)) throw new Error('无效的 AWS CLI 路径：不接受 UNC 网络路径')
  if (process.platform === 'win32' && !/\.exe$/i.test(result)) throw new Error('无效的 AWS CLI 路径：Windows 只接受 .exe')
  try {
    if (!statSync(result).isFile()) throw new Error('not a file')
    accessSync(result, constants.X_OK)
  } catch { throw new Error('无效的 AWS CLI 路径：文件不存在或不可执行') }
  return result
}

/** botocore xform_name with the CLI's acronym handling. */
export function cliOperation(action: string): string {
  return action.replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

let cached: { key: string; path: string | null } | undefined
export function findAwsCli(override?: string | null): string {
  if (override) return validateAwsCliPath(override)
  const env = userCommandEnv()
  const key = `${override ?? ''}|${env.PATH ?? ''}|${env.HOME ?? ''}|${env.USERPROFILE ?? ''}`
  if (cached?.key === key && cached.path) return validateAwsCliPath(cached.path)
  const name = process.platform === 'win32' ? 'aws.exe' : 'aws'
  const candidates = override
    ? [override]
    : [
        ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((p) => join(p, name)),
        '/opt/homebrew/bin/aws', '/usr/local/bin/aws', '/usr/local/aws-cli/aws',
        join(env.HOME || env.USERPROFILE || homedir(), '.local', 'bin', name),
        'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe'
      ]
  const path = candidates.find((p) => {
    try { validateAwsCliPath(p); return true } catch { return false }
  }) ?? null
  cached = { key, path }
  if (!path) throw new Error(MISSING)
  return validateAwsCliPath(path)
}

const live = new Map<number, { child: ReturnType<typeof spawn>; owner?: string; killTimer?: ReturnType<typeof setTimeout> }>()
export function stopAccountCli(accountId: string): void {
  for (const entry of live.values()) if (entry.owner === accountId) killTree(entry)
}
export function stopAllCli(): void {
  for (const entry of live.values()) killTree(entry)
}

function killTree(entry: { child: ReturnType<typeof spawn>; killTimer?: ReturnType<typeof setTimeout> }): void {
  const child = entry.child
  const pid = child.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    execFile(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    try { process.kill(-pid, 'SIGTERM') } catch { /* already exited */ }
    if (!entry.killTimer) entry.killTimer = setTimeout(() => {
      entry.killTimer = undefined
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ }
      }
    }, 500).unref()
  }
}

export async function cliCall(
  cli: string, credentials: AwsCredentials, service: string, action: string,
  params: Record<string, unknown>, region: string, timeoutMs: number, signal?: AbortSignal, endpointUrl?: string, accountId?: string
): Promise<unknown> {
  const alias = serviceNameProblem(service)
  if (alias) throw new Error(alias)
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(service) || !/^[A-Z][A-Za-z0-9]{2,80}$/.test(action) || action === 'Command') {
    throw new Error('无效的 service 或 action 名称：action 必须是 PascalCase')
  }
  const refused = nonApiCliReason(service, action)
  if (refused) throw new Error(refused)
  const dir = mkdtempSync(join(tmpdir(), 'aws-console-hub-'))
  const input = join(dir, 'input.json')
  try {
    writeFileSync(input, JSON.stringify(params), { mode: 0o600, flag: 'wx' })
    const ambient = userCommandEnv()
    const secretFree = (text: string): string => {
      let safe = text
      const safeParams = scrubParams(service, action, params)
      const secrets: string[] = []
      const collect = (original: unknown, redacted: unknown): void => {
        if (redacted === '[redacted]' && (typeof original === 'string' || typeof original === 'number')) {
          if (String(original).length >= 6) secrets.push(String(original))
        } else if (original && redacted && typeof original === 'object' && typeof redacted === 'object') {
          for (const [k, v] of Object.entries(original)) collect(v, (redacted as Record<string, unknown>)[k])
        }
      }
      collect(params, safeParams)
      for (const secret of [...secrets, credentials.AccessKeyId, credentials.SecretAccessKey, credentials.SessionToken]) {
        if (secret) safe = safe.split(secret).join('[redacted]')
      }
      return redactSecrets(safe)
    }
    const env: NodeJS.ProcessEnv = {
      PATH: ambient.PATH,
      HOME: dir,
      USERPROFILE: dir,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: dir,
      XDG_CACHE_HOME: dir,
      APPDATA: dir,
      LOCALAPPDATA: dir,
      SystemRoot: ambient.SystemRoot,
      TMPDIR: ambient.TMPDIR,
      TEMP: ambient.TEMP,
      LANG: ambient.LANG,
      HTTP_PROXY: ambient.HTTP_PROXY,
      HTTPS_PROXY: ambient.HTTPS_PROXY,
      NO_PROXY: ambient.NO_PROXY,
      http_proxy: ambient.http_proxy,
      https_proxy: ambient.https_proxy,
      no_proxy: ambient.no_proxy,
      AWS_CA_BUNDLE: ambient.AWS_CA_BUNDLE,
      AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: credentials.SessionToken,
      AWS_DEFAULT_REGION: region,
      AWS_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
      AWS_EC2_METADATA_DISABLED: 'true'
    }
    if (endpointUrl) env.AWS_ENDPOINT_URL = endpointUrl
    const cliService = CANONICAL_TO_CLI[service] ?? service
    const args = [cliService, cliOperation(action), '--cli-input-json', `file://${input}`, '--region', region, '--output', 'json', '--no-cli-pager', '--no-paginate']
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('已停止')); return }
      const child = spawn(cli, args, { cwd: dir, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      const entry = { child, owner: accountId, killTimer: undefined as ReturnType<typeof setTimeout> | undefined }
      if (child.pid) live.set(child.pid, entry)
      const chunks: Buffer[] = []
      let stdoutBytes = 0
      let stderr = ''
      let truncated = false
      let ended = false
      let stoppedReason: string | undefined
      let timer: ReturnType<typeof setTimeout>
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      let hardTimer: ReturnType<typeof setTimeout> | undefined
      const stop = (message: string): void => {
        if (ended || stoppedReason) return
        stoppedReason = message
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        killTree(entry)
        // A child or descendant may keep stdout open forever; timeout must still settle the call.
        hardTimer = setTimeout(() => finish(null), 650)
      }
      const abort = (): void => stop('已停止')
      timer = setTimeout(() => stop('AWS CLI 调用超时'), timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      child.stdout?.on('data', (data: Buffer | string) => {
        const b = Buffer.isBuffer(data) ? data : Buffer.from(data)
        if (stdoutBytes + b.length > MAX_OUTPUT && !truncated) {
          truncated = true
          killTree(entry)
        }
        const part = b.subarray(0, Math.max(0, MAX_OUTPUT - stdoutBytes))
        chunks.push(part)
        stdoutBytes += part.length
      })
      child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8').slice(0, Math.max(0, 2048 - stderr.length)) })
      child.on('error', () => stop('AWS CLI 无法启动；请检查设置里的 AWS CLI 路径'))
      const finish = (code: number | null): void => {
        if (child.pid) live.delete(child.pid)
        clearTimeout(timer)
        clearTimeout(drainTimer)
        clearTimeout(hardTimer)
        signal?.removeEventListener('abort', abort)
        if (ended) return
        ended = true
        if (stoppedReason) { reject(new Error(stoppedReason)); return }
        const stdout = Buffer.concat(chunks).toString('utf8')
        if (truncated) { resolve({ truncated: true, output: `${secretFree(stdout)}\n[输出已截断]` }); return }
        if (code !== 0) {
          const message = secretFree(stderr).slice(0, 2048)
          reject(new Error(/invalid choice|Invalid choice|usage: aws/i.test(message)
            ? `AWS CLI 没有这个命令：${cliService} ${cliOperation(action)}。${message}`
            : `AWS CLI 调用失败：${message || `退出码 ${code}`}`))
          return
        }
        const redactValue = (value: unknown): unknown => {
          if (typeof value === 'string') return secretFree(value)
          if (Array.isArray(value)) return value.map(redactValue)
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v)]))
          return value
        }
        try { resolve(stdout.trim() ? redactValue(JSON.parse(stdout)) : {}) } catch { reject(new Error('AWS CLI 返回的不是 JSON')) }
      }
      child.on('close', finish)
      child.on('exit', (code) => {
        if (child.pid) live.delete(child.pid)
        clearTimeout(entry.killTimer)
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* no descendants */ }
        }
        // Give stdout a brief chance to drain; `close` need not fire if a detached descendant holds the pipe.
        drainTimer = setTimeout(() => finish(code), 100)
      })
    })
  } finally {
    try { writeFileSync(input, '') } catch { /* file may already be gone */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {
      // A descendant can outlive the direct CLI process briefly and hold cwd open (notably on Windows).
      setTimeout(() => {
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* best effort */ }
      }, 750).unref()
    }
  }
}
