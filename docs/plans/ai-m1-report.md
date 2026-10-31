# AI 助手 M1（只读聊天）报告

> 日期 2026-10-29。对应 [ai-assistant.md](ai-assistant.md) §16 M1。
> 环境：Linux 开发机，Node 22.23.4。**没有启动 Electron**，也没有真实 LLM key 和 AWS 账号，所以界面、真实模型和真实 AWS 调用都没跑过（见文末）。

## 结论

代码完成：`npm run typecheck`、`npm test`（24 个文件，239 个测试）、`npm run build`、`npm run ai-smoke` 全部通过。M1 的验收条目要在 macOS 上用真实 key 和 sandbox 账号走一遍，清单见文末。

## 做了什么

### 1. AI 设置（`components/ai/AiSettings.tsx`，`main/ai/config.ts`）

- 服务商：DeepSeek、OpenAI、Anthropic、Google、OpenRouter、OpenAI 兼容（自定义 baseURL）。模型下拉来自 pi 的目录（`getModels`），选中后显示目录单价和上下文长度。自定义端点手填模型 id 和 baseURL（远程必须是 `https://`，`http://` 只允许 localhost / 127.0.0.1 / [::1]，不能带用户名密码）。
- API key：只写。界面只显示「已设置 / 未设置」，`ai:config-get` 只返回 `hasKey`。三种存储方式：加密保存（safeStorage，默认；不可信时自动只放内存，界面有提示）、仅本次运行、密钥命令（复用凭证命令的登录 shell 和 PATH 探测，stdout trim 后就是 key，每次运行跑一次）。切换存储方式时会搬动当前 key（切到「仅内存」立刻从磁盘删掉）。
- 「测试连接」：先保存，再发一条极短的请求，要求模型调用 `ping` 工具，报告成败、是否支持工具调用和延迟。prompt 里没有账号数据，错误信息先脱敏、再按值去掉 key。
- 非机密配置存在 `userData/ai-config.json`（provider、model、baseUrl、keyMode、keyCommand），`mergeAiConfig` 逐字段校验，未知字段丢弃。

### 2. 聊天面板（`components/ai/AssistantPanel.tsx`、`Markdown.tsx`、`renderer/src/ai.ts`）

- `.console-slot` 改成横向 flex：`.console-column`（搜索条 + `.console-view` + 最近访问条）加右侧 `<aside class="ai-panel">`。console view 靠已有的 `ResizeObserver` 变窄，主进程布局没改。
- 顶栏最右 `✦ AI` 按钮（打开时高亮）和 `⌘I`：`shortcuts.ts` 加了 `{ kind: 'assistant' }`（纯函数，有测试），console 有焦点时主进程拦截后发 `assistant:toggle` 并把焦点交给主界面；渲染进程 keydown 也处理。收起时经新的 `console:focus` 把焦点还给 console。
- 流式文本、工具进度（「正在查询 EC2 实例…」→「✓ 查询 EC2 实例 · 3 台」）、停止按钮（`esc` 在生成中也是停止）、跟随到底（用户往上翻时不跟）。`↵` 发送，`⇧↵` 换行，输入法组字时的回车不发送。
- markdown：`react-markdown` 10.1.0 + `remark-gfm` 4.0.1（devDependencies，打进渲染进程 bundle），`skipHtml`、不渲染图片、只有 http(s) 链接可点；点击走 `ai:open-link`，console 页面在当前账号打开，其他 AWS 域名开新标签页，其他网站交给系统浏览器（沿用现有开窗策略）。
- 每个账号一组对话：下拉切换、新建、重命名、删除、清空；在跑的对话前面有 ●，切走后在后台跑完。底部显示本对话的 token 和估算费用。
- 空状态：没选账号时提示选账号；没配置时引导去设置，并说明数据会发给所选服务商；空对话给出几个示例问题。
- 面板宽 320–640px，拖左边缘（或聚焦后 ← →）调整，存在 `localStorage` 的 `aiPanelWidth`。设置弹窗打开时隐藏 console view。

### 3. Agent 服务（`main/ai/service.ts`）

