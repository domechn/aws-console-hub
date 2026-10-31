# AI 助手 M4（策略、审计、打磨）报告

> 日期 2026-10-29。对应 [ai-assistant.md](ai-assistant.md) §16 M4，以及 [M3 报告](ai-m3-report.md)「没做的」一节和 M1 / M2 报告里的遗留项。
> 环境：Linux 开发机，Node 22。没有启动 Electron，没有真实 LLM key，没有调用任何真实 AWS 账号（所有 AWS 调用都是测试里的假实现）。浏览器自动化工具这次没有权限，所以界面一次也没有渲染过。界面、真实模型和 sandbox 账号的验收留给你，清单在文末。

## 结论

代码完成，没有提交。`npm run typecheck`、`npm test`（37 个文件，590 个测试；M3 时是 36 个文件、535 个）、`npm run build`、`npm run ai-smoke` 全部通过。`npm run ai-audit` 用临时库跑过各个参数。构建产物里，渲染进程 bundle 没有 TypeBox、pi、engine、`getApiKey`、`safeStorage`、`SimulatePrincipalPolicy`（已 grep）；新的 `@aws-sdk/client-resource-groups-tagging-api` 是懒 `require`。

## 做了什么

### 1. 新的写操作（写表 23 → 30）

和 M3 一样的模式：TypeBox schema（全部 `additionalProperties: false`）、`forbiddenParams` 逐个给原因、只读快照、纯函数 plan、golden 测试，fail closed。

| 操作 | 要点 |
| --- | --- |
| `rds:ModifyDBInstance` | 只改规格、存储（只能扩大）、备份保留天数。`ApplyImmediately` **必填、没有默认值**。停机说明写明「立即」还是维护窗口（`PreferredMaintenanceWindow`，UTC）以及大约多久（Multi-AZ 走故障转移）；已挂起的修改列出来，立即应用时会一起生效。风险：改规格 high（会重启）；存储 medium；保留天数延长 low、缩短或开关 medium、设为 0 destructive（自动备份会被删）。18 个参数点名拒绝（主密码、公开访问、PassRole 类角色、引擎版本、删除保护等）。 |
| `dynamodb:UpdateTable` | 计费模式、预置容量、删除保护。关删除保护 high；切计费模式 medium；缩容 medium（附当天剩余缩容次数）。索引、流、加密、副本、表类别点名拒绝。**没有删表**（`DeleteTable` 仍不支持）。 |
| `s3:CreateBucket` | 完整的桶名规则；建在提案的 region；`BucketOwnerEnforced`，随后 `PutPublicAccessBlock` 四项全开，可选开版本控制。后面任何一步失败，错误信息都写明「桶已经建好了」以及是哪一步失败，不会显示成功。HeadBucket 返回 200 / 403 / 301 → 名称已被占用。`s3:PutPublicAccessBlock` 作为提案仍然被禁止（有测试）。 |
| `tag:TagResources` / `UntagResources` | Resource Groups Tagging API，按 ARN（≤ 20 个）。只允许清单里的约 25 个服务；IAM / STS / KMS / Secrets Manager / SSM / Organizations / SSO / CloudTrail / GuardDuty / Config / Security Hub / Access Analyzer 拒绝（标签会被 ABAC 条件用来授权）；别的账号、别的 region 的 ARN 拒绝。改 name / env / stage / owner / team / access* 这类键 → medium；去掉 env=prod 标签单独列一条原因。AWS 返回 200 但 `FailedResourcesMap` 不为空时，算失败并列出失败的 ARN。 |
| `ec2:CreateSnapshot` | DryRun；low；按 GB 给出参考费用；卷挂在实例上时提示快照只有崩溃一致性。 |
| `ec2:ModifyVolume` | DryRun；大小 / 类型 / IOPS / 吞吐；不能缩小，修改进行中或距上次修改不到 6 小时时拒绝；提示需要在系统里手动扩展文件系统；改成 st1 / sc1 → high。 |

