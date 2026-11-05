import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AiConfigStore, DEFAULT_AI_CONFIG, isAllowedBaseUrl, mergeAiConfig } from './config'

describe('mergeAiConfig', () => {
  it('defaults custom image input off, migrates old configs, and accepts only booleans', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-config-')), 'ai-config.json')
    const old = { ...DEFAULT_AI_CONFIG, version: 7, provider: 'custom-openai' } as Record<string, unknown>
    delete old.customImageInput
    fs.writeFileSync(file, JSON.stringify(old))
    expect(new AiConfigStore(file).get()).toMatchObject({ version: 8, customImageInput: false })
    fs.writeFileSync(file, JSON.stringify({ ...old, customImageInput: 'true' }))
    expect(new AiConfigStore(file).get().customImageInput).toBe(false)
    const enabled = mergeAiConfig(DEFAULT_AI_CONFIG, { provider: 'custom-openai', customImageInput: true })
    expect(enabled.customImageInput).toBe(true)
    expect(mergeAiConfig(enabled, { provider: 'openai' }).customImageInput).toBe(false)
    expect(() => mergeAiConfig(enabled, { customImageInput: 'true' })).toThrow(/图片输入/)
  })
  it('clamps the untrusted script duration and migrates old values safely', () => {
    expect(DEFAULT_AI_CONFIG.scriptMaxMinutes).toBe(5)
    expect(mergeAiConfig(DEFAULT_AI_CONFIG, { scriptMaxMinutes: -4 }).scriptMaxMinutes).toBe(1)
    expect(mergeAiConfig(DEFAULT_AI_CONFIG, { scriptMaxMinutes: 90 }).scriptMaxMinutes).toBe(30)
    expect(mergeAiConfig(DEFAULT_AI_CONFIG, { scriptMaxMinutes: 2.8 }).scriptMaxMinutes).toBe(2)
    for (const bad of ['90', NaN, Infinity, null]) expect(() => mergeAiConfig(DEFAULT_AI_CONFIG, { scriptMaxMinutes: bad })).toThrow('脚本')
  })

  it('fills the script duration when loading v6 and clamps a tampered saved value', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-config-')), 'ai-config.json')
    const old = { ...DEFAULT_AI_CONFIG, version: 6 } as Record<string, unknown>
    delete old.scriptMaxMinutes
    fs.writeFileSync(file, JSON.stringify(old))
    expect(new AiConfigStore(file).get()).toMatchObject({ version: 8, scriptMaxMinutes: 5 })
    fs.writeFileSync(file, JSON.stringify({ ...old, scriptMaxMinutes: 1000 }))
    expect(new AiConfigStore(file).get().scriptMaxMinutes).toBe(30)
  })
  it('takes known, valid fields only', () => {
    const next = mergeAiConfig(DEFAULT_AI_CONFIG, { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-should-not-stick', extra: 1 })
    expect(next).toEqual({ ...DEFAULT_AI_CONFIG, provider: 'deepseek', model: 'deepseek-flash' })
  })

  it.each([
    [{ provider: 'evil' }, /provider/],
    [{ provider: 7 }, /provider/],
    [{ model: 'a b' }, /模型/],
    [{ model: 'x'.repeat(200) }, /模型/],
    [{ keyMode: 'disk' }, /存储方式/],
    [{ keyMode: 'command' }, /密钥命令/],
    [{ keyMode: 'command', keyCommand: 'a\nb' }, /一行/],
    [{ provider: 'custom-openai', baseUrl: 'http://example.com/v1' }, /baseURL/],
    [{ provider: 'custom-openai', baseUrl: 'ftp://localhost' }, /baseURL/],
    [null, /无效/]
  ])('rejects %j', (input, error) => {
    expect(() => mergeAiConfig(DEFAULT_AI_CONFIG, input)).toThrow(error)
  })

  it('keeps baseUrl for the custom endpoint only', () => {
    const custom = mergeAiConfig(DEFAULT_AI_CONFIG, { provider: 'custom-openai', model: 'llama3', baseUrl: ' http://localhost:11434/v1 ' })
    expect(custom.baseUrl).toBe('http://localhost:11434/v1')
    expect(mergeAiConfig(custom, { provider: 'openai' }).baseUrl).toBeNull()
  })

  it('accepts an optional AWS CLI path and rejects control characters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cli-path-'))
    const cli = path.join(dir, 'aws')
    fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    expect(mergeAiConfig(DEFAULT_AI_CONFIG, { awsCliPath: ` ${cli} ` }).awsCliPath).toBe(cli)
    expect(mergeAiConfig(DEFAULT_AI_CONFIG, { awsCliPath: '' }).awsCliPath).toBeNull()
    expect(() => mergeAiConfig(DEFAULT_AI_CONFIG, { awsCliPath: '/tmp/aws\nbad' })).toThrow('AWS CLI 路径')
    expect(() => mergeAiConfig(DEFAULT_AI_CONFIG, { awsCliPath: `${cli}\n` })).toThrow('AWS CLI 路径')
    for (const invalid of ['relative/aws', '/missing/aws', dir]) expect(() => mergeAiConfig(DEFAULT_AI_CONFIG, { awsCliPath: invalid })).toThrow('AWS CLI 路径')
    fs.chmodSync(cli, 0o600)
    expect(() => mergeAiConfig(DEFAULT_AI_CONFIG, { awsCliPath: cli })).toThrow('AWS CLI 路径')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('takes a Bedrock account only if it exists, and a region only from the catalog', () => {
    const exists = (id: string) => id === 'acc-1'
    const next = mergeAiConfig(DEFAULT_AI_CONFIG, { provider: 'amazon-bedrock', bedrockAccountId: 'acc-1', bedrockRegion: 'eu-west-1' }, exists)
    expect(next).toMatchObject({ provider: 'amazon-bedrock', bedrockAuth: 'account', bedrockAccountId: 'acc-1', bedrockRegion: 'eu-west-1' })
    expect(mergeAiConfig(next, { bedrockAccountId: null }, exists).bedrockAccountId).toBeNull()
    expect(mergeAiConfig(next, { bedrockAuth: 'apiKey' }, exists).bedrockAuth).toBe('apiKey')
    expect(() => mergeAiConfig(next, { bedrockAccountId: 'acc-2' }, exists)).toThrow(/账号不存在/)
    expect(() => mergeAiConfig(next, { bedrockAccountId: 7 }, exists)).toThrow(/账号不存在/)
    expect(() => mergeAiConfig(next, { bedrockRegion: 'us-east-9' }, exists)).toThrow(/region/)
    expect(() => mergeAiConfig(next, { bedrockAuth: 'profile' }, exists)).toThrow(/认证方式/)
    // Inference profile ids and application profile ARNs are valid model ids.
    expect(mergeAiConfig(next, { model: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3' }).model).toContain('application-inference-profile')
  })

  it('takes retention and budget settings within their bounds; the budget is off by default', () => {
    expect(DEFAULT_AI_CONFIG).toMatchObject({ auditRetentionDays: 180, conversationRetention: null, budget: { monthlyTokens: null, monthlyUsd: null, block: false } })
    const next = mergeAiConfig(DEFAULT_AI_CONFIG, { auditRetentionDays: 30, conversationRetention: 90, budget: { monthlyTokens: 2_000_000, monthlyUsd: 5, block: true } })
    expect(next).toMatchObject({ auditRetentionDays: 30, conversationRetention: 90, budget: { monthlyTokens: 2_000_000, monthlyUsd: 5, block: true } })
    expect(mergeAiConfig(next, { conversationRetention: 0 }).conversationRetention).toBe(0)
    expect(mergeAiConfig(next, { conversationRetention: null }).conversationRetention).toBeNull()
    expect(mergeAiConfig(next, { budget: { monthlyTokens: null, monthlyUsd: null, block: false } }).budget.monthlyUsd).toBeNull()
    for (const bad of [{ auditRetentionDays: 7 }, { auditRetentionDays: 99999 }, { auditRetentionDays: 30.5 }, { auditRetentionDays: '180' }, { conversationRetention: 45 }, { conversationRetention: 'forever' }]) {
      expect(() => mergeAiConfig(DEFAULT_AI_CONFIG, bad), JSON.stringify(bad)).toThrow()
    }
    for (const budget of [null, [], { monthlyUsd: -1, block: false }, { monthlyTokens: Infinity, block: false }, { monthlyUsd: 5 }, { monthlyUsd: '5', block: true }]) {
      expect(() => mergeAiConfig(DEFAULT_AI_CONFIG, { budget }), JSON.stringify(budget)).toThrow('预算')
    }
  })

  it('accepts a key command in command mode', () => {
    expect(mergeAiConfig(DEFAULT_AI_CONFIG, { keyMode: 'command', keyCommand: ' op read op://x/y ' }).keyCommand).toBe('op read op://x/y')
  })
})

describe('isAllowedBaseUrl', () => {
  it.each([
    ['https://api.example.com/v1', true],
    ['http://localhost:11434/v1', true],
    ['http://127.0.0.1:8080', true],
    ['http://[::1]:8080', true],
    ['http://10.0.0.5/v1', false],
    ['http://localhost.evil.com/v1', false],
    ['https://user:pass@example.com', false],
    ['javascript:alert(1)', false],
    ['not a url', false]
  ])('%s → %s', (url, ok) => {
    expect(isAllowedBaseUrl(url)).toBe(ok)
  })
})

describe('AiConfigStore', () => {
  it('persists non-secret config to its JSON file and reloads it', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-config-')), 'ai-config.json')
    const store = new AiConfigStore(file)
    expect(store.get()).toEqual(DEFAULT_AI_CONFIG)
    store.save({ provider: 'anthropic', model: 'claude-sonnet-4-5', keyMode: 'memory' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...DEFAULT_AI_CONFIG, provider: 'anthropic', model: 'claude-sonnet-4-5', keyMode: 'memory' })
    expect(new AiConfigStore(file).get().model).toBe('claude-sonnet-4-5')
    expect(() => store.save({ provider: 'nope' })).toThrow()
    expect(new AiConfigStore(file).get().provider).toBe('anthropic')
  })

  it('migrates a v1 file: Bedrock fields get their defaults, the rest is kept', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-config-')), 'ai-config.json')
    const v1 = { version: 1, provider: 'deepseek', model: 'deepseek-flash', baseUrl: null, keyMode: 'command', keyCommand: 'op read x' }
    fs.writeFileSync(file, JSON.stringify(v1))
    const store = new AiConfigStore(file)
    expect(store.get()).toEqual({
      ...v1,
      awsCliPath: null,
      version: 8,
      bedrockAuth: 'account',
      bedrockAccountId: null,
      bedrockRegion: 'us-east-1',
      auditRetentionDays: 180,
      conversationRetention: null,
      budget: { monthlyTokens: null, monthlyUsd: null, block: false },
      readPage: true,
      quickReplies: true,
      impactAnalysis: true,
      customImageInput: false,
      scriptMaxMinutes: 5
    })
    store.save({ provider: 'amazon-bedrock', bedrockAccountId: 'acc-1' }, (id) => id === 'acc-1')
    const saved = fs.readFileSync(file, 'utf8')
    expect(JSON.parse(saved)).toMatchObject({ version: 8, provider: 'amazon-bedrock', bedrockAccountId: 'acc-1' })
    // Only the account's id: credentials never reach the config file.
    expect(saved).not.toMatch(/AccessKeyId|SecretAccessKey|SessionToken|ASIA|AKIA/)
  })

  it('migrates a v3 file: page reading on unless it says a boolean; the setting only takes a boolean', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-config-'))
    const load = (stored: Record<string, unknown>) => {
      const file = path.join(dir, `${Math.random()}.json`)
      fs.writeFileSync(file, JSON.stringify(stored))
      return new AiConfigStore(file)
    }
    const v3 = { ...DEFAULT_AI_CONFIG, version: 3, provider: 'deepseek', model: 'deepseek-flash' } as Record<string, unknown>
    delete v3.readPage
    delete v3.quickReplies
    expect(load(v3).get()).toEqual({ ...DEFAULT_AI_CONFIG, provider: 'deepseek', model: 'deepseek-flash', version: 8, readPage: true, quickReplies: true, impactAnalysis: true })
    expect(load({ ...v3, version: 4, readPage: false }).get().readPage).toBe(false)
    expect(load({ ...v3, readPage: 'no' }).get().readPage).toBe(true)
    const store = load(v3)
    expect(store.save({ readPage: false }).readPage).toBe(false)
    expect(() => store.save({ readPage: 'false' })).toThrow(/页面读取/)
    expect(store.get().readPage).toBe(false)
  })

  it('migrates a v4 file to v5: quick replies on unless it says a boolean; the setting only takes a boolean', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-config-'))
    const load = (stored: Record<string, unknown>) => {
      const file = path.join(dir, `${Math.random()}.json`)
      fs.writeFileSync(file, JSON.stringify(stored))
      return new AiConfigStore(file)
    }
    const v4 = { ...DEFAULT_AI_CONFIG, version: 4, provider: 'deepseek', model: 'deepseek-flash', readPage: false } as Record<string, unknown>
    delete v4.quickReplies
    expect(load(v4).get()).toEqual({ ...DEFAULT_AI_CONFIG, provider: 'deepseek', model: 'deepseek-flash', version: 8, readPage: false, quickReplies: true, impactAnalysis: true })
    expect(load({ ...v4, version: 5, quickReplies: false }).get().quickReplies).toBe(false)
    expect(load({ ...v4, quickReplies: 1 }).get().quickReplies).toBe(true)
    const store = load(v4)
    expect(store.save({ quickReplies: false }).quickReplies).toBe(false)
    expect(() => store.save({ quickReplies: 'off' })).toThrow(/快捷回复/)
    expect(store.get().quickReplies).toBe(false)
  })

  it('migrates a v5 file to v6: impact analysis on unless it says a boolean; the setting only takes a boolean', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-config-'))
    const load = (stored: Record<string, unknown>) => {
      const file = path.join(dir, `${Math.random()}.json`)
      fs.writeFileSync(file, JSON.stringify(stored))
      return new AiConfigStore(file)
    }
    const v5 = { ...DEFAULT_AI_CONFIG, version: 5, provider: 'deepseek', model: 'deepseek-flash', quickReplies: false } as Record<string, unknown>
    delete v5.impactAnalysis
    expect(load(v5).get()).toEqual({ ...DEFAULT_AI_CONFIG, provider: 'deepseek', model: 'deepseek-flash', version: 8, quickReplies: false, impactAnalysis: true })
    expect(load({ ...v5, version: 6, impactAnalysis: false }).get().impactAnalysis).toBe(false)
    expect(load({ ...v5, impactAnalysis: 'no' }).get().impactAnalysis).toBe(true)
    const store = load(v5)
    expect(store.save({ impactAnalysis: false }).impactAnalysis).toBe(false)
    expect(() => store.save({ impactAnalysis: 0 })).toThrow(/影响分析/)
    expect(store.get().impactAnalysis).toBe(false)
  })
})
