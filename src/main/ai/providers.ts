// The app's only door to pi: every Agent and LLM request is built here so the privacy settings below can't be skipped.
// Keep this file free of relative imports: scripts/ai-smoke.mjs runs it under plain Node (type stripping).
import { Agent, type AgentOptions, type StreamFn } from '@earendil-works/pi-agent-core'
import {
  createModels,
  createProvider,
  normalizeContext,
  Type,
  type AuthContext,
  type ClientIdentity,
  type Model,
  type Models,
  type MutableModels,
  type Provider
} from '@earendil-works/pi-ai'
import { lazyApi } from '@earendil-works/pi-ai/api/lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { AMAZON_BEDROCK_MODELS } from '@earendil-works/pi-ai/providers/amazon-bedrock.models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { googleProvider } from '@earendil-works/pi-ai/providers/google'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'

/** Providers offered in settings. Import each by path, never `providers/all`: that bundles every vendor SDK. */
export const BUILTIN_PROVIDERS = {
  deepseek: deepseekProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  openrouter: openrouterProvider,
  // Without credentials until a request's config registers the real one (resolveModel); this one only lists the catalog.
  'amazon-bedrock': () => bedrockProvider({ region: 'us-east-1' })
} satisfies Record<string, () => Provider<any>>

export interface CustomOpenAiConfig {
  baseUrl: string
  modelId: string
  contextWindow: number
  maxTokens: number
  customImageInput?: boolean
}

export const CUSTOM_PROVIDER_ID = 'custom-openai'

/** Any OpenAI-compatible endpoint (gateway, Ollama). No catalog price, so cost shows as 0. */
export function customOpenAiProvider(c: CustomOpenAiConfig): Provider<'openai-completions'> {
  const model: Model<'openai-completions'> = {
    id: c.modelId,
    name: c.modelId,
    api: 'openai-completions',
    provider: CUSTOM_PROVIDER_ID,
    baseUrl: c.baseUrl,
    reasoning: false,
    input: c.customImageInput ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: c.contextWindow,
    maxTokens: c.maxTokens
  }
  return createProvider({
    id: CUSTOM_PROVIDER_ID,
    // Keyless endpoints (local Ollama) still resolve; a key, when given, comes from getApiKey.
    auth: { apiKey: { name: 'API key', resolve: async ({ credential }) => ({ auth: credential ? { apiKey: credential.key } : {} }) } },
    models: [model],
    api: openAICompletionsApi()
  })
}

export const BEDROCK_PROVIDER_ID = 'amazon-bedrock'

/** Cross-region inference profile ids: a geo prefix in front of a foundation model id (us.anthropic.…). */
export const PROFILE_PREFIX_RE = /^(us|us-gov|eu|apac|au|ca|jp|in|global)\./

/** main's AwsCredentials (credentialCommand.ts), structurally: this file can't import it. */
export interface AwsCredentialsLike {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
  /** ISO timestamp */
  Expiration: string
}

export interface BedrockConfig {
  region: string
  /** Account mode: asked on every request, so a long chat follows the pipeline's refreshes. Absent: bearer-token mode. */
  credentials?: () => Promise<AwsCredentialsLike>
}

/** A request must not start on credentials about to lapse; the pipeline refreshes well before this. */
const MIN_CREDENTIAL_VALIDITY_MS = 60_000

/**
 * Bedrock with the app's auth instead of pi's (which probes AWS_PROFILE, env keys, ECS/web-identity roles). resolve runs
 * per request and hands pi either the bearer token from getApiKey or the account's credentials as request-scoped env,
 * which pi's stream turns into explicit SDK `credentials`, so the SDK's default chain (~/.aws, instance role) never runs.
 */