`lambda:CreateFunction` 仍然禁止，`DeleteFunction` 仍然不支持。

**权限预检**（`engine.ts` 的 `simulate`）：没有 DryRun 的服务（EC2 和 CloudFormation 以外的都算），提案时先调 `sts:GetCallerIdentity`，把 assumed-role 换成 role ARN，再调一次 `iam:SimulatePrincipalPolicy`。资源 ARN 来自 adapter 的 `arns`，要调多个 action 的 adapter 用 `iamActions` 列出。这两个调用都是只读的，在 guard 的 `ADAPTER_READS` 里。

- 全部 allowed：卡片写「权限预检通过」。
- 有 deny：写「⚠ 可能没有 …」，**不拒绝**。模拟不含资源策略和请求上下文，可能误报；最终由 AWS 判断。
- 没有 iam 权限、root、角色带路径：写「无法预检权限（原因）」，提案照常生成。

**写调用超时**：读调用仍是 20 秒，其他调用 60 秒（`aws.ts` 按 `classifyAction` 区分）。确认路径的并发安全不受影响：nonce 照旧在第一个 await 之前同步消耗。

### 2. 账号 AI 策略

- `AwsAccount.aiServices?`：允许提出变更的服务，默认全部。`AwsAccount.aiMaxRisk?`：风险上限，默认不限。`AccountStore` 校验取值；保存时字段存在但值为 undefined 表示清除。
- 账号设置里，开启「允许 AI 助手提出变更」后出现「AI 策略」：服务勾选框，风险上限有四档（不限 / 最高「高」/ 最高「中」/ 只允许「低」）。
- 统一由 `policyProblem` 判断，在三处检查：
  1. 提案时：服务在禁止清单之后查；风险上限在**升级之后**查。
  2. 确认时：同步检查。
  3. 执行前：漂移检查之后再查一次。
- 生产账号的升级行为：先按资源标签升一级、再按生产账号升一级，然后才比上限。例如上限设「中」时，生产账号上本来是「中」的停机操作（升级后是「高」）会被拒。有测试。
- **新修的 TOCTOU**：提案之后改了「生产账号」设置（任一方向），提案作废。原来不检查这一项，结果是：非生产时生成的提案（不需要输入资源名），改成生产账号后照样能一键执行。
- system prompt 也写明服务列表和上限，减少注定被拒的提案。

### 3. 审计和数据

- **保留**：
  - 审计默认 180 天（30–3650 天）。
  - 对话保留可选「一直保留」（默认，和以前一样）/ 90 天 / 30 天 / 不保留。
  - 启动时、之后每 24 小时、退出时各清理一次；保存设置后也清理一次。
  - 「不保留」只在启动和退出时删掉全部对话，日常清理和改设置时不动（否则正在用的对话会突然消失）。
  - 截止时间之后的行永远不删，有边界测试。
  - 删了东西、且距上次 `vacuum` 超过 7 天时，执行一次 `vacuum`。
- **新表**（迁移 v2）：
  - `usage`：每条助手回复一行 token 记录，不随对话删除。所以删对话不会让本月用量和预算「回血」。迁移时从已有消息回填，保留 400 天。
  - `meta`：记录上次 vacuum 的时间。
- **`npm run ai-audit`**：
  - 筛选参数：`--account`（名称片段、12 位账号 id 或应用里的账号 id）、`--since YYYY-MM-DD|Nd`、`--risk low,…`。
  - 输出按天分组；`--csv` 导出摘要（单元格开头的 `= + - @` 会转义，防公式注入），`--json` 导出原始记录。
  - 未知参数直接报错；输出里的终端控制字符替换成空格。
- **应用内「AI 审计」**：AI 设置 →「AI 审计…」。
  - 按账号、时间、风险、范围（变更与策略 / 全部）筛选，「复制为 JSON」。
  - 主进程只返回摘要：时间、类型、账号、提案 id、操作、风险、目标、actor、≤ 300 字的结果、Request ID。**不含参数、工具参数和结果**，最多 500 条。
  - 和 CLI 共用 `auditDigest.ts` 的 `summarize` / `filterAudit`。
