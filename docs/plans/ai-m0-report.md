# AI 助手 M0（spike）报告

> 日期 2026-10-29。对应 [ai-assistant.md](ai-assistant.md) §16 M0。
> 环境：Linux 开发机，Node 22.23.4、npm 10.9.9。**不能启动 Electron**（没有图形界面，也不是 macOS），所以 Electron 运行时的行为只能靠构建产物、发布元数据、静态检查二进制来推断。下文凡是「未验证」的地方都会明说。

## 结论：Go，可以进入 M1

pi 方案没有否决项。`pi-telemetry` 不联网，打包可行，Node 版本满足，没有 native 依赖。M1 开头要先在 macOS 上补做几项本机做不了的实测，见文末「M1 开工前必须补的验证」。

---

## 1. 依赖安装与审查

**改动**：`package.json` 的 `dependencies` 加了 `"@earendil-works/pi-agent-core": "1.4.0"`、`"@earendil-works/pi-ai": "1.4.0"`，钉死版本，没有 `^`（`npm install --save-exact`）。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| ESM-only | ✅ 是。三个包都是 `"type": "module"`，`exports["."]` 只有 `types` 和 `import` 两个 condition | 读 `node_modules/@earendil-works/*/package.json` |
| engines | 三个包都是 `node >=22.19.0` | 同上 |
| 子路径导出 | pi-ai：`. ./models ./compat ./providers/* ./api/* ./utils/* ./oauth ./bedrock-provider ./bun-oauth` | 同上 |
| 传递依赖 | 80 个包，磁盘约 70 MB（作为对比，现有 `client-ec2` + `client-sts` 是 27 个包、23 MB） | `npm ls --all --json --omit=dev` 遍历 |
| native 模块 | ✅ **没有**：任何包里都没有 `binding.gyp` 或 `.node` 文件 | 同上，逐包扫描 |
| 安装脚本 | `@google/genai` 的 preinstall 是 `echo 'preinstall: no-op'`；`protobufjs` 的 postinstall 只打印版本方案警告，读过源码 | 同上 |
| License | MIT 39 · Apache-2.0 22 · BSD-3-Clause 11 · 0BSD 1 · Unlicense 1，全是宽松许可 | 同上 |
| 缺的可选 peer | `zod`、`@modelcontextprotocol/sdk`、`bufferutil`、`utf-8-validate`、`kerberos`、`@smithy/hash-node` 都没装，也用不上 | 同上 |

**附带影响（要知道的）：**
- `@aws-sdk/client-bedrock-runtime@3.1127.0` 让 npm 把共享包往上提了：`@aws-sdk/core` 3.977.9 → 3.978.7，`@smithy/core` 升到 3.37.0，lockfile 里一共变了 19 个包。现有的 `client-ec2` / `client-sts`（3.1116.0）现在用的是新版 core。版本在 semver 兼容范围内，现有测试全部通过，但真实 AWS 调用没有在这台机器上跑过。
- `npm audit`：10 条。其中 9 条在装 pi 之前就有（electron、vite、vitest、electron-builder 的依赖链）。新增的是 `undici@7.29.0`（high，`openai` 的可选 peer）。它**没有被打进 bundle**（`out/main` 里只在报错文案里出现这个词），但 electron-builder 会把它连同整个 pi 依赖树一起复制进 app（见 §2「体积」）。`npm audit fix` 能升级，M0 没动。

### pi-telemetry 审查（M0 的否决项）

读了 `@earendil-works/pi-telemetry@1.4.0` 的全部发布代码：`dist/*.js` 共 408 行，外加 `testing/`。

