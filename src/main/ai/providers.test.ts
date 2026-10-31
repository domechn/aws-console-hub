import fs from 'node:fs'
import http2 from 'node:http2'
import os from 'node:os'
import path from 'node:path'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, normalizeContext, type Model, type Models, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { explainBedrockError } from './bedrock'
import {
  APP_IDENTITY,
  appStreamFn,
  bedrockModel,
  bedrockProvider,
  BUILTIN_PROVIDERS,
  createAppModels,
  createConfiguredModels,
  customOpenAiProvider,
  listModels,
  lockAmbientBedrockAuth,
  resolveModel,
  testModel,
  type AwsCredentialsLike
} from './providers'

type TelemetrySpan = NonNullable<SimpleStreamOptions['telemetry']>

/** A telemetry span that records whether pi ever touched it. */
function spySpan(): { span: TelemetrySpan; used: () => boolean } {
  const startSpan = vi.fn((_o: unknown, cb: (s: TelemetrySpan) => unknown) => cb(span))
  const span = { startSpan, addEvent: vi.fn(), addLink: vi.fn(), setAttributes: vi.fn(), setStatus: vi.fn() } as unknown as TelemetrySpan
  return { span, used: () => startSpan.mock.calls.length > 0 }
}

function fauxModels(): { models: Models; seen: (SimpleStreamOptions | undefined)[]; model: Model<string> } {
  const faux = fauxProvider()
  const seen: (SimpleStreamOptions | undefined)[] = []
  faux.setResponses(
    Array.from({ length: 4 }, () => (_c: unknown, options: SimpleStreamOptions | undefined) => {
      seen.push(options)
      return fauxAssistantMessage('ok')
    })
  )
  const models = createAppModels()
  models.setProvider(faux.provider)
  return { models, seen, model: faux.getModel() }
}

const context = normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] })