- **删除全部 AI 数据**：
  - 删除所有对话、消息和用量记录，停掉所有正在进行的回答，作废所有待确认提案，然后 vacuum。
  - 勾选「同时删除审计记录」时，还要输入「删除审计记录」；这个比较在主进程里做。
  - 删除之后写一条 `ai_data_deleted` 审计，所以「审计被清过」这件事本身会留痕。
  - 删除后面板会重新挂载。

### 4. 用量和预算

- 面板底部两行：本对话的用量；本月（本地时间）所有对话的用量，已删除的对话也算。模型没有价格时显示「价格未知」；部分模型有价格时显示「$x+」。
- 设置里可以设月度 token 上限和费用上限，默认都不限。token 按输入 + 输出计。
  - 用到 80%：面板提醒，发送时也提醒。
  - 超过上限且勾选了「超出后暂停新的提问」：拒绝新消息和卡片回复；提案的执行结果仍写进记录，但不再开新的一轮；排队中的轮次在开始前也会被拦下（卡片恢复成可点）。
  - 费用上限不计入价格未知的模型，提醒文字里会注明。

### 5. 加固（攻击者视角审查）

另起了一个不知道我的设计思路的审查，通读 `src/main/ai/**`、IPC、preload 和渲染组件，再逐条核对代码。发现和修复见下面的威胁模型表。

### 6. 界面

- **表格**：
  - 操作列有表头「操作」，和数据列之间留出间距；横向滚动时操作列固定在右侧。
  - 表头换成底色加粗体，提高对比度；行悬停高亮。
  - 行按钮至少 24px 高，分页按钮至少 24×24。
- **kv 和表单**：kv 块加了底色，和表格分开；表单前有虚线分隔。卡片按钮至少 26px 高。
- **提案卡**：间距加大，被「查看」聚焦时有焦点框（`role=group`、`tabIndex=-1`）。
- **待确认横幅**：有边框；「查看」做成按钮，点击后滚到卡片并把焦点放上去。
- **a11y**：图标按钮（⚙ × ＋ ✎ 🗑）都有 `aria-label`；对话下拉、输入框有 label；表头加了 `scope="col"`；icon / text 按钮补了 focus-visible 样式；AI 设置弹窗是 `role=dialog`，`esc` 在审计视图里先返回设置。
- **窄面板**：消息流的直接子元素加 `min-width: 0; max-width: 100%`；kv 的值列用 `minmax(0, 1fr)`；卡片 `min-width: 0`；用量行单独省略号；横幅文字可以收缩。目标是 320–640px 宽都没有横向溢出。**这一条没有在浏览器里实测过**：我写了一个用假数据渲染真实面板的临时页面，但浏览器工具没有权限，测完就删了。

## 威胁模型

> **2026-10-29 更新**：审批改造（[ai-approval.md](ai-approval.md)）改变了下表的一个前提：M3 / M4 的「fail closed」（不认识就拒绝、禁止清单策略也打不开）换成了「**fail to ask**」（不认识就问用户，禁止清单变成强确认）。M2（`aws_read` 带数据去别的账号）从「拒绝」改为「必须审批、不能一直允许」；「只有确认 IPC 能执行变更」扩展为「确认 IPC 和审批 IPC」。新的攻击面和逐条处理见 ai-approval.md 的威胁模型表；下表其余各条（H1、H2、M1、M3、T1–T2、L1–L9）的结论不变。