- 内容只有：接口类型、`NOOP_TELEMETRY_CONTEXT` / `NOOP_TELEMETRY_METRICS`、一个内存参考实现 `InMemoryTelemetryContext`、`renderTrace`（把 span 渲染成文本）、`createTypedMetrics`。
- `grep fetch|http|net|dgram|WebSocket|sendBeacon|child_process|fs|process.env` 一条都没命中（`testing/` 只 import 了 `node:assert`）。README 原话：「no exporter, global current-span state, or dependency on a telemetry backend」。
- pi-ai 怎么用它（`dist/telemetry.js`）：`observeModelRequest` 里 `options?.telemetry?.metrics ?? NOOP_TELEMETRY_METRICS`，**只有调用方显式传入 `telemetry` span 时才会写入**；pi-agent-core 从来不传（`grep telemetry` 只在 pi-ai 的 `types.d.ts` 里出现）。
- **结论：默认不联网，没有开关可关，也不需要环境变量。** 就算传了 span，数据也只进调用方自己提供的对象。

**应用侧的强制措施**（`src/main/ai/providers.ts`，pi 的唯一入口）：
1. `appStreamFn`：每个 LLM 请求都经过它，剥掉 `options.telemetry`。防的是将来 pi 版本变化，或者有人误传。
2. `APP_IDENTITY = { userAgent: 'short', attribution: null }`：**这是 M0 额外发现的问题。** pi-agent-core 默认 `DEFAULT_AGENT_IDENTITY = { attribution: PI_ATTRIBUTION }`，发往 OpenRouter 的请求会带 `HTTP-Referer: https://pi.dev`、`X-OpenRouter-Title: pi`、`X-OpenRouter-Categories: cli-agent`（发往 NVIDIA / OpenCode 也有对应的头）。pi-ai 默认的 `User-Agent` 是 `pi/1.4.0 (<platform>; node/<v>; <arch>)`。这些不是遥测，但会泄露客户端信息。`null` 能关掉经 merge 进来的 attribution（见 `utils/identity.d.ts` 的注释）。
3. `createAppModels()` 传入 `authContext: { env: () => undefined, fileExists: () => false }`：pi-ai 默认的 `AuthContext` 会读 `process.env.*_API_KEY`，还会探测凭证文件（如 `~/.aws`、gcloud ADC）。现在 key 只能从 `Agent.getApiKey` 传进来。
4. 默认的 `CredentialStore` / `ModelsStore` 本来就是内存实现（`InMemoryCredentialStore`），不写 `~/.pi`。

pi-ai 里其他会联网的地方（都只在显式调用时触发，应用不调用）：`models.refresh()`（例如 OpenRouter 的 `/models/user`）、各 OAuth 登录流程、`radius` provider 的 `/v1/config`。

**测试**：`src/main/ai/providers.test.ts` 用一个会记录调用的假 span：经过 `appStreamFn` 时它从未被调用，provider 收到的 options 里也没有 `telemetry`。对照组：同一个 span 直接交给 `models.streamSimple`，确实会被调用，说明断言不是空转。另有 identity 被强制、`DEEPSEEK_API_KEY` 环境变量被忽略的测试。

### 实际使用的 API 签名（来自发布包的 `.d.ts`）

```ts
// pi-ai
createModels(options?: { credentials?; modelsStore?; authContext?: AuthContext; identity?: ClientIdentity }): MutableModels
models.setProvider(p: Provider) · getModels(provider?) · getModel(provider, id) · getAuth(providerId | model, { apiKey? }?)
models.streamSimple(model, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream   // .result(): Promise<AssistantMessage>
createProvider({ id, auth: { apiKey?: { name, resolve({ ctx, credential, signal }) } }, models, api: openAICompletionsApi() })
deepseekProvider() / openaiProvider() / anthropicProvider() / googleProvider() / openrouterProvider()   // '@earendil-works/pi-ai/providers/<id>'
calculateCost(model, usage) · normalizeContext(context): TranscriptContext · Type（TypeBox 再导出）
fauxProvider({ provider?, models?, tokensPerSecond? }) → { provider, getModel(), setResponses([...]), state.callCount }   // 测试用，零网络

// pi-agent-core
new Agent({ initialState?: { systemPrompt, model, thinkingLevel, tools, messages }, streamFn, getApiKey?, identity?,
            beforeToolCall?, afterToolCall?, transformContext?, convertToLlm?, toolExecution?: 'sequential' | 'parallel', … })
agent.subscribe((event: AgentEvent, signal) => void) → unsubscribe
agent.prompt(text | AgentMessage[]) · continue() · followUp(msg) · steer(msg) · abort() · waitForIdle() · reset()
agent.state.{ model, tools, messages（可赋值）, systemPrompt（只读）, isStreaming, pendingToolCalls, errorMessage }
interface AgentTool<P> { name, label, description, parameters: P, execute(id, params, signal?, onUpdate?) → { content, details, isError?, terminate? } }
type StreamFn = (model, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<…>
```

