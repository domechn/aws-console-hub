import { useEffect, useState } from 'react'
import { AI_PROVIDERS, BEDROCK_PROVIDER_ID, CUSTOM_PROVIDER_ID } from '../../../../shared/ai'
import type { AiConfig, AiConfigView, AiKeyMode, AiModelInfo, AiTestResult, BedrockAuth } from '../../../../shared/ai'
import { REGIONS } from '../../../../shared/catalog'
import type { AwsAccount } from '../../../../shared/types'
import { formatRates, ipcError } from '../../ai'
import { AiAudit } from './AiAudit'
import { AiDataSettings } from './AiDataSettings'

interface Props {
  /** Candidates for the account Bedrock signs in with. */
  accounts: AwsAccount[]
  onClose: (config: AiConfigView | null) => void
  /** "删除全部 AI 数据" ran: the panel reloads its conversations. */
  onDataDeleted: () => void
}

const KEY_MODES: { id: AiKeyMode; label: string }[] = [
  { id: 'keychain', label: '加密保存（系统钥匙串）' },
  { id: 'memory', label: '仅本次运行（内存）' },
  { id: 'command', label: '密钥命令' }
]

const ai = window.api.ai

/** Provider, model, endpoint and key. The key field is write-only: main never sends a stored key back. */
export function AiSettings({ accounts, onClose, onDataDeleted, initialView = 'settings' }: Props & { initialView?: 'settings' | 'audit' }): React.JSX.Element {
  const [config, setConfig] = useState<AiConfigView | null>(null)
  const [view, setView] = useState<'settings' | 'audit'>(initialView)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [keyMode, setKeyMode] = useState<AiKeyMode>('keychain')
  const [keyCommand, setKeyCommand] = useState('')
  const [bedrockAuth, setBedrockAuth] = useState<BedrockAuth>('account')
  const [bedrockAccountId, setBedrockAccountId] = useState('')
  const [bedrockRegion, setBedrockRegion] = useState('us-east-1')
  const [key, setKey] = useState('')
  const [models, setModels] = useState<AiModelInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AiTestResult | null>(null)

  const custom = provider === CUSTOM_PROVIDER_ID
  const bedrock = provider === BEDROCK_PROVIDER_ID
  // Bedrock signed with an account's credentials: no key of any kind.
  const accountAuth = bedrock && bedrockAuth === 'account'

  useEffect(() => {
    void ai.getConfig().then((c) => {
      setConfig(c)
      setProvider(c.provider)
      setModel(c.model)
      setBaseUrl(c.baseUrl ?? '')
      setKeyMode(c.keyMode)
      setKeyCommand(c.keyCommand ?? '')
      setBedrockAuth(c.bedrockAuth)
      setBedrockAccountId(c.bedrockAccountId ?? '')
      setBedrockRegion(c.bedrockRegion)
    })
  }, [])

  useEffect(() => {
    if (!provider || provider === CUSTOM_PROVIDER_ID) {
      setModels([])
      return
    }
    void ai.models(provider).then(setModels)
  }, [provider])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (view === 'audit') setView('settings')
      else onClose(config)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, config, view])

  // A result only describes what it was run with.
  useEffect(() => setResult(null), [provider, model, baseUrl, keyMode, keyCommand, key, bedrockAuth, bedrockAccountId, bedrockRegion])

  const selected = models.find((m) => m.id === model)

  /** Saves the form (and a newly typed key); returns the stored config, or null when something was rejected. */
  const save = async (): Promise<AiConfigView | null> => {
    setError(null)
    setSaving(true)
    try {
      const input: Partial<AiConfig> = {
        provider,
        model: model.trim(),
        baseUrl: custom ? baseUrl.trim() || null : null,
        keyMode,
        keyCommand: keyMode === 'command' ? keyCommand : null,
        ...(bedrock && { bedrockAuth, bedrockAccountId: bedrockAccountId || null, bedrockRegion })
      }
      let saved = await ai.saveConfig(input)
      if (key.trim() && keyMode !== 'command' && !accountAuth) {
        const r = await ai.setKey(key)
        if (!r.ok) {
          setError(r.error)
          return null
        }
        setKey('')
        saved = await ai.getConfig()
      }
      setConfig(saved)
      return saved
    } catch (err) {
      setError(ipcError(err))
      return null
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    if (!(await save())) return
    setTesting(true)
    try {
      setResult(await ai.test())
    } finally {
      setTesting(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    await ai.clearKey()
    setConfig(await ai.getConfig())
  }

  const savedHere = config?.provider === provider
  const keyStatus = keyMode === 'command' ? null : savedHere && config?.hasKey ? '已设置' : '未设置'
  const keyPlaceholder = keyStatus === '已设置' ? '输入新 key 以替换' : custom ? '可留空（本地端点）' : bedrock ? '粘贴 Bedrock API key' : '粘贴 API key'

  return (
    <div className="backdrop" onMouseDown={() => onClose(config)}>
      <div className={`modal ai-settings${view === 'audit' ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={view === 'audit' ? 'AI 审计' : 'AI 设置'} onMouseDown={(e) => e.stopPropagation()}>
        {view === 'audit' ? (
          <AiAudit accounts={accounts} onBack={() => setView('settings')} />
        ) : (
          <>
        <h2>AI 设置</h2>

        <label>
          服务商
          <select value={provider} onChange={(e) => (setProvider(e.target.value), setModel(''))}>
            <option value="" disabled>
              请选择
            </option>
            {AI_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {custom ? (
          <>
            <label>
              baseURL
              <input
                className="mono"
                value={baseUrl}
                placeholder="https://gateway.example.com/v1 或 http://localhost:11434/v1"
                spellCheck={false}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </label>
            <label>
              模型 id
              <input className="mono" value={model} placeholder="例如 qwen2.5:14b" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
            </label>
            <div className="modal-hint">OpenAI Chat Completions 兼容接口。本地小模型可能无法正确使用工具。</div>
          </>
        ) : bedrock ? (
          <>
            <label>
              认证方式
              <select value={bedrockAuth} onChange={(e) => setBedrockAuth(e.target.value as BedrockAuth)}>
                <option value="account">应用里的账号凭证</option>
                <option value="apiKey">Bedrock API key（bearer token）</option>
              </select>
            </label>
            {bedrockAuth === 'account' && (
              <label>
                Bedrock 使用的账号
                <select value={bedrockAccountId} onChange={(e) => setBedrockAccountId(e.target.value)}>
                  <option value="" disabled>
                    请选择
                  </option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}（{a.accountId}）
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Bedrock region
              <select value={bedrockRegion} onChange={(e) => setBedrockRegion(e.target.value)}>
                {REGIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} · {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              模型 id
              <input
                className="mono"
                list="ai-bedrock-models"
                value={model}
                placeholder="从目录中选，或填推理配置文件 id / ARN"
                spellCheck={false}
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id="ai-bedrock-models">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </datalist>
            </label>
            <div className="modal-hint">
              {bedrockAuth === 'account'
                ? '凭证来自该账号的登录流程（可以和正在查询的账号不同），需要 bedrock:InvokeModel 和 bedrock:InvokeModelWithResponseStream 权限。'
                : 'API key 需要 bedrock:CallWithBearerToken 权限。'}
              us. / eu. / apac. / global. 等前缀是跨区域推理配置文件，要和 region 所在地区匹配。
            </div>
          </>
        ) : (
          provider && (
            <label>
              模型
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="" disabled>
                  请选择
                </option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name === m.id ? m.id : `${m.name}（${m.id}）`}
                  </option>
                ))}
              </select>
            </label>
          )
        )}
        {selected ? (
          <div className="modal-hint">
            {formatRates(selected.cost)} · 上下文 {Math.round(selected.contextWindow / 1000)}k
          </div>
        ) : (
          bedrock && model.trim() && <div className="modal-hint">价格未知：这个 id 不在模型目录里，费用不计入估算。</div>
        )}

        {provider && !accountAuth && (
          <>
            <label>
              API key 存储方式
              <select value={keyMode} onChange={(e) => setKeyMode(e.target.value as AiKeyMode)}>
                {KEY_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {keyMode === 'keychain' && config && !config.canPersistKey && (
              <div className="modal-hint">系统钥匙串不可用，key 只会保存在内存里，下次启动需要重新填写。</div>
            )}

            {keyMode === 'command' ? (
              <label>
                密钥命令（stdout 就是 key）
                <input
                  className="mono"
                  value={keyCommand}
                  maxLength={2000}
                  placeholder="security find-generic-password -s deepseek -w"
                  spellCheck={false}
                  onChange={(e) => setKeyCommand(e.target.value)}
                />
              </label>
            ) : (
              <label>
                <span>
                  API key <span className={'ai-key-status' + (keyStatus === '已设置' ? ' set' : '')}>{keyStatus}</span>
                  {keyStatus === '已设置' && (
                    <button className="link-btn" onClick={() => void clearKey()}>
                      清除
                    </button>
                  )}
                </span>
                <input
                  type="password"
                  className="mono"
                  value={key}
                  autoComplete="off"
                  placeholder={keyPlaceholder}
                  spellCheck={false}
                  onChange={(e) => setKey(e.target.value)}
                />
              </label>
            )}
          </>
        )}

        <div className="modal-hint">
          {bedrock
            ? `助手默认只读（可按账号允许它提出变更，每项需你确认）。提问时，账号名、region，以及工具查到的资源名、标签、日志等会发送到 Bedrock 账号在 ${bedrockRegion} 的 Amazon Bedrock，由所选模型处理，并受该账号的 Bedrock 设置约束（例如是否开启了模型调用日志）。跨区域推理配置文件（us. / eu. / global. 等）可能把请求路由到同一地理范围内的其他 region，global. 不限地理范围。AWS 凭证和 API key 不会发送给模型。`
            : '助手默认只读（可按账号允许它提出变更，每项需你确认）。提问时，账号名、region，以及工具查到的资源名、标签、日志等会发送给所选服务商；AWS 凭证和 API key 不会发送给模型。'}
        </div>

        <AiDataSettings config={config} onConfig={setConfig} onOpenAudit={() => setView('audit')} onDataDeleted={onDataDeleted} />

        {(error || result) && (
          <div className="federate-preview test-steps" aria-live="polite">
            {error && <div className="test-step fail">{error}</div>}
            {result && (
              <div className={`test-step ${result.ok && result.toolCalling ? 'ok' : 'fail'}`}>
                <span className="test-icon">{result.ok ? '✓' : '✗'}</span>
                <span>
                  {result.ok
                    ? `连接正常 · ${result.toolCalling ? '支持工具调用' : '模型没有调用工具，可能无法使用助手'} · ${result.latencyMs}ms`
                    : '连接失败'}
                </span>
                {result.error && <span className="test-detail">{result.error}</span>}
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="test" disabled={!provider || !model.trim() || testing || saving} onClick={() => void test()}>
            {testing ? (
              <>
                正在测试…
                <span className="spinner" />
              </>
            ) : (
              '测试连接'
            )}
          </button>
          <button onClick={() => onClose(config)}>取消</button>
          <button
            className="primary"
            disabled={!provider || !model.trim() || saving}
            onClick={() => void save().then((saved) => saved && onClose(saved))}
          >
            保存
          </button>
        </div>
          </>
        )}
      </div>
    </div>
  )
}