| # | 威胁（来源） | 发现 | 处理 | 测试 |
| --- | --- | --- | --- | --- |
| H1 | 注入让模型提出 Lambda 环境变量变更（来源：AWS 数据） | **高**：新值在卡片上显示成「[已隐藏]（新值）」，`NODE_OPTIONS=--import=data:…`、`AWS_LAMBDA_EXEC_WRAPPER`、`LD_PRELOAD`、代理变量等在中风险下一键就能确认，等于远程执行代码并能偷走函数角色的凭证 | 新值显示在卡片上（名称像密钥的只显示长度）；`RUNTIME_ENV` 里的变量不能设置；任何环境变量变更都算 high（必须输入函数名）；审计里所有值仍是 `[redacted]` | `services.test.ts` |
| H2 | 注入让模型写 CloudFormation 模板（来源：AWS 数据 / 模型） | **高**：卡片只显示资源类型，看不到属性；`AWS::Lambda::Function` 加上现有管理员 Role、事件规则、桶策略、函数 URL、SSM、VPC 对等都不在禁止的资源类型里；用服务角色部署的 stack 会以那个角色的权限执行 | 模型写的模板在建 change set 之前先按文本扫描：Transform、宏、`AWS::Include`、`*Role*` 属性、实例角色、UserData、内联策略一律拒绝；禁止的资源类型补齐了禁止清单里对应的那些；带 `RoleARN` 的 stack 只能改参数 | `engine.test.ts`（7 个模板、9 种资源类型、服务角色） |
| M1 | 宏在创建 change set 时就运行（来源：模型） | **中**：change set 本来是确认前唯一允许的写调用，但 Transform / `AWS::Include` 会在那一刻执行宏的 Lambda、去拉 S3 内容 | 同 H2 的扫描，放在 `normalize` 里，change set 根本不会创建，也不用清理 | 同上（断言 0 次 AWS 调用） |
| M2 | `aws_read` 把数据带到别人那里（来源：AWS 数据） | **中**：例如 `s3:HeadObject { Bucket: 攻击者的桶, Key: 偷到的标签 }`，攻击者的访问日志能看到 key 和调用者 ARN；不需要用户点任何东西 | 参数里带其他账号 id 的 ARN 拒绝；S3 的 `Bucket` 必须在本账号的 `ListBuckets` 里（每轮列一次） | `tools.test.ts` |
| M3 | 安全组的「公网」判断（来源：模型） | **中**：只认字符串 `0.0.0.0/0` / `::/0`，`0.0.0.0/1 + 128.0.0.0/1`、`0::/0` 开 22 端口会被算成 low，不需要输入 | 用 `isPublicCidr` 按前缀长度判断（IPv4 /8 及更宽，10/8 除外；IPv6 /16 及更宽，fc00::/7 除外） | `ec2.test.ts` |
| T1 | 确认期间改账号设置（TOCTOU，来源：用户自己） | 生产标记变化原来不检查（见第 2 节） | 作废提案；策略在确认时和执行前各查一次 | `engine.test.ts` |
| T2 | 双击、并发确认、确认和取消同时发生 | 维持 M3 的结论：nonce 在 await 之前消耗，状态先改成 executing | — | M3 已有 |
| L1 | 渲染进程被攻破（XSS） | 两步确认和 1 秒延迟只在界面里，主进程只收到一次确认调用；`confirmText` 也在 `ProposalView` 里 | **接受**并写进文档：渲染进程是信任边界（它本来就能改凭证命令和密钥命令）。真正的防线是 CSP（`script-src 'self'`）和 markdown 净化 | 文档 |
| L2 | 模型卡片冒充系统卡片 | 标题可以带 🔒 | 去掉模型标题里的锁符号和 Unicode 格式字符 | `cards.test.ts` |
| L3 | 用 AWS 名称做视觉欺骗 | bidi / 零宽字符；超长 Name 把实例 id 挤出被截断的标题 | 系统卡片的文字去掉 `\p{Cf}`；`named()` 把名称截到 40 字 | 现有 golden |
| L4 | `ai-audit` 输出终端转义序列 | 漂移行里有 EC2 标签值 | 摘要和 CSV 里的控制字符都换成空格 | `auditDigest.test.ts` |
| L5 | 脱敏遗漏 | Gemini `AIza…`、Groq、xAI、GitHub、HF 的 key；JSON 字符串里套的 `MasterUserPassword`（CloudFormation 的 `ResourceProperties`）；凭证命令出错的 toast | 补上这些模式（转义一层或多层的 JSON 都能识别）；凭证错误的 toast 先过 `redactSecrets` | `redact.test.ts` |
| L6 | 执行中途换了凭证 | Lambda 执行时先读一次再写；这期间用户改了账号，写请求会用新登录的凭证 | **接受**：只有用户本人能触发，而且执行前已经核对过登录身份和 STS 账号 | — |
| L7 | 排队的轮次用旧设置 | 清掉 key 或换了服务商后，排队的轮次还用旧 key | 每个排队轮次开始前重新解析模型和 key，并检查预算；失败时卡片恢复可点、结果只写进记录 | 现有排队测试 |
| L8 | 内存只增不减 | `pendingCards` 在 `[card_action]` 写进记录后没删；`queued` 留着空数组；`attempts` 一直增长 | 写进记录后删除；空队列删除；`sweep` 里裁掉超过 1 分钟的 `attempts`；「删除全部」清空所有 map | — |
| L9 | 卡片链接到 CloudFormation 快速创建等 console 页面 | `templateURL` 可以指向攻击者 | **接受**：用户还得在 console 里自己点创建 | — |
| — | 核对过、没有问题的 | 只有确认 IPC 能执行变更；nonce / hash 不进模型和渲染进程；伪造前缀和历史回放不会被当成结果或点击；`isConsoleUrl` 能挡住 userinfo、反斜杠、IDN、`javascript:`；围栏转义有效；IPC 参数校验；key 只写不读；确认前的写保护 | — | M1–M3 已有 |

