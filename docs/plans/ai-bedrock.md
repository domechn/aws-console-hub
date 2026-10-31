# AI 助手：AWS Bedrock provider

> 日期 2026-10-29。M1（[ai-m1-report.md](ai-m1-report.md)）之后的增量：在 AI 设置里加「AWS Bedrock」。
> 环境同 M1：Linux 开发机，没有 AWS 凭证，**没有对真实 Bedrock 发过请求**。

## pi 源码调研（`@earendil-works/pi-ai@1.4.0`，读的是发布包的 `.d.ts` 和 `dist/*.js`）

| 项 | 结论 | 出处 |
| --- | --- | --- |
| provider | `amazonBedrockProvider()`，id `amazon-bedrock`，api `bedrock-converse-stream`（ConverseStream） | `providers/amazon-bedrock.js` |
| 模型目录 | 193 个 chat 模型，全部有价（$/1M token）。id 原样是 Bedrock 的 modelId：基础模型 `anthropic.claude-…`，跨区域推理配置文件 `us.` / `eu.` / `apac.` / `au.` / `ca.` / `jp.` / `in.` / `global.` / `us-gov.` 前缀。各前缀的价格不同（地区版一般贵 10%）。`baseUrl` 只有 `us-east-1` 和 `eu-central-1` 两种 | `providers/data/amazon-bedrock.json` |
| pi 自带的 auth | `resolve` 依次看：已存的 key（bearer）→ `AWS_BEARER_TOKEN_BEDROCK` → `AWS_PROFILE` → `AWS_ACCESS_KEY_ID`/`SECRET` → ECS 容器凭证 → web identity token。都没有就 `undefined` | 同上 |
| stream 读环境 | `bedrock-converse-stream.js` **直接**读 `process.env`（`getProviderEnvValue`：请求级 `options.env` 优先，再 `process.env`）：`AWS_REGION`、`AWS_PROFILE`、`AWS_ACCESS_KEY_ID`/`SECRET`/`SESSION_TOKEN`、`AWS_BEARER_TOKEN_BEDROCK`、`AWS_BEDROCK_SKIP_AUTH`、`AWS_BEDROCK_FORCE_HTTP1`、代理变量。拿到 key 对时设成 SDK 的显式 `credentials`；否则 SDK 走默认凭证链（`~/.aws`、SSO、实例角色） | `api/bedrock-converse-stream.js` |
| bearer token | 支持：`options.bearerToken \|\| options.apiKey \|\| env AWS_BEARER_TOKEN_BEDROCK` → `config.token` + `authSchemePreference: ['httpBearerAuth']`，发 `Authorization: Bearer`。需要 `bedrock:CallWithBearerToken` | `bedrock-converse-stream.d.ts` 的 `BedrockOptions.bearerToken` |
| AWS SDK 自己 | `@aws-sdk/client-bedrock-runtime@3.1127.0`：`AWS_BEARER_TOKEN_BEDROCK` 在 `process.env` 里时自动偏好 bearer；`AWS_AUTH_SCHEME_PREFERENCE`（或 `~/.aws/config` 的 `auth_scheme_preference`）选到 bearer 时，身份从 env 或 SSO token 缓存（`nodeProvider`）取 | `@aws-sdk/core` httpAuthSchemes、client 的 runtimeConfig |
| region | ARN 里的 region > `options.region` > `AWS_REGION` / `AWS_DEFAULT_REGION` > 默认 `us-east-1`。给了 region 时不钉目录里的标准 endpoint | 同上 |
| 工具调用 | Converse 的 `toolConfig`；目录里的 Claude 等标了 `compat.supportsStrictMode` | 同上 |
| 打包 | `api/bedrock-converse-stream.lazy.js` 用**变量** specifier `import()`，打进 bundle 后相对路径就不存在了；`./bedrock-provider` 子路径（`bedrockProviderModule`）是给打包用的静态入口 | `bedrock-converse-stream.lazy.js` 注释 |
| 错误文本 | `formatBedrockError`：`InternalServerException` 等五种映射成 `Internal server error:` / `Validation error:` / `Throttling error:` …，其余是异常名（`AccessDeniedException: …`）；auth hook 抛的错被包成 `API key auth failed for provider amazon-bedrock: <原因>` | `bedrock-converse-stream.js`、`utils/models-error.js` |