和方案文档 §3 的差异：`Models` 有 `getModels` / `getAllModels`，可以列模型；`Context` 进 `StreamFn` 之前要先 `normalizeContext`，`TranscriptContext` 是 branded 类型；`tool_execution_end` 不带 `args`；DeepSeek 目录里的模型 id 是 `deepseek-flash` / `deepseek-v4-pro`，**没有 `deepseek-chat`**（方案 §4.1 的示例要改）。

### 模型目录与价格

`getModels(provider)` 实测：

| provider | 模型数 | 有价 | 样例（$/1M token，输入 / 输出 / 缓存读） | api |
| --- | --- | --- | --- | --- |
| deepseek | 2 | 2 | deepseek-flash 0.3 / 1.2 / 0.006，上下文 1M | openai-completions |
| openai | 42 | 42 | gpt-5 1.25 / 10 / 0.125 | openai-responses |
| anthropic | 17 | 17 | claude-sonnet-4-5 3 / 15 / 0.3 | anthropic-messages |
| google | 24 | 22 | gemini-2.5-pro 1.25 / 10 / 0.125 | google-generative-ai |
| openrouter | 401 | 377 | anthropic/claude-sonnet-4.5 3 / 15 / 0.3 | 混合 |

自定义 OpenAI 兼容 baseURL：`customOpenAiProvider({ baseUrl, modelId, contextWindow, maxTokens })` 已实现并测过（不填 key 也能解析出 auth，适合 Ollama）。❓ 单价准不准**没有**和各家官网核对（§15.1 决策 6 的「刷新价格」是 M4 的事）。

## 2. electron-vite 把 pi 打进主进程