- 每次发消息建一个 pi `Agent`（只通过 `providers.ts` 的 `createAppAgent`），用 SQLite 里该对话的完整记录加新算的 system prompt（`prompt.ts`：账号名 / id / role / 类型、当前 region、只读、时间、围栏说明）。这样每轮的账号和 region 都是新的，也避开了 pi 的 `systemPrompt` 构造后只读的限制。
- 对话绑定账号：工具闭包捕获创建时的账号，IPC 每次检查对话属于传入的账号。region 默认取该账号当前标签页 URL 的 `region=`，否则用账号默认 region。
- 上下文压缩（`context.ts`）：最近 20 轮完整，更早的工具结果换占位；超过模型上下文 60% 时先占位最老的结果，再丢最老的整轮。
- 硬限额：每条消息 15 次工具调用、8 轮带工具的往返、整个运行 5 分钟；单次 AWS 调用 20 秒、最多重试 1 次；结果 ≤ 12 KB。超限时停下，并在面板里说明原因。
- abort：停止按钮 → `agent.abort()`，同一个 signal 中止 AWS 调用。已收到的部分保留，标「已停止」。
- 错误：provider 错误记在对话里（那条回复显示错误）并 toast；运行前的配置错误（没 key、没选模型）由 `ai:send` reject，面板就地显示并把输入还给用户，同时 toast。
- AWS 凭证走已有的 `getAccountCredentials`（同一份内存缓存）；凭证失败时同时 toast。凭证和 key 都不进渲染进程，也不进模型上下文。

### 4. 只读工具（`main/ai/tools.ts`、`aws.ts`、`classify.ts`、`shape.ts`）

- 11 个工具：`aws_whoami`、`list_ec2_instances`、`describe_ec2_instance`、`list_s3_buckets`、`list_lambda_functions`、`list_rds_instances`、`list_log_groups`、`get_metrics`（GetMetricData，降采样 + sum/min/max/avg）、`query_logs`（Logs Insights，≤ 5 组 / 72 小时 / 200 行 / 30 秒，超时会 `StopQuery`）、`cost_summary`（GetCostAndUsage，每对话 ≤ 10 次，工具描述里写明收费）、`aws_read`（通用只读）。
- `aws_read` 的分类：敏感读取精确表 → 拒绝（`GetSecretValue`、`ssm:GetParameter(s)`、`kms:Decrypt`、`GetPasswordData`、`s3:GetObject`、`lambda:GetFunction`、DynamoDB 表数据、日志内容等）；服务白名单之外 → 拒绝；`sts` 只放行 `GetCallerIdentity`；`Describe/List/Get/Head/Lookup/Search/BatchGet*` 放行；其他（包括全部写操作）→ 拒绝。被拒的调用写审计 `tool_refused`。
- **AWS 调用方式的决定**：用 SDK v3 的各服务 client，没有写「签名 + 通用 JSON/Query 调用器」。白名单里的服务横跨 Query/XML（EC2、RDS、IAM、CloudFormation）、JSON（Logs、ECS、DynamoDB、CE）、REST-JSON（Lambda）、REST-XML（S3）四种协议，自写意味着 XML 解析加四套序列化，代码更多、更容易错。新加 10 个包（`client-s3/lambda/rds/cloudwatch/cloudwatch-logs/cost-explorer/ecs/dynamodb/cloudformation/iam`，都钉 `3.1116.0`），主进程 externalize，`out/main` 仍是 4.0 MB。按服务第一次用到时才 `require`：Rollup 默认把外部包的 `import()` 留成原生 ESM `import()`，我加了 `rollupOptions.output.dynamicImportInCjs: false`，让它编译成懒 `require()`，构建产物里已确认。M0 的临时 `ai-*` 构建入口已删除。
- 结果整形：去 `$metadata`，按键名脱敏（password / secret / accesskey / sessiontoken / userdata / credential…），环境变量只留名字，去控制字符和 ANSI 转义，逐级裁剪到 12 KB，带 `truncated` / `total` / `nextToken`，再整体过 `redactSecrets`。最后放进 `<aws_data source region>` 围栏，前面一行写「不可信内容」，数据里的 `<` 一律转义，伪造不了围栏。
- region 参数按 `catalog.ts` 的 15 个 region 校验；IAM / STS / CE 固定 `us-east-1`。
- 账号「允许 AI 助手提出变更」：`AwsAccount.aiAllowWrite`（默认没有 = false），`AccountModal` 里有勾选框，`AccountStore` 校验为布尔，不进 `identity()`。这一版只保存，工具集不看它。