## 设计

- **不注册 pi 的 `amazonBedrockProvider()`**，`providers.ts` 的 `bedrockProvider({ region, credentials? })` 用同一份目录，API 走 `lazyApi(() => import('@earendil-works/pi-ai/bedrock-provider'))`（打包后是懒加载的 `bedrock-provider-*.js` chunk，约 466 KB）。
- **账号模式（默认）**：AI 设置里选「Bedrock 使用的账号」（`bedrockAccountId`，可以不是正在查询的账号）。auth 的 `resolve` 在 pi 每次发 LLM 请求前调用（`Models.applyAuth`），它调 `index.ts` 的 `accountCredentials` → `getAccountCredentials`（凭证命令 / AssumeRole，同一份内存缓存，快过期时续），返回请求级 `env`：`AWS_REGION` + 三个凭证变量。pi 用它们设显式 `credentials`，所以默认凭证链不会运行。凭证离过期不足 60 秒时直接报错，不发请求。凭证只在这一次调用的参数里，不进配置、日志、IPC、模型。
- **API key 模式**：`bedrockAuth: 'apiKey'`，key 存在现有的 `KeyStore`（provider id `amazon-bedrock`，加密 / 内存 / 密钥命令三种都能用）。key 上限从 512 提到 4096（短期 key 是 base64 的预签名 URL）。`redactSecrets` 增加 `ABSK…` / `bedrock-api-key-…` 两种形态。
- **环境锁定**：`createAppModels()` 调 `lockAmbientBedrockAuth()`：删 `AWS_BEARER_TOKEN_BEDROCK`、`AWS_BEDROCK_SKIP_AUTH`，设 `AWS_AUTH_SCHEME_PREFERENCE=sigv4`（环境变量优先于 `~/.aws/config`）。API key 模式下 pi 显式设置 `authSchemePreference`，不受影响。这会改主进程的 `process.env`，凭证命令的子进程也会继承，对只用 SigV4 的服务没有影响。
- **region**：`bedrockRegion`，默认 `us-east-1`，只能从 `REGIONS`（15 个）里选，和 console 的 region 无关。
- **模型**：输入框 + `datalist`（目录里的 193 个，可直接手填）。目录里没有的 id（其他推理配置文件、application inference profile ARN）由 `bedrockModel()` 临时构造：去掉地区前缀后能在目录里找到同一模型时借用它的上下文 / 输出上限 / 能力，否则 128k / 8k；**不注册**，所以 `getModel` 查不到价格，费用合计带 `costUnknown`，面板显示「价格未知」或「部分价格未知」，设置里显示「价格未知：不计入估算」。
- **配置**：`AiConfig` v2 增加 `bedrockAuth`、`bedrockAccountId`、`bedrockRegion`；v1 文件读入时补默认值。`ai:config-save` 校验账号存在、region 在列表里。`ai:config-get` 在账号已删除时把 `bedrockAccountId` 报成 `null`，面板就回到「还没有配置」的引导。就绪条件：provider + 模型 +（账号模式下有账号，API key 模式下有 key）。
- **错误**：`bedrock.ts` 的 `explainBedrockError(message, model, region)` 在原文前加一句中文处理建议，原文保留。覆盖：缺 `bedrock:InvokeModel` / `InvokeModelWithResponseStream`（优先用报错里的资源 ARN，没有时按模型推算：基础模型 `arn:aws:bedrock:<region>::foundation-model/<id>`；推理配置文件 `arn:aws:bedrock:<region>:<账号 ID>:inference-profile/<id>` 加 `arn:aws:bedrock:*::foundation-model/<基础 id>`）、模型未开通、Anthropic 用例表单、on-demand 不支持（改用推理配置文件）、模型 id 无效 / region 不匹配、限流、凭证过期、凭证无效 / 签名不匹配、endpoint 解析失败、数据保留模式。用在「测试连接」、面板里存下的错误、toast。
- **隐私文案**：数据发到 Bedrock 账号在所选 region 的 Bedrock，受该账号的 Bedrock 设置约束（例如模型调用日志）；跨区域推理配置文件可能路由到同一地理范围的其他 region，`global.` 不限地理范围。没有写「数据不出账号」之类的保证。

## 测试

