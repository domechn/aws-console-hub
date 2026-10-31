import { useEffect, useRef, useState } from 'react'
import type { AccountKind, AwsAccount, ConnectionTestStep } from '../../../shared/types'
import { REGIONS } from '../../../shared/catalog'
import { AI_CHANGE_SERVICES, type Risk } from '../../../shared/ai'
import { allowWriteWarning } from '../ai'

interface Props {
  kind: AccountKind
  account: AwsAccount | null
  /** base accounts available as credential sources (assume kind only) */
  baseAccounts: AwsAccount[]
  onSave: (input: Partial<AwsAccount>) => void
  onClose: () => void
}

/** Same limit as main/credentialCommand.ts, which enforces it. */
const COMMAND_MAX_LENGTH = 2000

/** Shared across modal instances, so progress from a closed modal's run never matches a new one. */
let lastRunId = 0

const STEP_ICONS: Record<ConnectionTestStep['status'], string> = {
  pending: '○',
  running: '',
  ok: '✓',
  fail: '✗',
  skipped: '–'
}

export function AccountModal({ kind, account, baseAccounts, onSave, onClose }: Props): React.JSX.Element {
  const [name, setName] = useState(account?.name ?? '')
  const [accountId, setAccountId] = useState(account?.accountId ?? '')
  const [role, setRole] = useState(account?.role ?? '')
  const [command, setCommand] = useState(account?.command ?? '')
  const [viaId, setViaId] = useState(account?.viaId ?? baseAccounts[0]?.id ?? '')
  const [defaultRegion, setDefaultRegion] = useState(account?.defaultRegion ?? 'us-east-1')
  const [aiAllowWrite, setAiAllowWrite] = useState(account?.aiAllowWrite ?? false)
  const [production, setProduction] = useState(account?.production ?? false)
  // Absent = every service; the boxes start all ticked then.
  const [aiServices, setAiServices] = useState<string[]>(account?.aiServices ?? AI_CHANGE_SERVICES.map((s) => s.id))
  const [aiMaxRisk, setAiMaxRisk] = useState<Risk | ''>(account?.aiMaxRisk ?? '')
  const [testing, setTesting] = useState(false)
  const [steps, setSteps] = useState<ConnectionTestStep[] | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  /** Run whose results may still be shown; 0 once a relevant field changed. */
  const runRef = useRef(0)

  const isAssume = kind === 'assume'
  const idValid = /^\d{12}$/.test(accountId)
  const valid = idValid && role.trim().length > 0 && (isAssume ? viaId !== '' : command.trim() !== '')
  const via = baseAccounts.find((a) => a.id === viaId)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(
    () =>
      window.api.onTestProgress((id, s) => {
        if (id === runRef.current) setSteps(s)
      }),
    []
  )

  // A result only describes the values it was run with.
  useEffect(() => {
    runRef.current = 0
    setSteps(null)
    setTestError(null)
  }, [accountId, role, command, viaId, defaultRegion])

  const input = (): Partial<AwsAccount> => ({
    id: account?.id,
    kind,
    name: name.trim() || accountId,
    accountId,
    role: role.trim(),
    viaId: isAssume ? viaId : undefined,
    command: isAssume ? undefined : command.trim(),
    defaultRegion,
    aiAllowWrite,
    production,
    // Present-but-undefined clears the field in main ("all services", "no ceiling").
    aiServices: aiServices.length === AI_CHANGE_SERVICES.length ? undefined : aiServices,
    aiMaxRisk: aiMaxRisk || undefined
  })

  const submit = (): void => {
    if (valid) onSave(input())
  }

  const test = async (): Promise<void> => {
    const id = ++lastRunId
    runRef.current = id
    setTesting(true)
    setSteps(null)
    setTestError(null)
    try {
      const result = await window.api.testConnection(input(), id)
      if (runRef.current === id) setSteps(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (runRef.current === id) setTestError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setTesting(false)
    }
  }

  const failed = testError !== null || steps?.some((s) => s.status === 'fail')

  return (
    <div className="backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          {account ? '编辑' : '添加'}
          {isAssume ? '账号' : '基础账号'}
        </h2>

        {isAssume && baseAccounts.length === 0 ? (
          <p className="modal-hint">请先添加一个基础账号，跳转账号需要通过它获取基础凭证。</p>
        ) : (
          <>
            <label>
              显示名称
              <input
                value={name}
                placeholder={isAssume ? '例如：my-service-prod' : '例如：我的基础账号'}
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            {isAssume && (
              <label>
                通过哪个基础账号登录
                <select value={viaId} onChange={(e) => setViaId(e.target.value)}>
                  {baseAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}（{a.accountId} · {a.role}）
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label>
              {isAssume ? '目标 AWS 账号 ID' : 'AWS 账号 ID'}
              <input
                value={accountId}
                placeholder="12 位数字，例如 111111111111"
                className={accountId && !idValid ? 'invalid' : ''}
                onChange={(e) => setAccountId(e.target.value.trim())}
              />
            </label>

            <label>
              {isAssume ? '要 assume 的 Role 名称' : 'Role 名称（填进命令里的 {role}）'}
              <input
                value={role}
                placeholder={isAssume ? '例如 Admin / ReadOnly' : '例如 OrganizationAccountAccessRole / Admin'}
                onChange={(e) => setRole(e.target.value)}
              />
            </label>

            {!isAssume && (
              <>
                <label>
                  凭证命令
                  <input
                    className="mono"
                    value={command}
                    maxLength={COMMAND_MAX_LENGTH}
                    placeholder="aws configure export-credentials --profile myprofile --format process"
                    spellCheck={false}
                    onChange={(e) => setCommand(e.target.value)}
                  />
                </label>
                <div className="modal-hint">
                  命令在本机用你的登录 shell 运行，需在 stdout 输出 AWS CLI <code>credential_process</code> 格式的
                  JSON：<code>AccessKeyId</code>、<code>SecretAccessKey</code>、<code>SessionToken</code>、
                  <code>Expiration</code>（必须是临时凭证）。可用占位符 <code>{'{accountId}'}</code>{' '}
                  <code>{'{role}'}</code> <code>{'{region}'}</code>，也可读环境变量 <code>AWS_HUB_ACCOUNT_ID</code>{' '}
                  <code>AWS_HUB_ROLE</code> <code>AWS_HUB_REGION</code>。例如：
                  <br />
                  <code>aws configure export-credentials --profile myprofile --format process</code>
                  <br />
                  <code>my-credential-helper --account {'{accountId}'} --role {'{role}'}</code>
                </div>
              </>
            )}

            <label>
              默认 Region（快速跳转用）
              <select value={defaultRegion} onChange={(e) => setDefaultRegion(e.target.value)}>
                {REGIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} — {r.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={aiAllowWrite}
                onChange={(e) => {
                  const on = e.target.checked
                  if (on && !confirm(allowWriteWarning(name.trim() || accountId || '这个账号'))) return
                  setAiAllowWrite(on)
                }}
              />
              允许 AI 助手提出变更（每项需确认）
            </label>
            <div className="modal-hint">默认只读。打开后助手可以提出变更提案；每个提案都要你在面板里两步确认，应用才会用这个账号的凭证执行。</div>

            {aiAllowWrite && (
              <fieldset className="ai-policy">
                <legend>AI 策略</legend>
                <div className="ai-policy-services" role="group" aria-label="允许提出变更的服务">
                  {AI_CHANGE_SERVICES.map((s) => (
                    <label key={s.id} className="check">
                      <input
                        type="checkbox"
                        checked={aiServices.includes(s.id)}
                        onChange={(e) => setAiServices((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
                <label>
                  风险上限
                  <select value={aiMaxRisk} onChange={(e) => setAiMaxRisk(e.target.value as Risk | '')}>
                    <option value="">不限（破坏性操作也可以提出）</option>
                    <option value="high">最高「高」：不允许破坏性操作</option>
                    <option value="medium">最高「中」</option>
                    <option value="low">只允许「低」风险</option>
                  </select>
                </label>
                <div className="modal-hint">
                  只对勾选的服务提出变更；超过上限的提案直接被拒绝。上限按升级后的风险算（生产账号、env=prod 标签各升一级），确认时会再检查一次。
                </div>
              </fieldset>
            )}

            <label className="check">
              <input type="checkbox" checked={production} onChange={(e) => setProduction(e.target.checked)} />
              生产账号
            </label>
            <div className="modal-hint">AI 提出的变更风险升一级，确认时都要输入资源名。改动这一项后，还没确认的提案会作废。</div>

            {isAssume && idValid && role.trim() && (
              <div className="federate-preview">
                {`${via?.name ?? '?'} → assume arn:aws:iam::${accountId}:role/${role.trim()}`}
              </div>
            )}

            {(steps || testError) && (
              <div className="federate-preview test-steps" aria-live="polite">
                {testError && <div className="test-step fail">{testError}</div>}
                {steps?.map((s) => (
                  <div key={s.id} className={`test-step ${s.status}`}>
                    <span className="test-icon">
                      {s.status === 'running' ? <span className="spinner" /> : STEP_ICONS[s.status]}
                    </span>
                    <span>{s.label}</span>
                    {s.detail && <span className="test-detail">{s.detail}</span>}
                  </div>
                ))}
                {failed && !testing && <div className="test-note">测试未通过，仍可保存。</div>}
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          {!(isAssume && baseAccounts.length === 0) && (
            <button className="test" disabled={!valid || testing} onClick={() => void test()}>
              {testing ? (
                <>
                  正在测试…
                  <span className="spinner" />
                </>
              ) : (
                '测试连接'
              )}
            </button>
          )}
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={!valid} onClick={submit}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
