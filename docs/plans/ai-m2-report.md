# AI 助手 M2（交互卡片）报告

> 日期 2026-10-29。对应 [ai-assistant.md](ai-assistant.md) §10、§11、§16 M2。
> 环境：Linux 开发机，Node 22.23.4。没有启动 Electron，没有用真实 LLM 和 AWS 账号，界面留给你在 Xvfb 桌面上测。

## 结论

代码完成。`npm run typecheck`、`npm test`（28 个文件，357 个测试，M1 时是 239 个）、`npm run build`、`npm run ai-smoke` 全部通过。没有提交。

## 做了什么

### 1. Schema（`src/shared/cards.ts`、`src/shared/cardRules.ts`）

- TypeBox `1.3.27`，和 pi-ai 依赖的版本一致，加成直接依赖并钉死。它和 pi 一样是纯 ESM，所以加进了 `electron.vite.config.ts` 的 `externalizeDeps.exclude`，打进主进程 bundle（构建产物里没有 `require("typebox")`）。
- `Card` v1 按 §10.2：模型可用 `markdown` / `kv` / `table` / `badges` / `form` / `console-link`；只有主进程能用 `diff` / `consequences` / `risk` / `progress` / `error`。按钮只有 `reply` / `open-console` / `copy`。
- 上限：块 ≤ 20、按钮 ≤ 6、表格 ≤ 100 行 / ≤ 12 列、kv ≤ 30、徽标 ≤ 20、表单字段 ≤ 20、选项 ≤ 50、markdown ≤ 4000、标题 ≤ 120、label ≤ 100、单元格 ≤ 500、kv 值 ≤ 1000、URL ≤ 2000、正则 ≤ 100，整张卡 JSON ≤ 60 000。
- `cardRules.ts` 不依赖 TypeBox，两端共用：表单值校验 `fieldError`、正则守卫 `patternError`、`{row}` 替换、system-only 块类型列表。`isConsoleUrl` 移到了 `shared/consoleUrl.ts`（`main/urls.ts` 重新导出，主进程原来的调用不变），这样卡片里的链接在两端用同一个判断。
- 渲染进程只 `import type` 卡片 schema。已 grep 构建产物：渲染进程 bundle 里没有 TypeBox，也没有 pi、AWS SDK、`safeStorage`、`getApiKey`。

### 2. 主进程：`render_card` 和卡片规则（`main/ai/cards.ts`、`tools.ts`、`service.ts`）

- `render_card` 工具的参数就是 `ModelCardInput`。检查放在 pi 的 `prepareArguments` 里，比 pi 自己的 schema 校验早一步，因为 union 校验失败时 pi 只会说「不匹配任何分支」，模型不知道改哪里。
- 检查内容：system-only 块点名拒绝；未知块类型；按块类型逐个做 schema 校验，报精确路径；再查规则：action / 列 key / 行 id 唯一（行 id 在整张卡里唯一）、行按钮和表单提交引用存在的 action、提交按钮必须是 `reply`、表单字段名唯一、`console-link` 和 `open-console` 的 URL 必须过 `isConsoleUrl`（`javascript:`、`http:`、其他网站都过不了）、含 `{row}` 的按钮只能当行按钮、正则守卫、min ≤ max、`supersedes` 必须是本对话已有的卡片。问题一次全部列出，作为工具错误回给模型；测试里假模型据此改了两次后成功。
- **正则守卫**：长度 ≤ 100；不允许反向引用；被量词修饰的分组里不能再有量词或 `|`（`(a+)+`、`(a|aa)*`、`(\w+\s?)+`、`(a{1,3}){2,}` 都拒绝）；必须能用 `u` 标志编译。这条规则比真正的 ReDoS 判定严（比如 `[a-z]+(-[a-z]+)*` 也会被拒），被拒时提示模型改写。被拒的正则永远不会被执行。
- 卡片由主进程重建：id 是 `c-` + 12 位 hex（`randomUUID`），`origin: 'model'`，`createdAt` / `expiresAt`（30 分钟），模型写的 id / origin / state 进不来；最后用完整 `CardSchema` 再复核一次。
- 工具结果给模型的只有一句「卡片 c-… 已显示给用户，用户点 reply 按钮时你会收到 [card_action] 消息」。审计照常记 `tool_call`（只有卡片 id，没有内容）。

### 3. 生命周期与存储

- 卡片快照放在 `render_card` 那条工具结果消息的 `details.card` 里，跟着消息进 SQLite（写入前照常 `redactSecrets`），**没有新表、没有迁移**。
- 状态每次从记录推算（`history.ts` 的 `transcriptCards`）：有它的 `[card_action]` 用户消息 → `resolved`；后来的卡片 `supersedes` 它 → `superseded`；过了 `expiresAt` → `expired`；否则 `active`。主进程内存里只多两样：已接受但还在排队的点击（卡片 id 集合）和排队的回复。删除对话 / 清空 / 删除账号时一起清掉。
- 这样重开应用后历史里的卡片照样显示，状态也对（测试里直接拿数据库里的消息、不经过 service 重新算过）。
- `supersedes` 是可选的，只有模型显式写了才替代旧卡片（§10.3），新卡片不会自动替代旧的。