export function bedrockProvider(c: BedrockConfig): Provider<'bedrock-converse-stream'> {
  return createProvider({
    id: BEDROCK_PROVIDER_ID,
    name: 'Amazon Bedrock',
    auth: {
      apiKey: {
        name: 'AWS account credentials or Bedrock API key',
        resolve: async ({ credential }) => {
          const env = { AWS_REGION: c.region }
          if (credential?.key) return { auth: { apiKey: credential.key }, env }
          if (!c.credentials) return undefined
          const k = await c.credentials()
          if (Date.parse(k.Expiration) - MIN_CREDENTIAL_VALIDITY_MS < Date.now()) {
            throw new Error('Bedrock 使用的账号凭证已过期，请重新登录该账号，或检查它的凭证命令')
          }
          return {
            auth: {},
            env: { ...env, AWS_ACCESS_KEY_ID: k.AccessKeyId, AWS_SECRET_ACCESS_KEY: k.SecretAccessKey, AWS_SESSION_TOKEN: k.SessionToken }
          }
        }
      }
    },
    models: Object.values(AMAZON_BEDROCK_MODELS),
    // pi's own lazy loader imports through a variable specifier, which breaks once bundled; this subpath bundles.
    api: lazyApi(async () => (await import('@earendil-works/pi-ai/bedrock-provider')).bedrockProviderModule)
  })
}

/**
 * pi's Bedrock stream and the AWS SDK read these from process.env on every request: a bearer token there would replace
 * the account's SigV4 signing, and an auth-scheme preference (env, or ~/.aws/config, which env outranks) could make the
 * SDK send a host SSO token. Bedrock is authenticated only with what bedrockProvider's resolve hands over.
 */
export function lockAmbientBedrockAuth(env: NodeJS.ProcessEnv = process.env): void {
  delete env.AWS_BEARER_TOKEN_BEDROCK
  delete env.AWS_BEDROCK_SKIP_AUTH
  env.AWS_AUTH_SCHEME_PREFERENCE = 'sigv4'
}

/** shortcut: a model the catalog doesn't know gets 128k / 8k unless it is a profile of a known one; add fields if one needs more. */
const BEDROCK_FALLBACK = { reasoning: false, input: ['text'] as ('text' | 'image')[], contextWindow: 128_000, maxTokens: 8192 }
const NO_PRICE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * A catalog model, or one typed in (another inference profile, an application profile ARN). Typed-in ones are not
 * registered, so getModel stays undefined for them and the cost estimate counts them as price unknown.
 */
export function bedrockModel(models: Models, id: string, region: string): Model<'bedrock-converse-stream'> {
  const known = models.getModel(BEDROCK_PROVIDER_ID, id) as Model<'bedrock-converse-stream'> | undefined
  if (known) return known
  const base = id.replace(PROFILE_PREFIX_RE, '')
  const template = models.getModels(BEDROCK_PROVIDER_ID).find((m) => m.id.replace(PROFILE_PREFIX_RE, '') === base) as
    | Model<'bedrock-converse-stream'>
    | undefined
  return {
    ...(template ?? { ...BEDROCK_FALLBACK, api: 'bedrock-converse-stream', provider: BEDROCK_PROVIDER_ID }),
    id,
    name: id,
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    cost: NO_PRICE
  }
}

/**
 * Sent as `User-Agent: pi` with no attribution headers. pi-ai defaults to `pi/<version> (<os>; node/<v>; <arch>)`
 * and pi-agent-core adds pi's attribution (`HTTP-Referer: https://pi.dev` etc. on OpenRouter); `null` turns it off.
 */
export const APP_IDENTITY: ClientIdentity = { userAgent: 'short', attribution: null }

/** API keys come only from Agent.getApiKey, never from process.env or credential files pi would otherwise probe. */
const NO_AMBIENT_AUTH: AuthContext = { env: async () => undefined, fileExists: async () => false }

export function createAppModels(): MutableModels {
  lockAmbientBedrockAuth()
  return createModels({ authContext: NO_AMBIENT_AUTH, identity: APP_IDENTITY })
}

/**
 * pi has no exporter: it only emits spans into a `telemetry` context its caller passes (none = NOOP). Strip it anyway,
 * so a future pi version or a stray option can't attach one, and force APP_IDENTITY on every request.
 */
export function appStreamFn(models: Models, maxTokens?: number): StreamFn {
  return (model, context, options) => {
    const { telemetry: _telemetry, ...rest } = options ?? {}
    return models.streamSimple(model, context, { ...rest, ...(maxTokens && { maxTokens }), identity: APP_IDENTITY })
  }
}