**改动**（`electron.vite.config.ts`）：
```ts
main: { build: {
  externalizeDeps: { exclude: ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core'] },
  rollupOptions: { input: { index, 'ai-providers', 'ai-db', 'ai-keystore' } }   // 后三个是 M0 的临时入口
} }
```
pi 的传递依赖（openai、@anthropic-ai/sdk、@google/genai…）不在本项目的 `dependencies` 里，electron-vite 本来就会打包它们，不用再列。ai/* 的三个入口是临时的：M0 还没有任何运行时代码 import 它们，不加入口就会被摇树掉、证明不了能打包。M1 的 `service.ts` 从 `index.ts` 引入后就删掉（配置里有 `shortcut:` 注释）。

**证据**（`npm run build`）：
- 成功。`out/main` 共 4.0 MB：`ai-providers.js` 770 KB（pi 核心 + 五个 provider 定义），lazy chunk 有 `google-generative-ai` 1.4 MB、openai `client` 694 KB、`anthropic-messages` 564 KB、`openai-completions` 49 KB 等。Bedrock 没有被打进来（只导入了用到的 provider）。`index.js` 基本没变（65 KB）。
- `grep -rohE 'require\("[^"]+"\)' out/main`：除了 Node 内建模块、`electron`、已有的 `@aws-sdk/client-ec2` / `client-sts`，以及 bundle 内部的相对 chunk，**没有任何外部 require**，也没有 `@earendil-works`、`openai`、`@anthropic-ai`。唯一的动态 `import()` 是 pi 默认 AuthContext 里的 `import("node:fs/promises")`，是内建模块，而且应用已经替换掉那个 AuthContext。`require('google-auth-library')` 只出现在注释里。
- `ai-db.js` 里是 `require("node:sqlite")`，作为内建模块保留，没被打包器处理坏。

**Node 下的端到端冒烟**：`npm run ai-smoke`（`scripts/ai-smoke.mjs`）用 Node 的 type stripping 直接加载**真实的** `src/main/ai/providers.ts`，用 pi-ai 自带的 `fauxProvider`，不需要网络和 key，跑一个带 `whoami` 假工具的 Agent。实录事件序列：

```
agent_start → turn_start → message_start/end(user) → message_start
  → message_update: text_start, text_delta, text_end, toolcall_start, toolcall_delta, toolcall_end → message_end(assistant)
  → tool_execution_start · whoami {"verbose":true} → tool_execution_end · isError=false
  → message_start/end(toolResult) → turn_end
→ turn_start → message_start → text_start, text_delta×N, text_end → message_end(assistant) → turn_end → agent_end
run 2（第一个 text_delta 时 abort()）：… text_start → message_end → turn_end → agent_end，stopReason=aborted，保留了部分文本
network guard self-test blocked: fetch example.com
network attempts by pi: 0
```

脚本还断言：provider 收到的每个请求的 `options.telemetry === undefined`、`identity` 等于 `APP_IDENTITY`、`apiKey` 来自 `getApiKey`。`calculateCost` 按 $1 / $2 每百万 token 算出的 86 token 是 $0.0001。faux provider 自己不算费用，所以 usage 里的 cost 是 0。

**网络守卫**：在 pi 加载**之前**替换 `globalThis.fetch`、`net.Socket.prototype.connect`（http、https、undici、各 SDK 最终都走它）、`dns.lookup`、`dgram.createSocket`，所有拦截都计数。允许列表是空的。为了证明守卫不是空转，脚本最后自测一次 `fetch('https://example.com')`，确认会被拦下。

**未验证**：`npm run dev` / `npm start` / `npm run dist` 都需要启动 Electron 或在 macOS 上打包，本机做不了。bundle 在 Electron 里能不能 `require` 成功，只能从「产物里没有外部 require」来推断。

**体积问题（M1 要处理）**：pi 放在 `dependencies` 里，electron-builder 打包时会把 `node_modules` 里的生产依赖原样复制进 app。pi 已经打进 bundle 了，这约 70 MB（含 Bedrock SDK、`undici`）在 app 里是**用不到的重复内容**。可选做法：把两个 pi 包挪到 `devDependencies`（electron-vite 只 externalize `dependencies`，所以照样会打包，`exclude` 也就不需要了）；或者在 electron-builder 的 `files` 里排除。要在 macOS 上 `npm run dist` 之后量一下再定。M0 按指示保留在 `dependencies`。

## 3. 遥测：在入口处强制关闭

见 §1「应用侧的强制措施」和「测试」。总结：pi 本身就没有能联网的遥测；应用在唯一入口剥掉 `telemetry`、关掉 attribution、改短 User-Agent、屏蔽环境变量里的 key。vitest 断言了关闭状态（带对照组），冒烟脚本在守卫全开的情况下跑完整个流程，网络调用为 0。

约定：pi 的 API 只出现在 `providers.ts`（以及 M1 的 `service.ts`）里，Agent 只能通过 `createAppAgent` 创建。M1 可以考虑加一条测试：grep `src/` 里有没有别处 `new Agent(` 或 import pi-ai 的。

## 4. SQLite

| | `node:sqlite` | `better-sqlite3` |
| --- | --- | --- |
| Electron 43.4.1 | 内置 Node **24.18.1**（来源：releases.electronjs.org/release/v43.4.1）；不需要 flag；Electron 36 起修好了内建 sqlite（electron#47706，37.2.0 曾经回退过一次：#47671）；二进制里能 grep 到 `node:sqlite` ×5、`DatabaseSync` ×85、`v24.18.1` | 要按 Electron ABI 编译：electron-builder 默认 `npmRebuild: true` 能处理，但 `.node` 必须 `asarUnpack` |
| vitest（系统 Node 22.23） | 直接能用（SQLite 3.53.4，有 ExperimentalWarning） | 要按 Node ABI 编译，和给 Electron 编的那份冲突（经典的双 ABI 问题，得在两种构建之间来回 rebuild） |
| 打包 | 不需要额外配置；产物里就是 `require("node:sqlite")` | 要改 builder 配置，还要多一个 native 依赖 |
| 稳定性 | 实验性 API（Stability 1.1） | 成熟 |

**决定：`node:sqlite`。** 用接口隔离风险：`db.ts` 只依赖 `SqlDatabase`（`exec` / `prepare().run|get|all` / `close`），`DatabaseSync` 和 better-sqlite3 的 `Database` **原样**都满足，换驱动只改 `openAiDb` 一处。

**实现**：`src/main/ai/db.ts`
- `openAiDb(file = userData/ai.sqlite)`：先 `mkdir`，再 `journal_mode = wal`、`foreign_keys = on`，然后迁移。
- 迁移：`MIGRATIONS` 只追加；`pragma user_version` 记录版本；每一步在事务里执行，失败就 `rollback`。遇到比当前构建更新的库（降级）直接报错，不碰数据。
- 表结构按 §15.1：`conversations(id, account_id, title, created_at, updated_at)`、`messages(id, conversation_id → on delete cascade, role, content_json, tokens_in, tokens_out, created_at)`、`audit(id, t, type, account_id, data_json)`。
- `AiStore`：`createConversation` / `conversations` / `addMessage` / `messages` / `clearAccount` / `clearAll`（审计记录保留）/ `audit` / `auditEntries`。**所有写入先过 `redactSecrets`。**
- `src/main/ai/redact.ts`：`AKIA` / `ASIA` key id；`secret_access_key`、`SessionToken`、`X-Amz-Security-Token` 等「键名 + 值」写法；裸的 STS session token（`IQoJb3JpZ2lu…` / `FwoGZXIvYXdz…` 前缀）；`sk-…` 形式的 LLM key。替换文本里没有引号或反斜杠，脱敏后的 JSON 仍然合法。已知漏洞：没有键名的裸 40 位 secret key 抓不到（误伤太多），代码里有 `shortcut:` 注释。
- 测试（Node 下用真实 `node:sqlite`）：建库、重开不重复迁移、拒绝更新版本的库、失败迁移完全回滚、按账号清除并级联删除消息、审计保留、**读 sqlite 文件和 WAL 文件的原始字节，里面没有 key id 和 secret**。

**未验证**：`node:sqlite` 在打包后的 Electron 主进程里实际打开文件。M1 第一件事：在 macOS 上 `npm run dev` 时调一次 `openAiDb()`。

## 5. safeStorage

`src/main/ai/keystore.ts` 的 `KeyStore(crypto = safeStorage, file = userData/ai-keys.json)`：
- 注入的 `CryptoBackend` 就是 Electron `safeStorage` 的一个子集（`isEncryptionAvailable` / `encryptString` / `decryptString` / Linux 上的 `getSelectedStorageBackend`），测试里换成假的。
- `canPersist()`：加密可用，且后端不是 Linux 的 `basic_text`（硬编码口令，等于明文）。
- `set(id, key)`：在信任边界做校验（provider id 字符集；key 是单行可打印 ASCII，≤ 512），然后放进内存缓存；能落盘就写 base64 密文，不能落盘就**仅内存**，同时删掉文件里这个 provider 的旧密文，免得下次启动旧 key 又回来。返回 `{ ok, persisted }`。
- `has` / `delete` / `get`：`get` 只给主进程用，解密失败（Keychain 被重置、文件从别的机器拷来）就当作没有 key。
- `src/shared/ai.ts` 的 `AiKeysApi`：渲染进程能用的只有 `setKey` / `hasKey` / `deleteKey`，**没有读取**。M1 接 IPC。
- 测试：文件里只有密文；下次启动能解密；不可用或 `basic_text` 时退回内存，文件不存在；旧密文被清掉；删除；坏密文；非法输入。

**未验证**：macOS 上未签名的 dev 和 dist 构建，首次 `encryptString` 会不会弹 Keychain 授权、弹几次。需要 macOS 实测（方案 §15 的风险项仍然成立）。

## 6. 阻塞项与风险

| 项 | 状态 |
| --- | --- |
| pi-telemetry 联网 | ✅ 不联网，不是阻塞项 |
| native 模块 | ✅ 没有 |
| Electron 内置 Node 和 pi 的要求 | ✅ 24.18.1 ≥ 22.19.0，不冲突（版本来自发布元数据和二进制里的字符串，没有在 Electron 里跑 `process.versions`） |
| 开发机 Node 要求 | ⚠️ 测试和冒烟会加载 pi 和 `node:sqlite`，开发机要 **Node ≥ 22.19**（冒烟用的 type stripping 要 ≥ 22.18）。README 和 DEVELOPMENT 已更新。 |
| `node:sqlite` 是实验性 API | ⚠️ 有接口隔离，可以换成 better-sqlite3；每次升级 Electron 要跑一遍 db 测试，最好在 Electron 里也跑一次 |
| app 体积 | ⚠️ pi 依赖树约 70 MB，会被 electron-builder 重复打进 app（见 §2），M1 要处理 |
| 依赖变化 | ⚠️ `@aws-sdk/core` 等被提升到新版本；`undici` 有 audit 告警（没进 bundle） |
| pi 破坏性变更频繁 | 版本已钉死，pi API 只在 `providers.ts` 里出现，`ai-smoke` 和 `providers.test.ts` 就是升级时的回归闸 |

## M1 开工前必须补的验证（需要 macOS / 真实 key）

1. `npm run dev`、`npm start`、`npm run dist` 能启动；在主进程里打印 `process.versions.node`；在 Electron 里实际调用 `openAiDb()` 和 `createAppModels()`。
2. 量 `npm run dist` 产物的体积；决定 pi 挪到 `devDependencies`，还是用 builder 的 `files` 排除。
3. `safeStorage` 在未签名的 dev / dist 下的 Keychain 弹窗行为。
4. ⌘I 在 console 富文本编辑器里的冲突。
5. 用真实 DeepSeek key 和本地 Ollama 各跑一次流式 + 工具调用（M0 没有 key，网络策略也不允许，只用 faux provider 验证了 API）。最好抓包确认：请求里没有 `pi.dev` 相关的头，`User-Agent` 是 `pi`。

## M0 新增和改动的文件

- `package.json` / `package-lock.json`：pi 两个包（精确版本）、`npm run ai-smoke`
- `electron.vite.config.ts`：`externalizeDeps.exclude` 和临时的 ai/* 入口
- `src/main/ai/providers.ts` + test：pi 唯一入口（遥测、身份、环境变量 key 的锁定；内置 provider；自定义 OpenAI 兼容端点）
- `src/main/ai/db.ts` + test、`src/main/ai/redact.ts` + test
- `src/main/ai/keystore.ts` + test、`src/shared/ai.ts`
- `scripts/ai-smoke.mjs`
- `README.md`、`docs/DEVELOPMENT.md`：Node ≥ 22.19
- `docs/plans/ai-assistant.md`：❓ 项按实测结果更新