### 4. IPC：`ai:card-action`

`ai:card-action(accountId, conversationId, cardId, actionId, rowId?, values?)` → `{ ok: true }` / `{ ok: false, error }`。

- 参数形状在 `validate.ts` 查：卡片 id 格式、action id 字符集、行 id（可打印 ASCII ≤ 256）、表单值（普通对象、≤ 20 个字段、值只能是 ≤ 1000 字的字符串 / 有限数字 / 布尔，原型不是 `Object.prototype` 的拒绝）。
- 内容在 `checkCardAction` 查：对话属于这个账号、卡片在这个对话里、状态 `active`、按钮存在且不是 `copy`、`rowId` 是某一行且该行有这个按钮（没给 `rowId` 时不能是行按钮）、表单值按字段校验（类型、必填、pattern、select 选项、min / max、多余字段），非表单按钮不能带值。
- `open-console`：`{row}` 用 `encodeURIComponent(rowId)` 替换后再查一次 `isConsoleUrl`，然后调 `index.ts` 里 `console:navigate` 用的同一个 `navigateConsole`（会话失效时走联邦登录）。不经过模型，卡片保持可点。
- `reply`：在任何 `await` 之前就把卡片记为已接受并推 `card-state: resolved`，所以重复点击和并发的两次点击只有一次成功（有测试）。主进程拼 `[card_action] {"cardId","action","label","row"?,"values"?}` 作为用户消息；对话空闲就立即开一轮，正在跑就排队，上一轮结束后用同一个模型和 key 接着跑（中间不发 `done`，面板看到的是连续的一段「生成中」）。开不了（配置出错）或者用户点了停止，卡片恢复成可点。用户手打的消息不能以 `[card_action]` 开头。
- `copy`：渲染进程自己复制，不走主进程。
- 新事件：`card-pending`（骨架）、`card`、`card-state`、`user`（主进程替用户发起的一轮，带显示文字，如「「详情」 · i-0abc」）。

### 5. 渲染（`components/ai/CardView.tsx`，`AssistantPanel.tsx`，`styles.css`）

- 各块：表格（点列头排序，数字按数值比，`aria-sort`；超过 20 行分页；「复制为 TSV」；单元格省略号 + `title`；行按钮带「按钮名：行 id」的 `aria-label`）、kv（可复制）、徽标（四种色调）、表单（label 关联、必填星号、行内错误用 `aria-invalid` / `aria-describedby`，提交后或填了内容后才显示；处理后 `fieldset disabled`）、console 链接、markdown（受限渲染，**卡片里只有 console 链接可点**）、system-only 的 diff / 影响 / 风险 / 进度 / 错误。
- 所有块内容都按纯文本渲染（React 转义）；只有 markdown 块解析 markdown。长 kv 值（> 200 字）、长 markdown（> 800 字或 > 16 行）、错误详情截断并给「展开」。
- 状态：非 `active` 的卡片变灰，标题行显示「已处理」/「已过期，请让助手重新生成」/「已被新卡片替代」，按钮和表单禁用（复制仍可用）；屏幕上的卡片过了 `expiresAt` 也会立刻显示过期（主进程同样拒绝）。点击进行中所有按钮禁用；主进程拒绝时在卡片里显示原因。
- system 卡片：锁图标 + 账号色左边条；模型卡片上的 system-only 块一律不画。
- 生成中显示骨架；文字 → 卡片 → 文字按事件顺序排列（有测试）。全部是原生 `button` / `input` / `select`，键盘可用，有 focus 样式。

### 6. System prompt 和 M1 遗留

- prompt 新增 4 条：什么时候用卡片（资源列表 → 表格 + 「在 Console 打开」行按钮；收集参数 → 表单；成本摘要 → kv + 表格）、卡片内容必须来自工具结果、按钮只把点击作为消息发回不执行任何操作（不要做变更按钮）、`render_card` 报错时按列表修正。
- 工具调用行：改成占满一行的按钮，图标 + 文字（省略号）+ 展开箭头，点击或回车展开完整的说明和摘要。
- 用量行：字号 11 → 12px，颜色从 `--text-dim` 调深（`--text` 的 78%），数字等宽。
- 费用：目录价全为 0 的模型（自定义端点等）现在和不在目录里的一样算「价格未知」，不再显示 `$0`；设置里的提示文字同步改了。

## 自动化验证

