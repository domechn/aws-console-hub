# AI 助手：理解当前打开的页面

起因：用户在 S3 桶 `aws-quicksetup-patchpolicy-<acct>-xxxx` 的「对象」页问「这个桶是干嘛的」，助手不知道是哪个桶，只能看名字猜。

## 做了什么

1. **每轮自动带上页面信息**（`ai/page.ts` 的 `pageContext` / `pagePromptSection`）。每次运行重新取**这个对话账号**的活动标签页的 URL 和标题，不读页面内容。只有 Console URL 会发送，令牌类参数先去掉。parser 识别出的服务、资源类型、名称和标签页（`?tab=objects` → 对象）写进 system prompt 末尾的 `<current_page>` 围栏，标明是不可信数据，并要求模型「这个 / 当前 / 这里」就指它，先用对应的查询工具查，不要靠名字猜。页面信息记在那条用户消息上（`page: { label, url }`），历史里能看到每句话是在哪个页面问的。
2. **面板的页面标签**（`PageChip.tsx`）：显示在输入框上方，例如「当前页面：S3 · aws-quicksetup-patchpolicy-… · 对象」，内容和主进程这一轮会发的完全一样（`ai:page-context`）。它跟着已有的 `nav:state` 推送更新，悬停提示列出发送的字段。点 × 关闭当前对话的页面信息（`conversations.page_context`，默认开）。没识别出资源时显示「无法识别当前页面」（地址和标题照常发送）；不是 Console 页面时什么都不发。
3. **`read_current_page`**：只读工具，在屏幕上本账号的 Console 标签页里，用隔离 world 跑一段固定脚本，读可见文字和选中的文字。主进程脱敏，截到 8 KB，用 `<aws_data>` 围栏标明不可信，审计只记字数。只在设置「允许助手读取当前页面内容」（`AiConfig.readPage`，v4，默认开）和对话开关都打开时才注册；不注册时 prompt 会告诉模型。
4. **`describe_s3_bucket`**：标签、版本控制、生命周期、加密、公开访问阻止、策略状态、第一页对象统计。
5. 迁移：`ai-config.json` v3 → v4（缺省或非布尔的 `readPage` 都当 `true`）；`ai.sqlite` v2 → v3（`alter table conversations add column page_context integer not null default 1`）。

## 决定

- **页面信息放在 system prompt 末尾，而不是每条用户消息里**：每次运行都会重建 system prompt，所以永远是当时的页面。旧的页面信息不会留在记录里误导模型，也不会被 `compactContext` 裁掉。历史显示用的是用户消息上单独存的 `page` 字段，交给 pi 之前会去掉。
- **页面信息用活动标签页（可能是后台账号的），读取页面内容用屏幕上的标签页**：页面信息是元数据，按账号取就行。读取页面内容会在页面里运行脚本，所以要求账号就在屏幕上（`views.activeId === 对话账号`），而且是 Console URL。不满足就拒绝，什么都不运行。
- **对话里关掉页面信息，`read_current_page` 也不注册**：用户点了 ×，意思就是「别看我的页面」。
- **隐藏元素的过滤在页面里做**（`PAGE_TEXT_FN`），主进程再脱敏一次。脚本是常量，没有任何参数，也没有通用 eval。测试用一个最小的假 DOM 跑它（项目里没有 jsdom）。
- **`GetBucketPolicy` 仍然是 `aws_read` 可用的读操作**：策略文档是配置（principal、条件），不是数据，不含密钥，照常经过整形和脱敏。`describe_s3_bucket` 只取 `GetBucketPolicyStatus`，保持结果小。读对象内容（`GetObject` / `SelectObjectContent`）还是 sensitive，有测试。
- `describe_s3_bucket` 和 `aws_read` 一样，只查 `ListBuckets` 里本账号的桶。region 优先用 `ListBuckets` 的 `BucketRegion`，没有时调 `GetBucketLocation`（`EU` 当作 `eu-west-1`）。

## 测试

`page.test.ts`（URL 脱敏表、pageContext、注入安全的围栏、页面脚本对假 DOM 的过滤、脱敏 / 截断、账号不符 / 非 Console 页面时拒绝且不运行脚本、只取字符串）、`tools.test.ts`（describe_s3_bucket 用假 S3：只调用上面那些 action，都是读，按 region 调用，部分失败，外部桶拒绝；read_current_page 的围栏和不含内容的审计）、`service.test.ts`（每轮重新取页面、页面记在用户消息上且不进模型输入、对话开关、设置关闭时工具不注册、工具行和审计）、`config.test.ts`（v3 → v4 迁移、校验）、`db.test.ts`（v3 迁移）、`PageChip.test.tsx`。

## 未验证 / 已知限制

- 没在真实 Console 上跑过 GUI：`executeJavaScriptInIsolatedWorld` 在 Console 页面上的实际输出、页面很大时的耗时（每个元素都调一次 `getComputedStyle`）、Cloudscape 表格的分隔效果。
- 渲染在 iframe 或 shadow DOM 里的 Console 内容读不到（只读主 frame 的 light DOM）。
- 脱敏是按模式匹配的：没有标签的秘密（比如一个全小写的随机串）发现不了；「密码」「secret」后面的普通词也可能被误打码。
- 带 `-` 的长资源名不会被当成令牌。没有 `-` 的长串、大小写加数字的资源名（≥ 32 位）在 URL 路径里会被替换成 `[redacted]`，在页面文字里 ≥ 40 位才会。
- 发送后乐观显示的那条用户消息，要等这一轮结束、重新拉历史后才显示页面标签。
