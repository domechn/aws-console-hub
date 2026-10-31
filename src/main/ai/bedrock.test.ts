import { describe, expect, it } from 'vitest'
import { bedrockResourceArns, explainBedrockError } from './bedrock'

const SONNET = 'anthropic.claude-sonnet-4-5-20250929-v1:0'

describe('explainBedrockError', () => {
  // Messages as pi formats them (formatBedrockError: "<prefix or exception name>: <AWS message>").
  it.each([
    [
      'AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/Dev/me is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0 because no identity-based policy allows the bedrock:InvokeModelWithResponseStream action',
      /缺少权限.*bedrock:InvokeModel 和 bedrock:InvokeModelWithResponseStream，资源 arn:aws:bedrock:us-east-1::foundation-model\/anthropic\.claude-sonnet-4-5-20250929-v1:0。/
    ],
    ["AccessDeniedException: You don't have access to the model with the specified model ID.", /Model access/],
    ['ResourceNotFoundException: Model use case details have not been submitted for this account.', /use case/],
    [
      `Validation error: Invocation of model ID ${SONNET} with on-demand throughput isn’t supported. Retry your request with the ID or ARN of an inference profile that contains this model.`,
      /推理配置文件（inference profile）id/
    ],
    ['Validation error: The provided model identifier is invalid.', /在 us-east-1 不可用.*us\. 前缀/],
    ['Throttling error: Too many requests, please wait before trying again.', /限流/],
    ['ExpiredTokenException: The security token included in the request is expired', /过期.*重新登录.*凭证命令/],
    ['UnrecognizedClientException: The security token included in the request is invalid.', /拒绝了 Bedrock 凭证/],
    ['getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com', /连不上 us-east-1 的 Bedrock 端点/]
  ])('%s', (message, hint) => {
    const out = explainBedrockError(message, SONNET, 'us-east-1')
    expect(out).toMatch(hint)
    // The original stays, for searching the AWS docs.
    expect(out).toContain(`原始错误：${message}`)
  })

  it('unwraps the auth-hook error pi wraps around a credential failure', () => {
    expect(explainBedrockError('API key auth failed for provider amazon-bedrock: Error: 凭证命令退出码 1', SONNET, 'us-east-1')).toBe('凭证命令退出码 1')
  })

  it('passes unknown errors through unchanged', () => {
    expect(explainBedrockError('Internal server error: boom', SONNET, 'us-east-1')).toBe('Internal server error: boom')
  })

  it('names the ARNs a policy needs when the message carries none', () => {
    expect(explainBedrockError('AccessDeniedException: denied', `us.${SONNET}`, 'us-west-2')).toContain(
      `arn:aws:bedrock:us-west-2:<账号 ID>:inference-profile/us.${SONNET}、arn:aws:bedrock:*::foundation-model/${SONNET}`
    )
  })
})

describe('bedrockResourceArns', () => {
  it('covers foundation models, cross-region profiles and ARNs', () => {
    expect(bedrockResourceArns(SONNET, 'eu-west-1')).toEqual([`arn:aws:bedrock:eu-west-1::foundation-model/${SONNET}`])
    expect(bedrockResourceArns(`global.${SONNET}`, 'us-east-1')).toEqual([
      `arn:aws:bedrock:us-east-1:<账号 ID>:inference-profile/global.${SONNET}`,
      `arn:aws:bedrock:*::foundation-model/${SONNET}`
    ])
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc'
    expect(bedrockResourceArns(arn, 'us-east-1')).toEqual([arn])
  })
})