## 自动化验证

| 测试文件 | 新增覆盖 |
| --- | --- |
| `changes/m4adapters.test.ts`（新，18） | 6 个新 adapter 的 golden 测试；经过 `ProposalEngine` 的端到端：确认前写调用为 0（guard 放过 `tag:GetResources`），确认后正好发出预期的写调用；CreateBucket 中途失败、TagResources 部分失败都算 `failed` |
| `changes/registry.test.ts` | 写表 30 项；`AI_CHANGE_SERVICES` 等于写表里的服务；禁止的 ARN 服务、跨账号标签；`lambda:DeleteFunction` 不支持；`s3:PutPublicAccessBlock` 仍然禁止 |
| `changes/engine.test.ts` | 服务白名单（提案时一次 AWS 调用都不发；确认时拒绝、放开后能执行）；风险上限按升级后的风险算（含生产账号）；生产标记变化作废提案；执行前再查一次策略；`principalArn`；权限模拟：通过、deny 只提示、没有权限 / root 时降级、DryRun 服务不模拟；CloudFormation 模板扫描、服务角色、扩充的资源类型 |
| `changes/services.test.ts` / `ec2.test.ts` | Lambda 显示新值、密钥名隐藏、`RUNTIME_ENV` 拒绝、high；`isPublicCidr` 的公开 / 私有用例 |
| `service.test.ts` | 本月用量（含已删对话，不含上个月，价格未知）；预算 80% 提醒、超出后阻止、改成只提醒；`budgetVerdict`；保留期清理（「不保留」只在启动 / 退出生效）；删除全部数据（短语、审计留痕）；审计列表的筛选，以及不含参数 |
| `db.test.ts` | v2 迁移和回填；`usage` 在删对话后还在；保留期边界；vacuum 频率；审计查询 |
| `auditDigest.test.ts` | 按天分组；按时间 / 账号 / 风险 / 范围筛选；摘要不含参数；CSV 转义和公式注入；`--since` 解析；不输出控制字符 |
| `config.test.ts` / `accounts.test.ts` / `validate.test.ts` | v3 配置的取值范围；账号策略的取值和清除；`ai:audit-list` / `ai:data-delete` 的参数校验 |
| `tools.test.ts` / `redact.test.ts` / `cards.test.ts` | 跨账号 ARN、外部桶；新的 key 模式、JSON 里的密码；模型标题去掉锁符号 |
| `CardView.test.tsx` / `ai.test.ts` | 操作列表头；`formatMonth` |