| 测试文件 | 覆盖 |
| --- | --- |
| `cards.test.ts`（新，71 个） | 接受 ①②④ 三类卡片；5 种 system-only 块都被拒；29 条拒绝表（空 / 超量块、超长 markdown、超过 100 行、kv 超量、按钮超量、单元格超长、整卡过大、非法 id、未知 kind、console-link 指向外站 / `javascript:` / `http:`、open-console 外站 / `javascript:` / 缺 URL、copy 缺 text、引用不存在的 action、重复 action / 行 / 列 / 字段、footer 里的 `{row}`、提交按钮不存在 / 不是 reply、嵌套量词、min > max、未知 supersedes）；一次列出全部问题；模型给的 id / origin / state 被忽略；正则守卫 8 个放行、13 个拒绝；状态优先级；点击校验（行、footer、未知按钮、`{row}` 编码后不能把 URL 带出 console、三种非 active 状态、表单值 8 种错误）；`[card_action]` 往返 |
| `service.test.ts`（+8） | faux 模型调 `render_card` → 卡片事件 → 存储 → 点击 → 下一轮收到 `[card_action]`、第二次点击被拒、历史显示已处理、只用数据库记录重算也是已处理 / 30 分钟后过期；两次并发点击只成功一次；非法卡片（diff 块、`javascript:` open-console）两次退回后模型修正成功；运行中点击排队、只发一次 done；停止后排队的点击丢弃、卡片恢复；错对话 / 别的账号的对话 / 不存在的卡片 / 按钮 / 行 / 多余表单值都被拒；open-console 调主进程打开、不调模型、卡片不变；过期后拒绝；supersedes；手打 `[card_action]` 被拒；删除对话后点击被拒 |
| `CardView.test.tsx`（新） | 单元格 / kv / 徽标 / 标题里的 HTML 按文本显示；模型卡片不画 system-only 块，system 卡片画出来且有锁和色条；45 行分 3 页、TSV；三种非 active 状态的文字和禁用（复制不禁用）、屏幕上过期；表单 label 和禁用；console-link 只链 console |
| `Markdown.test.tsx`（+1） | 卡片模式下只有 console 链接可点，`<script>`、远程图片、`javascript:`、普通网站链接都不生效 |
| `ai.test.ts`、`history.test.ts`、`validate.test.ts` | 卡片事件合并（骨架 → 卡片 → 状态，失败的卡片变成失败的工具行）；目录价为 0 → 价格未知；`ai:card-action` 参数校验 |

M1 已有的测试（遥测关闭、环境变量锁定、pi 只被 providers / service / tools 引用、key 不进事件和数据库等）全部照常通过。`ai-smoke` 通过（网络调用 0）。

## 没能验证的

1. **界面没跑过**：卡片的版式（窄面板下的表格横向滚动、行按钮列、表单）、骨架、灰显、键盘焦点顺序、读屏效果、`navigator.clipboard` 在主窗口里能否写入（主窗口的 session 没有权限处理器，按 Electron 默认应当允许，但没实测）。
2. **真实模型**：§10.5 的 ①②④ 能否由真实模型稳定生成、出错后能否按错误列表自我修正，都只用 faux 模型验证过。TypeBox 生成的 JSON Schema 里用了 `enum`，各家 provider（尤其 Gemini、Ollama 小模型）对这个工具 schema 的接受程度没测。卡片 schema 本身比较大（每轮都随工具列表发送），会多花一些 input token，没量。
3. **⑤ 错误卡**：属于 system 卡，块和渲染已就绪，但 M2 没有生成 system 卡的地方，要到 M3 才会出现。
4. 真实 AWS 和 Electron 运行时：同 M1 报告，没变化。

## 和方案的偏差

- 卡片不单独持久化，状态从记录推算；主进程内存里只有排队中的点击。排队期间退出应用，那次点击会丢，重开后卡片恢复可点。
- 没有「展开浮层」，长内容就地「展开」。
- 「非 console 链接不生效」只在卡片的 markdown 里执行；聊天回复里的普通网页链接按 M1 的规则交给系统浏览器（这是 M1 有意的行为，没改）。
- number 字段也支持 `required`（方案里只有 text 有）。
- 一个按钮不能同时是表单提交和行按钮；含 `{row}` 的按钮只能当行按钮（这两条是为了让点击校验没有歧义）。

## 手工验收清单（你在 Xvfb 上测）

1. 「列出当前 region 运行中的 EC2」→ 表格卡片，列头可排序，行上有「在 Console 打开」；点它在当前账号打开实例详情页，卡片不变灰。
2. 让它对一行做 reply 类按钮（如「看详情」）→ 卡片变灰「已处理」，面板出现「「看详情」 · i-…」，助手接着回答；再点任何按钮无效。
3. 「我想新建一台 EC2，先给我一个表单」→ 表单卡片；填一个不符合 pattern 的名称看行内错误；提交后变灰，助手收到表单值（只会描述，不会创建）。
4. 「本月成本前五的服务，用卡片」→ kv + 表格；kv 的「复制」能用。
5. 生成过程中先显示骨架；文字 / 卡片 / 文字的顺序正确。
6. 生成中点卡片按钮 → 当前回答结束后自动接着处理；生成中点按钮后马上点「停止」→ 卡片恢复可点。
7. 列超过 20 个资源 → 分页、「复制为 TSV」粘到表格软件里列对齐。
8. 重开应用后历史里的卡片还在，已点过的是「已处理」，30 分钟前的是「已过期」。
9. 工具调用行：长标签一行省略，点开看到完整内容；用量行看得清；用自定义端点时显示「价格未知」。
