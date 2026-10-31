/** Bedrock error messages (as pi formats them: "<ExceptionName or prefix>: <AWS message>") → what to do, in Chinese. Pure. */
import { PROFILE_PREFIX_RE } from './providers'

/** The resource ARNs an IAM policy has to allow for `model` in `region`. */
export function bedrockResourceArns(model: string, region: string): string[] {
  if (model.startsWith('arn:')) return [model]
  const base = model.replace(PROFILE_PREFIX_RE, '')
  if (base === model) return [`arn:aws:bedrock:${region}::foundation-model/${model}`]
  // A profile routes to several regions; the foundation model must be allowed in each of them.
  return [`arn:aws:bedrock:${region}:<账号 ID>:inference-profile/${model}`, `arn:aws:bedrock:*::foundation-model/${base}`]
}

const RULES: { test: RegExp; explain: (m: string, model: string, region: string) => string }[] = [
  {
    test: /don't have access to the model|access to the model with the specified model ID/i,
    explain: () => '这个账号还没有开通该模型的访问权限：在 Bedrock 控制台的「Model access」里为它申请访问（部分模型需要先在 Marketplace 订阅）。'
  },
  {
    test: /use case details/i,
    explain: () => '首次使用 Anthropic 模型需要先在 Bedrock 控制台提交用例（use case）表单。'
  },
  {
    test: /AccessDenied|not authorized to perform/i,
    explain: (m, model, region) => {
      const arn = /on resource: (arn:\S+)/.exec(m)?.[1].replace(/[.,]$/, '')
      const arns = arn ? [arn] : bedrockResourceArns(model, region)
      return `Bedrock 使用的账号缺少权限：需要允许 bedrock:InvokeModel 和 bedrock:InvokeModelWithResponseStream，资源 ${arns.join('、')}。`
    }
  },
  {
    test: /on-demand throughput isn.t supported|inference profile/i,
    explain: () => '这个模型不支持按需（on-demand）直接调用，请改用推理配置文件（inference profile）id，例如在模型 id 前加 us. / eu. / apac. / global. 前缀。'
  },
  {
    test: /provided model identifier is invalid|model identifier|ResourceNotFound/i,
    explain: (_m, model, region) =>
      `模型 ${model} 在 ${region} 不可用或 id 有误。请确认 Bedrock region 和模型匹配：us. 前缀的推理配置文件要在美国区域调用，eu. 在欧洲区域，apac. 在亚太区域。`
  },
  {
    test: /ExpiredToken|security token included in the request is expired|token.*expired/i,
    explain: () => 'Bedrock 凭证已过期：请重新登录 Bedrock 使用的账号，或检查它的凭证命令能否输出新的凭证（用 API key 时请换一个新 key）。'
  },
  {
    test: /UnrecognizedClient|security token included in the request is invalid|InvalidSignature|signature we calculated/i,
    explain: () => 'AWS 拒绝了 Bedrock 凭证（无效或签名不匹配）：请重新登录 Bedrock 使用的账号、检查凭证命令（或 API key），并确认本机时间准确。'
  },
  {
    test: /Throttling|Too many (requests|tokens)|rate exceeded|ServiceQuotaExceeded/i,
    explain: (_m, _model, region) => `Bedrock 限流了（${region} 的请求数或 token 配额已用完）：稍后再试，或在 Service Quotas 申请提高配额。`
  },
  {
    test: /ENOTFOUND|getaddrinfo|UnknownEndpoint|Could not resolve endpoint/i,
    explain: (_m, _model, region) => `连不上 ${region} 的 Bedrock 端点：请确认这个 region 提供 Bedrock，或检查网络和代理设置。`
  },
  {
    test: /data retention mode/i,
    explain: () => '这个模型不支持账号当前的 Bedrock 数据保留设置，请在 Bedrock 控制台调整，或换一个模型。'
  }
]

/** pi wraps errors thrown from the auth hook (the account's credential pipeline); the cause is what the user needs. */
const AUTH_WRAPPER_RE = /^API key auth failed for provider amazon-bedrock: (Error: )?/

export function explainBedrockError(message: string, model: string, region: string): string {
  const raw = message.replace(AUTH_WRAPPER_RE, '')
  const rule = RULES.find((r) => r.test.test(raw))
  return rule ? `${rule.explain(raw, model, region)}\n原始错误：${raw}` : raw
}