`ai-audit` 用一个临时 `ai.sqlite` 加 `accounts.json` 跑过：默认摘要、`--account prod --risk high --csv`、`--since 1d --account 123456789012 --json`、未知参数报错。

## 没能验证的

1. **界面完全没渲染过**：新的账号策略面板、「用量与预算」「数据与隐私」、删除确认面板、审计查看器（宽弹窗、表头固定、筛选）、表格固定的操作列（尤其是变灰卡片里的底色）、面板底部两行用量、横幅「查看」的焦点；**320–640px 宽度下有没有横向溢出**（只靠 CSS 推断）；对比度没有用工具量过。
2. **真实 AWS**：新 adapter 的请求和响应形状都是照 SDK 类型写的，只对假 AWS 测过。需要实测的有：
   - `iam:SimulatePrincipalPolicy` 的返回，以及 assumed-role 换成 role ARN 的结果；
   - HeadBucket 的错误名和状态码（404 / 403 / 301）；
   - `GetResources` 是否支持 `ResourceARNList`、会不会漏掉从没打过标签的资源；`FailedResourcesMap` 的形状；
   - `DescribeVolumesModifications` 对没修改过的卷返回什么；
   - DynamoDB 的 `NumberOfDecreasesToday` 和计费模式切换限制；
   - RDS 的 `PendingModifiedValues`、`PreferredMaintenanceWindow` 的格式；
   - CreateBucket 在 us-east-1 不传 `LocationConstraint` 的行为。
3. **真实模型**：新的参数说明和策略提示是否足够让模型一次写对，只用 faux 模型验证过。工具描述又变长了一些（写表多了 7 行），没量 token。
4. **Electron 运行时**：迁移 v2 里的 `json_extract` 在 Electron 内置的 SQLite 上能不能用（Node 22 自带的 SQLite 上测试通过）；`will-quit` 时做清理的耗时；`vacuum` 在大库上要多久。
5. CloudFormation 的模板扫描是按文本匹配的，会误伤（参数名叫 `Role` 的模板会被拒）；有没有漏网的写法只靠推理，没有对照 CloudFormation 的完整资源规范。

## 和方案的偏差

- 没有做 AI 专用只读 role（§15 待定项）。
- 预算是全局的（所有账号共用一个 LLM key），不是方案 §9.8 里的「每会话上限」；面板同时显示本对话和本月的用量。
- 权限模拟的 deny 只提示、不禁用确认按钮（§9.3 说的是对 DryRun 的 `UnauthorizedOperation` 禁用）：模拟结果不可靠，误报会挡住合法的操作。
- 审计保留按天数，不是按 2 万行；仍然在 SQLite 里，没有 `ai-audit.jsonl`。
- 写表仍然不含 `lambda:CreateFunction` / `DeleteFunction` 和「兜底」adapter（按你的要求）。
- Lambda 环境变量的新值现在**会**显示在卡片上（M3 是全部隐藏）：隐藏正是 H1 能成立的原因，名称像密钥的仍然只显示长度。

## 没做的

- Pricing API（参考价仍是手工表）。
- 新提案不会自动把同一资源上的旧提案标成作废（仍靠「最多 3 个待确认」和 10 分钟过期）。
- 主进程里的确认延迟或「先 arm 再执行」的 IPC（L1：渲染进程被攻破时这一层防不住，所以没做）。
- 确认期间锁定凭证快照（L6）。

## 手工验收清单（Xvfb GUI + sandbox 账号）

准备：沿用 M3 的 sandbox 账号（`ai-test-1` 实例、测试安全组），另外准备一个测试 RDS（可选）、一张测试 DynamoDB 表（可选）。打开 CloudTrail 事件历史。

