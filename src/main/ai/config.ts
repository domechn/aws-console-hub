import { readJson, writeJson } from '../store'
import { checkCommand } from '../credentialCommand'
import { REGIONS } from '../../shared/catalog'
import { AI_PROVIDERS, AUDIT_RETENTION_LIMITS, CUSTOM_PROVIDER_ID, type AiBudget, type AiConfig, type AiKeyMode, type BedrockAuth, type ConversationRetention } from '../../shared/ai'

export const DEFAULT_AI_CONFIG: AiConfig = {
  version: 6,
  provider: '',
  model: '',
  baseUrl: null,
  keyMode: 'keychain',
  keyCommand: null,
  bedrockAuth: 'account',
  bedrockAccountId: null,
  bedrockRegion: 'us-east-1',
  auditRetentionDays: AUDIT_RETENTION_LIMITS.default,
  // Kept, as before retention existed; shorter only when the user picks it.
  conversationRetention: null,
  budget: { monthlyTokens: null, monthlyUsd: null, block: false },
  readPage: true,
  quickReplies: true,
  impactAnalysis: true
}

const RETENTIONS: ConversationRetention[] = [0, 30, 90, null]

/** null (no limit) or a positive number within `max`. */
const limit = (v: unknown, max: number, what: string): number | null => {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) throw new Error(`无效的${what}`)
  return v
}

function checkBudget(v: unknown): AiBudget {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('无效的预算设置')
  const b = v as Partial<Record<keyof AiBudget, unknown>>
  if (typeof b.block !== 'boolean') throw new Error('无效的预算设置')
  return { monthlyTokens: limit(b.monthlyTokens ?? null, 1e12, '月度 token 预算'), monthlyUsd: limit(b.monthlyUsd ?? null, 1e6, '月度费用预算'), block: b.block }
}

/** Also fits inference profile ARNs (arn:aws:bedrock:<region>:<account>:application-inference-profile/<id>). */
const MODEL_RE = /^[\w.:/@+-]{1,128}$/
const KEY_MODES: AiKeyMode[] = ['keychain', 'memory', 'command']
const BEDROCK_AUTHS: BedrockAuth[] = ['account', 'apiKey']

/** Plain http only to this machine (Ollama and friends); anything remote must be TLS, or the key travels in clear. */
export function isAllowedBaseUrl(url: string): boolean {
  if (url.length > 500) return false
  try {
    const u = new URL(url)
    if (u.username || u.password) return false
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  } catch {
    return false
  }
}