/** `maxTokens`: a cap on each reply's output (the impact analysis keeps its runs small). */
export function createAppAgent(models: Models, options: Omit<AgentOptions, 'streamFn' | 'identity'> & { maxTokens?: number; wrapStream?: (stream: StreamFn) => StreamFn }): Agent {
  const { maxTokens, wrapStream, ...rest } = options
  const stream = appStreamFn(models, maxTokens)
  return new Agent({ ...rest, streamFn: wrapStream ? wrapStream(stream) : stream, identity: APP_IDENTITY })
}

/** Models with every built-in provider registered. */
export function createConfiguredModels(): MutableModels {
  const models = createAppModels()
  for (const provider of Object.values(BUILTIN_PROVIDERS)) models.setProvider(provider())
  return models
}

/** shortcut: a custom endpoint gets a fixed 128k context / 8k output; add settings fields once a model needs other limits. */
const CUSTOM_LIMITS = { contextWindow: 128_000, maxTokens: 8192 }

/**
 * The configured model; a custom endpoint, or Bedrock with its region and account credentials, is (re)registered from
 * the config first. Undefined when unknown.
 */
export function resolveModel(
  models: MutableModels,
  config: { provider: string; model: string; baseUrl: string | null; customImageInput?: boolean; bedrockRegion?: string },
  bedrockCredentials?: () => Promise<AwsCredentialsLike>
): Model<any> | undefined {
  if (config.provider === BEDROCK_PROVIDER_ID) {
    if (!config.model) return undefined
    const region = config.bedrockRegion ?? 'us-east-1'
    models.setProvider(bedrockProvider({ region, credentials: bedrockCredentials }))
    return bedrockModel(models, config.model, region)
  }
  if (config.provider === CUSTOM_PROVIDER_ID) {
    if (!config.baseUrl || !config.model) return undefined
    models.setProvider(customOpenAiProvider({ baseUrl: config.baseUrl, modelId: config.model, customImageInput: config.customImageInput, ...CUSTOM_LIMITS }))
  }
  return models.getModel(config.provider, config.model)
}

/** Read-only image capability for settings and attachment preparation. */
export function supportsImageInput(models: Models, config: { provider: string; model: string; baseUrl: string | null; customImageInput?: boolean }): boolean {
  if (!config.model) return false
  if (config.provider === CUSTOM_PROVIDER_ID) return Boolean(config.baseUrl && config.customImageInput)
  const model = config.provider === BEDROCK_PROVIDER_ID
    ? bedrockModel(models, config.model, 'us-east-1')
    : models.getModel(config.provider, config.model)
  return model?.input.includes('image') ?? false
}

/** The catalog for a provider, as the settings dropdown shows it. */
export function listModels(models: Models, provider: string) {
  return models.getModels(provider).map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    reasoning: m.reasoning,
    cost: { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite }
  }))
}

const PING_TOOL = { name: 'ping', description: 'Connectivity check. Call it exactly once.', parameters: Type.Object({}) }

/**
 * One tiny request that asks for a tool call: proves the endpoint, the key and tool calling in one go. The prompt
 * carries no account data. Errors come back as text; the caller still scrubs them before they leave main.
 */
export async function testModel(models: Models, model: Model<any>, apiKey: string | undefined) {
  const started = Date.now()
  const context = normalizeContext({
    systemPrompt: 'This is a connectivity test. Call the ping tool once.',
    messages: [{ role: 'user', content: 'ping', timestamp: started }],
    tools: [PING_TOOL]
  })
  const stream = await appStreamFn(models)(model, context, { apiKey, maxTokens: 1024, signal: AbortSignal.timeout(30_000) })
  const reply = await stream.result()
  const latencyMs = Date.now() - started
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
    return { ok: false, toolCalling: false, latencyMs, error: reply.errorMessage ?? '请求失败' }
  }
  return { ok: true, toolCalling: reply.content.some((c) => c.type === 'toolCall'), latencyMs }
}