### 5. IPC（`main/ai/ipc.ts`、`validate.ts`、`shared/api.ts` 的 `AiApi`、preload）

固定的 14 个 channel：`ai:config-get/config-save/key-set/key-clear/models/test/conversations/history/send/abort/rename/delete/clear/open-link`，外加 `ai:event`、`assistant:toggle`、`console:focus`。参数逐个校验（id 字符集和长度、消息 ≤ 8000、标题单行 ≤ 100、key 单行可打印 ≤ 512、provider 在列表里），只接受主界面的 `webContents`。没有通用 invoke，没有任何 channel 返回 key。渲染进程 CSP 加了显式的 `connect-src 'self'`（原来由 `default-src 'self'` 隐含）；渲染进程 bundle 里没有 pi、AWS SDK、`safeStorage` 和 `getApiKey`（已 grep）。

### 6. 审计

SQLite `audit` 表：每次工具调用一条 `tool_call`（工具、参数摘要 ≤ 300 字、region、成败、耗时、截断的错误、所属对话），被拒的再记 `tool_refused`。不记结果正文和 key（有测试断言资源名不在审计里）。写入经 `redactSecrets`。

### 7. 存储

`ai.sqlite` 存完整的 pi 消息（工具结果是已裁剪、已脱敏的围栏文本）。写入前 `redactSecrets`，再按值去掉当前 key（应对 `AIza…` 这类没有固定前缀的 key），新对话的标题也一样处理。删除账号时一并删除它的对话，审计保留。库打不开时不碰文件，本次改用内存库并 toast。`db.ts` 新增 `conversationAccount`、`renameConversation`、`deleteConversation`；`KeyStore.set` 加了 `persist` 参数（仅内存模式）。

## 自动化验证

| 测试文件 | 覆盖 |
| --- | --- |
| `classify.test.ts` | 表驱动：20 个放行、20 个敏感被拒、31 个拒绝（写操作、未知动词、白名单外服务、畸形名称）；`Filter*` 只限 logs；CE 不在通用工具里 |
| `shape.test.ts` | 键名脱敏、环境变量、日期 / bigint / 字节、ANSI；裁剪后 ≤ 12 KB 且标注、翻页游标、超宽对象；自由文本里的 key id；围栏不能被关闭或伪造，解析后数据不变 |
| `context.test.ts` | 不压缩、旧结果占位、超预算先占位再丢轮、保留 system 和最新一轮 |
| `history.test.ts` | 费用和 pi 的 `calculateCost` 一致、按消息自己的模型计价；显示项不含工具结果正文、中断的工具调用 |
| `tools.test.ts` | 工具集里没有写类工具；EC2 投影 + 围栏 + 审计；region 校验；`aws_read` 放行 / 拒绝时不调 AWS；CE 次数上限；指标汇总；Logs Insights 轮询；AWS 错误码透传 |
| `service.test.ts` | pi faux provider 端到端：工具调用 → 围栏结果 → 回答，system prompt 含账号 / region / 只读，审计；key 不出现在事件、历史、配置视图、数据库；abort 保留部分回复；8 轮上限；15 次调用上限；敏感读取被拒且 AWS 没被调用；没 key 时 reject 且不建对话；对话按账号隔离、重命名、清空；provider 错误进记录、toast 里没有 key；运行中删除对话不报错；切换 key 存储方式时搬动 key |
| `config.test.ts` / `validate.test.ts` | 配置合并与拒绝项、baseURL 规则、JSON 持久化；IPC 参数校验 |
| `providers.test.ts` | `resolveModel`（目录 / 自定义端点）、`listModels`、`testModel`（faux：成功带工具调用、401 错误）；**pi 只被 providers / service / tools import，只有 providers.ts 里有 `new Agent(`** |
| `Markdown.test.tsx` / `ai.test.ts` | 原始 HTML、`<script>`、`<img>`、`<iframe>`、`javascript:` / `file:` / `data:` 链接都不生效，GFM 表格正常；面板事件合并、就绪判断、用量 / 价格格式 |
| 已有测试扩展 | `shortcuts`（⌘I / Ctrl+I / 非拉丁布局）、`urls`（`consoleRegion`）、`accounts`（`aiAllowWrite`）、`keystore`（仅内存）、`db`（重命名 / 删除 / 归属） |