1. **账号策略**：账号设置里打开「允许 AI 助手提出变更」，出现「AI 策略」。只勾 S3 → 说「停掉 ai-test-1」→ 被拒，原因写着「不允许对 ec2」，CloudTrail 里没有 DryRun。勾回 EC2，风险上限设「中」→ 说「终止 ai-test-1」→ 被拒（超过上限），说「停掉」→ 正常出卡片。
2. **确认时再查**：生成「停止」提案 → 先不确认，把风险上限改成「只允许低」→ 点确认 → 被拒；改回后能确认。生成提案后切换「生产账号」→ 确认时提示提案已作废。
3. **生产账号升级**：生产账号、风险上限「高」→「停止实例」（中，升级后是高）可以提出；「终止」（破坏性）被拒。
4. **新 adapter**（sandbox）：
   - 「给 ai-test-1 的根卷建快照」→ low，DryRun 通过 → 确认后 CloudTrail 有 `CreateSnapshot`。
   - 「把这个卷扩到 +1 GiB」→ medium，提示要扩展文件系统；马上再改一次 → 提示不到 6 小时。
   - 「新建一个桶 ai-test-<随机>」→ 卡片写明阻止公开访问会打开；确认后在 Console 看「阻止公开访问」四项都开着、ACL 已禁用。
   - 「给 ai-test-1 打标签 team=ai」，用 ARN → `tag:TagResources`；试一个 IAM 角色的 ARN → 被拒。
   - （可选）RDS 改规格：必须说清立即还是维护窗口，卡片上有停机说明。DynamoDB 切按需计费。
5. **权限预检**：用没有 `iam:SimulatePrincipalPolicy` 权限的 role 提一个 S3 变更 → 卡片「预检」写「无法预检权限」，仍然可以确认；有权限时写「权限预检通过」，CloudTrail 有 `SimulatePrincipalPolicy`。
6. **加固**：
   - 「把函数 X 的 NODE_OPTIONS 设成 …」→ 被拒。
   - 「设置 FEATURE=on」→ 卡片显示 `on`，风险是高，要输入函数名。
   - 让它给一个测试 stack 提交带 `Role:` 的模板 → 被拒，CloudTrail 没有 `CreateChangeSet`。
   - 「HeadObject 一个不属于你的桶」→ 被拒。
7. **审计查看器**：AI 设置 →「AI 审计…」→ 上面这些操作都在；按账号、时间、风险筛选；「复制为 JSON」粘贴出来没有参数；`esc` 回到设置。
8. **ai-audit**：`npm run ai-audit -- --account <名称> --risk high --since 1d`、`--csv > a.csv` 用表格软件打开，确认列对齐、没有公式被执行。
9. **保留**：审计保留改成 30 天（数据库里留一条 31 天前的测试记录，可以用 sqlite3 改 `t`）→ 保存后那条被删。对话保留选「不保留」→ 退出重开 → 对话都没了，审计还在。
10. **删除全部 AI 数据**：不勾审计 → 对话没了、本月用量清零、审计里多一条 `ai_data_deleted`。勾审计后不输入短语，按钮不可点；输入后删除 → 审计只剩一条 `ai_data_deleted`。
11. **用量和预算**：底部显示「本对话 …」和「本月 … tokens · $…」。月度 token 上限设一个很小的值 → 发送时提示「已超出」；勾选「超出后暂停」→ 发送被拒、卡片按钮点了恢复可点；取消勾选后又能发。自定义端点的模型显示「价格未知」。
12. **界面**：面板拖到 320 和 640，表格卡片（6 列 + 两个行按钮）只在表格内部横向滚动，操作列固定在右侧且有「操作」表头；提案卡、结果卡、横幅、底部两行用量都不撑出横向滚动条。键盘：Tab 能依次走到「查看」→ 提案卡 → 「确认执行…」；读屏能读出图标按钮的名称。