/** `input` comes from the renderer: validated field by field over `prev`, and only known fields survive. */
export function mergeAiConfig(prev: AiConfig, input: unknown, accountExists: (id: string) => boolean = () => false): AiConfig {
  if (!input || typeof input !== 'object') throw new Error('无效的 AI 配置')
  const i = input as Partial<Record<keyof AiConfig, unknown>>
  const next: AiConfig = { ...prev }
  if (i.provider !== undefined) {
    if (typeof i.provider !== 'string' || !AI_PROVIDERS.some((p) => p.id === i.provider)) throw new Error('不支持的 provider')
    next.provider = i.provider
  }
  if (i.model !== undefined) {
    if (typeof i.model !== 'string' || (i.model !== '' && !MODEL_RE.test(i.model))) throw new Error('无效的模型 id')
    next.model = i.model
  }
  if (i.baseUrl !== undefined) {
    if (i.baseUrl !== null && (typeof i.baseUrl !== 'string' || !isAllowedBaseUrl(i.baseUrl.trim()))) {
      throw new Error('baseURL 必须是 https://，或指向本机的 http://localhost / 127.0.0.1')
    }
    next.baseUrl = typeof i.baseUrl === 'string' ? i.baseUrl.trim() : null
  }
  if (i.keyMode !== undefined) {
    if (!KEY_MODES.includes(i.keyMode as AiKeyMode)) throw new Error('无效的 key 存储方式')
    next.keyMode = i.keyMode as AiKeyMode
  }
  if (i.keyCommand !== undefined) next.keyCommand = i.keyCommand === null ? null : checkCommand(i.keyCommand).trim() || null
  if (i.bedrockAuth !== undefined) {
    if (!BEDROCK_AUTHS.includes(i.bedrockAuth as BedrockAuth)) throw new Error('无效的 Bedrock 认证方式')
    next.bedrockAuth = i.bedrockAuth as BedrockAuth
  }
  if (i.bedrockAccountId !== undefined) {
    if (i.bedrockAccountId !== null && (typeof i.bedrockAccountId !== 'string' || !accountExists(i.bedrockAccountId))) {
      throw new Error('Bedrock 使用的账号不存在')
    }
    next.bedrockAccountId = i.bedrockAccountId
  }
  if (i.bedrockRegion !== undefined) {
    if (typeof i.bedrockRegion !== 'string' || !REGIONS.some((r) => r.id === i.bedrockRegion)) throw new Error('不支持的 Bedrock region')
    next.bedrockRegion = i.bedrockRegion
  }
  if (i.auditRetentionDays !== undefined) {
    const d = i.auditRetentionDays
    if (typeof d !== 'number' || !Number.isInteger(d) || d < AUDIT_RETENTION_LIMITS.min || d > AUDIT_RETENTION_LIMITS.max) {
      throw new Error(`审计保留天数需为 ${AUDIT_RETENTION_LIMITS.min}–${AUDIT_RETENTION_LIMITS.max} 的整数`)
    }
    next.auditRetentionDays = d
  }
  if (i.conversationRetention !== undefined) {
    if (!RETENTIONS.includes(i.conversationRetention as ConversationRetention)) throw new Error('无效的对话保留设置')
    next.conversationRetention = i.conversationRetention as ConversationRetention
  }
  if (i.budget !== undefined) next.budget = checkBudget(i.budget)
  if (i.readPage !== undefined) {
    if (typeof i.readPage !== 'boolean') throw new Error('无效的页面读取设置')
    next.readPage = i.readPage
  }
  if (i.quickReplies !== undefined) {
    if (typeof i.quickReplies !== 'boolean') throw new Error('无效的快捷回复设置')
    next.quickReplies = i.quickReplies
  }
  if (i.impactAnalysis !== undefined) {
    if (typeof i.impactAnalysis !== 'boolean') throw new Error('无效的影响分析设置')
    next.impactAnalysis = i.impactAnalysis
  }
  if (next.provider !== CUSTOM_PROVIDER_ID) next.baseUrl = null
  if (next.keyMode === 'command' && !next.keyCommand) throw new Error('请填写密钥命令')
  return next
}

/**
 * A file from an older version: v1 had no Bedrock fields, v2 no retention or budget, v3 no readPage, v4 no
 * quickReplies, v5 no impactAnalysis; the defaults fill them in.
 */
export function migrateAiConfig(stored: Partial<AiConfig> | Record<string, unknown>): AiConfig {
  const flag = (k: 'readPage' | 'quickReplies' | 'impactAnalysis'): boolean => (typeof stored[k] === 'boolean' ? (stored[k] as boolean) : DEFAULT_AI_CONFIG[k])
  return { ...DEFAULT_AI_CONFIG, ...stored, readPage: flag('readPage'), quickReplies: flag('quickReplies'), impactAnalysis: flag('impactAnalysis'), version: 6 }
}

/** userData/ai-config.json: provider, model, endpoint, key mode, Bedrock account and region. Never a key or credential. */
export class AiConfigStore {
  private config: AiConfig

  constructor(private file: string) {
    this.config = migrateAiConfig(readJson<Partial<AiConfig>>(file, {}))
  }

  get(): AiConfig {
    return this.config
  }

  save(input: unknown, accountExists?: (id: string) => boolean): AiConfig {
    this.config = mergeAiConfig(this.config, input, accountExists)
    writeJson(this.file, this.config)
    return this.config
  }
}