- `bedrock.test.ts`：错误映射表（9 类错误 + 解包 auth hook 的错 + 未知错误原样 + 推算 ARN）。
- `providers.test.ts`「Bedrock」：
  - 目录含 `us.` / `eu.` / `global.` id 且有价。
  - `resolve` 每次请求都问凭证管线（第二次拿到续期后的凭证），`console.*` 里没有凭证；快过期的凭证被拒；没有凭证也没有 key 时是「未配置」。
  - `lockAmbientBedrockAuth` 的效果。
  - 目录外的 id：价格为 0 且不注册、借用匹配模型的上限、ARN 用默认值。
  - **真实的 pi Bedrock stream + AWS SDK** 打到本机的 h2c 假 endpoint（宿主机放了环境变量 key、bearer token、`AWS_SHARED_CREDENTIALS_FILE`）：请求的 SigV4 `Credential=` 是账号的 key id、`x-amz-security-token` 是账号的 token，请求头里没有宿主机的任何凭证；403 `AccessDeniedException` 经 `explainBedrockError` 得到带确切 ARN 的提示。对照：锁定之后再放回 `AWS_BEARER_TOKEN_BEDROCK`，请求就变成 `Bearer host-bearer-token`，说明锁定是必要的。API key 模式发 `Authorization: Bearer <key>`。没有凭证时请求数为 0（不会退回默认凭证链）。
- `service.test.ts`：保存时校验账号 / region；缺账号、缺 key 的提示；凭证在「测试连接」时才取、每次都取，管线的错误原样带到用户面前（去掉 pi 的英文包装）。
- `config.test.ts`：v1 → v2 迁移；Bedrock 字段校验；配置文件里没有凭证。
- `history.test.ts`、`ai.test.ts`：`costUnknown`、「价格未知」文案、Bedrock 的就绪条件。

## 没能验证的

1. **没有对真实 Bedrock 发过请求**（没有凭证）。签名、端点、错误解析只对本机假 endpoint 验证过；真实错误文本是按 AWS 文档和 pi 源码写的规则，个别措辞可能对不上，对不上时只显示原文。
2. 成功的流式回复（eventstream 编码）、工具调用、Claude 的 thinking / prompt cache 在 Bedrock 上的表现没跑过；只验证了请求能正确签名、错误能回来。
3. 目录价格没和 AWS 官网核对；价格是 pi 目录里的（按 id 区分地区前缀，不按调用的 region 区分）。
4. 打包后在 Electron 里懒加载 `bedrock-provider-*.js` 没实测（和已有的 Anthropic chunk 同一种结构）。
5. `AWS_PROFILE` 在宿主机环境里时，pi 仍会把它设成 SDK 的 `profile`，SDK 可能从 `~/.aws/config` 读这个 profile 的非凭证设置（重试、FIPS / dualstack、`endpoint_url`）。凭证仍是账号的（显式 `credentials` 优先），但 `endpoint_url` 之类的设置会生效。应用里其他 AWS SDK client 也是这样，这次没改。
6. 运行中改了 Bedrock 账号 / region：正在进行的对话的后续请求会用新设置（provider 是全局注册的）。

## macOS 手工验收

1. AI 设置 → AWS Bedrock：账号下拉列出所有账号，region 默认 `us-east-1`，模型输入框能下拉目录也能手填；API key 字段只在「Bedrock API key」模式下出现。
2. 选一个开通了 Bedrock 的账号和 `us.anthropic.claude-…`，「测试连接」→ 支持工具调用。换成没权限的账号 → 中文提示里有资源 ARN；换成基础模型 id（无 `us.`）→ 提示改用推理配置文件；region 改成 `eu-west-1` 而模型是 `us.` → 提示 region 不匹配。
3. 让 Bedrock 账号的凭证过期（或改坏凭证命令）→ 提示重新登录；正常凭证下聊一个超过凭证剩余时间的对话，确认后半段仍然成功（凭证被续）。
4. 手填一个目录里没有的 application inference profile ARN → 设置里「价格未知」，面板用量显示「价格未知」。
5. 删除 Bedrock 使用的账号 → 面板回到「还没有配置」，设置里账号是「请选择」。
6. `grep -r ASIA ~/Library/Application\ Support/aws-console-hub/ai-config.json` 无结果。