describe('pi entrypoint', () => {
  it('never lets a telemetry span reach pi, even when one is passed in', async () => {
    const { models, seen, model } = fauxModels()
    const leaked = spySpan()
    await (await appStreamFn(models)(model, context, { telemetry: leaked.span })).result()
    expect(leaked.used()).toBe(false)
    expect(seen[0]?.telemetry).toBeUndefined()

    // Control: the same span through pi directly is used, so the assertion above is not vacuous.
    const direct = spySpan()
    await models.streamSimple(model, context, { telemetry: direct.span }).result()
    expect(direct.used()).toBe(true)
  })

  it('forces the app identity over pi-agent-core attribution', async () => {
    const { models, seen, model } = fauxModels()
    const piAttribution = { attribution: { name: 'pi', url: 'https://pi.dev' } }
    await (await appStreamFn(models)(model, context, { identity: piAttribution })).result()
    expect(seen[0]?.identity).toEqual(APP_IDENTITY)
  })

  it('ignores API keys in process.env; only an explicit key authenticates', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-from-env')
    try {
      const models = createAppModels()
      models.setProvider(BUILTIN_PROVIDERS.deepseek())
      expect(await models.getAuth('deepseek')).toBeUndefined()
      expect((await models.getAuth('deepseek', { apiKey: 'sk-explicit' }))?.auth.apiKey).toBe('sk-explicit')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('lists catalog models with per-1M-token prices for the built-in providers', () => {
    const models = createAppModels()
    for (const p of Object.values(BUILTIN_PROVIDERS)) models.setProvider(p())
    for (const id of Object.keys(BUILTIN_PROVIDERS)) {
      const list = models.getModels(id)
      expect(list.length, id).toBeGreaterThan(0)
      expect(list.some((m) => m.cost.input > 0 && m.cost.output > 0), id).toBe(true)
    }
  })

  it('builds a keyless custom OpenAI-compatible provider', async () => {
    const models = createAppModels()
    models.setProvider(customOpenAiProvider({ baseUrl: 'http://localhost:11434/v1', modelId: 'llama3', contextWindow: 128000, maxTokens: 4096 }))
    expect(models.getModel('custom-openai', 'llama3')?.baseUrl).toBe('http://localhost:11434/v1')
    expect(await models.getAuth('custom-openai')).toEqual({ auth: {} })
  })
})

describe('model selection and connection test', () => {
  it('resolves catalog models and (re)registers a custom endpoint from config', () => {
    const models = createConfiguredModels()
    expect(resolveModel(models, { provider: 'deepseek', model: 'deepseek-flash', baseUrl: null })?.id).toBe('deepseek-flash')
    expect(resolveModel(models, { provider: 'deepseek', model: 'nope', baseUrl: null })).toBeUndefined()
    expect(resolveModel(models, { provider: 'custom-openai', model: 'llama3', baseUrl: null })).toBeUndefined()
    expect(resolveModel(models, { provider: 'custom-openai', model: 'llama3', baseUrl: 'http://localhost:11434/v1' })?.baseUrl).toBe('http://localhost:11434/v1')
    expect(resolveModel(models, { provider: 'custom-openai', model: 'qwen', baseUrl: 'https://gw.example/v1' })?.baseUrl).toBe('https://gw.example/v1')
  })

  it('lists models with catalog prices', () => {
    const list = listModels(createConfiguredModels(), 'deepseek')
    expect(list.length).toBeGreaterThan(0)
    expect(list[0]).toEqual({ id: expect.any(String), name: expect.any(String), contextWindow: expect.any(Number), reasoning: expect.any(Boolean), cost: expect.objectContaining({ input: expect.any(Number), output: expect.any(Number) }) })
  })

  it('tests a model with one tiny tool-calling request and reports errors as text', async () => {
    const faux = fauxProvider()
    let seen: { apiKey?: string; prompt: string } | undefined
    faux.setResponses([
      (context, options) => {
        seen = { apiKey: options?.apiKey, prompt: JSON.stringify(context) }
        return fauxAssistantMessage([fauxToolCall('ping', {})], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 Unauthorized' })
    ])
    const models = createAppModels()
    models.setProvider(faux.provider)
    expect(await testModel(models, faux.getModel(), 'sk-test')).toMatchObject({ ok: true, toolCalling: true })
    expect(seen?.apiKey).toBe('sk-test')
    expect(seen?.prompt).toContain('connectivity test')
    expect(await testModel(models, faux.getModel(), 'sk-test')).toMatchObject({ ok: false, toolCalling: false, error: '401 Unauthorized' })
  })
})

describe('pi stays behind its entry points', () => {
  it('is imported only by providers/service/tools/analysis in main, and never by the renderer or shared code', () => {
    const root = path.resolve(__dirname, '../..')
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    const importers = files(root)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /from '@earendil-works\//.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
      .sort()
    expect(importers).toEqual(['main/ai/analysis.ts', 'main/ai/providers.ts', 'main/ai/service.ts', 'main/ai/tools.ts'])
    // Only providers.ts may construct an Agent: everything else goes through createAppAgent.
    const agents = files(root).filter((f) => !/\.test\./.test(f) && /new Agent\(/.test(fs.readFileSync(f, 'utf8')))
    expect(agents.map((f) => path.basename(f))).toEqual(['providers.ts'])
  })
})

describe('Bedrock', () => {
  const SONNET = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
  const creds = (n: number, expiresInMs = 3_600_000): AwsCredentialsLike => ({
    AccessKeyId: `ASIAAPPACCOUNT00000${n}`,
    SecretAccessKey: `app-secret-${n}-wJalrXUtnFEMIK7MDENG`,
    SessionToken: `app-session-token-${n}`,
    Expiration: new Date(Date.now() + expiresInMs).toISOString()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('lists the catalog with inference-profile ids and prices', () => {
    const list = listModels(createConfiguredModels(), 'amazon-bedrock')
    const ids = list.map((m) => m.id)
    expect(ids).toContain(SONNET)
    expect(ids.some((id) => id.startsWith('global.'))).toBe(true)
    expect(ids.some((id) => id.startsWith('eu.'))).toBe(true)
    expect(list.find((m) => m.id === SONNET)?.cost.input).toBeGreaterThan(0)
  })

  it('asks the credential pipeline on every request, so refreshed credentials are used, and never logs them', async () => {
    const pipeline = vi.fn<() => Promise<AwsCredentialsLike>>().mockResolvedValueOnce(creds(1)).mockResolvedValueOnce(creds(2))
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const models = createAppModels()
    models.setProvider(bedrockProvider({ region: 'eu-west-1', credentials: pipeline }))
    expect(pipeline).not.toHaveBeenCalled()
    const first = await models.getAuth('amazon-bedrock')
    expect(first?.env).toEqual({
      AWS_REGION: 'eu-west-1',
      AWS_ACCESS_KEY_ID: 'ASIAAPPACCOUNT000001',
      AWS_SECRET_ACCESS_KEY: creds(1).SecretAccessKey,
      AWS_SESSION_TOKEN: 'app-session-token-1'
    })
    expect(first?.auth).toEqual({})
    expect((await models.getAuth('amazon-bedrock'))?.env?.AWS_ACCESS_KEY_ID).toBe('ASIAAPPACCOUNT000002')
    expect(pipeline).toHaveBeenCalledTimes(2)
    const output = logged.flatMap((s) => s.mock.calls).map(String).join('\n')
    expect(output).not.toMatch(/app-secret|app-session-token|ASIAAPPACCOUNT/)
  })

  it('refuses credentials that are (about to be) expired instead of sending them', async () => {
    const models = createAppModels()
    models.setProvider(bedrockProvider({ region: 'us-east-1', credentials: async () => creds(1, 10_000) }))
    await expect(models.getAuth('amazon-bedrock')).rejects.toThrow(/已过期/)
  })

  it('uses a bearer token only when one is given, and is unconfigured otherwise', async () => {
    const models = createAppModels()
    models.setProvider(bedrockProvider({ region: 'us-east-1' }))
    expect(await models.getAuth('amazon-bedrock')).toBeUndefined()
    expect(await models.getAuth('amazon-bedrock', { apiKey: 'ABSK-token' })).toEqual({ auth: { apiKey: 'ABSK-token' }, env: { AWS_REGION: 'us-east-1' } })
  })

  it('removes the ambient auth switches pi and the AWS SDK would otherwise read from the environment', () => {
    const env: NodeJS.ProcessEnv = { AWS_BEARER_TOKEN_BEDROCK: 'host', AWS_BEDROCK_SKIP_AUTH: '1', AWS_AUTH_SCHEME_PREFERENCE: 'httpBearerAuth', PATH: '/bin' }
    lockAmbientBedrockAuth(env)
    expect(env).toEqual({ AWS_AUTH_SCHEME_PREFERENCE: 'sigv4', PATH: '/bin' })
  })

  it('keeps catalog models and makes typed-in ids price-unknown, borrowing limits from a matching catalog model', () => {
    const models = createConfiguredModels()
    expect(bedrockModel(models, SONNET, 'us-east-1').cost.input).toBeGreaterThan(0)
    const profile = bedrockModel(models, 'ca.anthropic.claude-sonnet-4-5-20250929-v1:0', 'ca-central-1')
    expect(profile).toMatchObject({ id: 'ca.anthropic.claude-sonnet-4-5-20250929-v1:0', contextWindow: 200_000, cost: { input: 0, output: 0 } })
    expect(profile.baseUrl).toBe('https://bedrock-runtime.ca-central-1.amazonaws.com')
    const arn = bedrockModel(models, 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/x', 'us-east-1')
    expect(arn).toMatchObject({ api: 'bedrock-converse-stream', provider: 'amazon-bedrock', contextWindow: 128_000 })
    // Not registered: the cost estimate looks prices up with getModel and so counts them as unknown.
    expect(models.getModel('amazon-bedrock', profile.id)).toBeUndefined()
    expect(resolveModel(models, { provider: 'amazon-bedrock', model: SONNET, baseUrl: null, bedrockRegion: 'us-east-1' })?.id).toBe(SONNET)
  })

  /** A local stand-in for bedrock-runtime: records each request and answers like AWS does on a denied call. */
  async function fakeBedrock(): Promise<{ url: string; requests: http2.IncomingHttpHeaders[]; close: () => Promise<void> }> {
    const requests: http2.IncomingHttpHeaders[] = []
    const server = http2.createServer((req, res) => {
      requests.push(req.headers)
      req.resume()
      res.writeHead(403, { 'content-type': 'application/json', 'x-amzn-errortype': 'AccessDeniedException' })
      res.end(
        JSON.stringify({
          message:
            'User: arn:aws:sts::123456789012:assumed-role/Dev/me is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0'
        })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) }
  }

  /** Host credentials the Bedrock path must never use: env keys, a bearer token, a shared credentials file. */
  function hostCredentials(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-aws-'))
    fs.writeFileSync(path.join(dir, 'credentials'), '[default]\naws_access_key_id = AKIAHOSTFILE00000000\naws_secret_access_key = hostfilesecret\n')
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', path.join(dir, 'credentials'))
    vi.stubEnv('AWS_CONFIG_FILE', path.join(dir, 'config'))
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAHOSTENV000000000')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'hostenvsecret')
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'host-bearer-token')
  }

  it('signs real pi Bedrock requests with the account credentials only (no host credentials, no default chain)', async () => {
    hostCredentials()
    const server = await fakeBedrock()
    try {
      const models = createAppModels() // locks the env down, as at app start
      models.setProvider(bedrockProvider({ region: 'us-west-2', credentials: async () => creds(7) }))
      const model = { ...bedrockModel(models, SONNET, 'us-west-2'), baseUrl: server.url }
      const reply = await (await appStreamFn(models)(model, context, {})).result()

      expect(server.requests).toHaveLength(1)
      const h = server.requests[0]
      expect(h[':path']).toBe(`/model/${encodeURIComponent(SONNET)}/converse-stream`)
      expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAAPPACCOUNT000007\/\d{8}\/us-west-2\/bedrock\/aws4_request/)
      expect(h['x-amz-security-token']).toBe('app-session-token-7')
      expect(JSON.stringify(h)).not.toMatch(/AKIAHOST|host-bearer-token|Bearer/)
      expect(h['user-agent']).not.toMatch(/pi\/\d/)

      // The denied call comes back as text and maps to the IAM hint with the exact ARN.
      expect(reply.stopReason).toBe('error')
      expect(explainBedrockError(reply.errorMessage ?? '', model.id, 'us-west-2')).toContain(
        '资源 arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0'
      )
    } finally {
      await server.close()
    }
  })

  it('control: without the env lockdown a host bearer token would replace the account signature', async () => {
    const server = await fakeBedrock()
    try {
      const models = createAppModels()
      vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'host-bearer-token') // set again after the lockdown ran
      models.setProvider(bedrockProvider({ region: 'us-west-2', credentials: async () => creds(7) }))
      const model = { ...bedrockModel(models, SONNET, 'us-west-2'), baseUrl: server.url }
      await (await appStreamFn(models)(model, context, {})).result()
      expect(server.requests[0]?.authorization).toBe('Bearer host-bearer-token')
    } finally {
      await server.close()
    }
  })

  it('sends a bearer token in API-key mode', async () => {
    hostCredentials()
    const server = await fakeBedrock()
    try {
      const models = createAppModels()
      models.setProvider(bedrockProvider({ region: 'us-east-1' }))
      const model = { ...bedrockModel(models, SONNET, 'us-east-1'), baseUrl: server.url }
      await (await appStreamFn(models)(model, context, { apiKey: 'ABSKapptoken' })).result()
      expect(server.requests[0]?.authorization).toBe('Bearer ABSKapptoken')
    } finally {
      await server.close()
    }
  })

  it('without account credentials or a key, fails before any request instead of falling back to host credentials', async () => {
    hostCredentials()
    const server = await fakeBedrock()
    try {
      const models = createAppModels()
      models.setProvider(bedrockProvider({ region: 'us-east-1' }))
      const model = { ...bedrockModel(models, SONNET, 'us-east-1'), baseUrl: server.url }
      const reply = await (await appStreamFn(models)(model, context, {})).result()
      expect(reply.stopReason).toBe('error')
      expect(reply.errorMessage).toMatch(/not configured/)
      expect(server.requests).toHaveLength(0)
    } finally {
      await server.close()
    }
  })
})