`npm run ai-smoke` 新增第 3 段：在断网守卫下，通过真实的 `providers.ts` 跑「测试连接」，断言没有遥测 span、identity 被强制、网络调用为 0。

## 没能验证的

1. **界面没跑过**。面板布局、console view 变窄、拖宽（尤其是拖进原生 view 上方时指针事件是否还归面板：macOS 上 mouseDown 所在的 view 会继续收到拖动事件，按理没问题，但没实测）、⌘I 在 console 富文本编辑器里的冲突、焦点归还、设置弹窗，全部要你在 GUI 里测。
2. **Electron 里的运行时**：`node:sqlite` 在 Electron 主进程里打开 `ai.sqlite`（M0 遗留项）、打包后的懒 `require('@aws-sdk/client-*')`、safeStorage 在 macOS 上的 Keychain 弹窗。我没有启动 Electron（启动需要权限确认，而且你说会自己测）。
3. **真实 LLM**：没有 key，没有对任何 provider 发过真请求；DeepSeek / OpenAI / Anthropic / Gemini / OpenRouter / Ollama 的流式 + 工具调用都只用 faux provider 验证过 pi 的 API 形状。模型目录的价格没有和官网核对。
4. **真实 AWS**：所有工具都只对假 AWS 测过。参数形状（比如 `ListBuckets` 的 `MaxBuckets` / `Prefix`、`GetMetricData` 的字段、Logs Insights 的轮询）是按 SDK 类型写的（typecheck 通过的只是我自己的类型，SDK 的 input 用 `any` 传入），没有对真实 endpoint 跑过。
5. app 体积：pi 依赖树仍在 `dependencies` 里（M0 报告 §2 的重复打包问题没处理），现在又多了 10 个 AWS client；`npm run dist` 后的体积没量。
6. `npm audit` 没有再看（新包来自同一个 AWS SDK 版本）。

## 和方案的偏差

- 没有 `open_console` 工具：回复里的 console 链接可点，效果相同，也不会让模型自己操纵 console。
- 账号策略只有 `aiAllowWrite` 开关（按这次的要求），没有 `ai.mode = off`。
- 审计写 SQLite 的 `audit` 表（M0 已建），没有 `ai-audit.jsonl`。
- 对话是多会话（每账号一个列表），不是方案 §6 的「每账号一个会话」，按这次的要求。
- 方案 §8.2 的 `list_resources` / `describe_resource` 统一入口拆成了按服务的类型化工具（字段更明确，小模型更容易用对），长尾查询交给 `aws_read`。
- 「测试连接」不支持工具调用的模型只提示，不禁用（§13 说标红禁用）。

## 手工验收清单（macOS）

1. `npm run dev`：启动无报错；`~/Library/Application Support/aws-console-hub/` 下生成 `ai.sqlite`（说明 `node:sqlite` 在 Electron 里能用）。
2. ⌘I / 顶栏 ✦ AI：面板出现，console 变窄且不被遮挡；拖左边缘调宽，重启后宽度保持；esc 收起，焦点回到 console；在 Lambda 代码编辑器里按 ⌘I 看是否冲突。
3. 设置：选 DeepSeek → 模型下拉和价格；填 key → 「已设置」；「测试连接」显示支持工具调用；macOS Keychain 弹窗次数；切到「仅本次运行」后 `ai-keys.json` 里没有这个 provider；密钥命令模式。
4. sandbox 账号里问：「列出东京区运行中的 EC2」「这个 Lambda 最近一小时的错误数」「本月成本前五的服务」，答案和 console 对得上；生成中点停止。
5. 让它 `aws_read secretsmanager GetSecretValue` → 被拒；问一个返回很多资源的列表 → 回答里说明截断 / 翻页。
6. 切换账号：面板切到那个账号的对话；在 A 账号运行中切到 B，A 的工具仍打到 A（看审计表 `account_id`）。
7. `grep -r "<你的 key>" ~/Library/Application\ Support/aws-console-hub/` 无结果；`sqlite3 ai.sqlite 'select * from audit'` 只有摘要。
8. 回复里的 console 链接在当前账号打开；其他链接走系统浏览器。
