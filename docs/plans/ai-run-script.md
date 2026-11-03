# AI 助手：批量任务一次完成（`run_script`）

## 问题和结论

「每个桶有没有标签」「所有实例按类型统计」「翻完所有页再汇总」：原来模型只能一个资源调一次工具，几十个资源就撞上每条消息 40 次工具调用 / 20 轮的上限，把上限调高也只是更慢、更贵。

结论：加**一个通用的**只读脚本工具 `run_script({ code, reason })`，不加任何按场景定制的工具（没有 `forEachBucket` 之类）。模型写一段 JavaScript（async 函数体），在沙箱里用 `aws()` 查询、`parallel()` 并发、`return` 一个精简的汇总。整段脚本只算 1 次工具调用。

## 设计

- **运行时**：QuickJS 编成 WebAssembly（`quickjs-emscripten-core` + `@jitl/quickjs-singlefile-cjs-release-sync`，0.32.0，钉版本），在独立 `worker_threads` Worker 中运行，每个脚本一个新的 wasm 实例。singlefile 版把 wasm 内嵌在 JS 里，并随 Worker 打包。
  - 不用 `node:vm`：它不是安全边界，沙箱对象和宿主共用原型链，`this.constructor.constructor('return process')()` 就逃出去了。
  - 不用 `isolated-vm`：原生模块，每次升级 Electron 都要重编。
  - Worker 只接收脚本和限额；主进程通过消息处理 `aws()`，保持原有审批与脱敏路径。
- **API**（`sandbox.ts` 的 `PRELUDE`）：`aws(service, action, params?, { region? })`、`parallel(fns, n = 8)`、`log()` / `console.log`、ES 内置对象。没有 fs、网络、`require`、`import()`、定时器、`sleep`。值只以 JSON 文本过边界：脚本那边先 `JSON.stringify`，宿主只收字符串，再解析成普通对象。
- **调用路径**：`aws()` → `tools.ts` 的 `readCall`，和 `aws_read` 是同一个函数：分类、PartiQL 只限 SELECT、`ce` / 写 / 名称不明一律拒绝、参数 ≤ 4000 字、出口检查（外部账号 / URL / 别人的桶）、tier B 审批、执行冻结的参数。每个结果先 `scrub` + `redactSecrets` 再交给脚本。
- **审批**：用普通审批卡，`why` 多一行「来自脚本（run_script）」。普通读在一个脚本里按 `service:action:region` 只问一次（同时在等的调用等那张卡），敏感读取和有出口风险的调用每次都问。各项限额不变。等卡片的时间不算进脚本的所设墙钟时限，也不算进运行的 5 分钟。
- **结果**：`{ result, logs?, calls }` 经 `shapeData` 裁剪到 12 KB，放进 `<aws_data source="run_script">` 围栏。脚本出错时，错误信息和日志也在围栏里，模型可以改了再跑一次。
- **显示**：工具行「运行脚本 · N 次调用」，展开后是调用列表（`s3:GetBucketTagging ×11`）和只读的代码。
- **审计**：一行 `tool_call`，内容是 `calls`、`actions`（`service:action` 计数）、`codeHash`、`codeChars`、`ok` / `ms` / 失败类别。不记代码、参数、结果和错误文字。
- **prompt**：规则 1 加上「批量任务用 run_script 一次完成，只算 1 次工具调用，return 精简汇总；只能读，变更仍用 propose_change」。工具描述里写了 API、限制和两个例子（桶标签并发、DescribeInstances 翻页统计）。

## 限额（`SCRIPT_LIMITS`）

| 项 | 值 | 怎么执行 |
| --- | --- | --- |
| 代码 | 8000 字符 | 工具 schema + 运行前检查 |
| 墙钟 | 默认 5 分钟，可设 1–30 分钟，等审批不算 | 主进程 `ScriptClock` 和看门狗；Worker 就绪后开始 |
| 连续同步计算 / 累计本地计算 | 2 秒 / 60 秒 | Worker 内中断和主进程强制终止 |
| 内存 | 64 MB | `setMemoryLimit` |
| 栈 | 192 KB | `setMaxStackSize`；超过约 200 KB 时，普通递归会先撑爆 V8 的栈 |
| `aws()` 次数 | 300 次 / 脚本 | 超过的调用直接 reject |
| 并发 | 8 | 宿主排队，多出来的不报错 |
| 单个结果 | 2 MB JSON | 超过的调用 reject（「请加过滤条件或分页」） |
| 返回值 | 读回 1 MB，交给模型 12 KB | 超过 1 MB 换成一条说明；再按 `shapeData` 裁剪，带 `truncated` |
| 日志 | 4000 字 | 超过的截断 |

## 安全分析

| 威胁 | 处理 |
| --- | --- |
| 逃出沙箱 | 宿主对象不在 wasm 内存里，构造器链、`eval`、`Function` 只能拿到 QuickJS 自己的全局对象；没有模块加载器；原型污染只在沙箱里生效；getter / Proxy / 函数过不了 JSON 边界。测试：`sandbox.test.ts`。 |
| 批量写、绕过审批 | `readCall` 拒绝写和名称不明的操作（含 tier C）；tier B 照常出卡，限额不变。 |
| 「允许一次」被放大 | 只在本脚本内、只对普通读复用（威胁模型 L5，同 L3）。 |
| 秘密换个键名带出去 | 每个结果先脱敏再进沙箱。 |
| 资源耗尽 / 拖住主进程 | 见上表。深层嵌套的 JSON 会在 wasm 里撑爆 V8 的栈（QuickJS 的检查管不到）：`inVm` 捕获宿主异常，这次脚本失败，实例丢弃不再碰（release 版开着断言，dispose 会 abort），下一个脚本用新实例。 |
| 停止后还在跑 | signal 中止时立即 dispose，中止进行中的 AWS 调用和审批，之后到的结果丢弃。 |
| 审计泄密 | 见「设计」的审计一条。 |
| 结果里的注入 | 和其他工具一样放进围栏；`<` 转义，错误和日志也在围栏里。 |

后续修复：QuickJS 中断有时会被同步调用的 async 函数或 Promise executor 吞掉。现在脚本跑在 Worker 中，主进程可用 `worker.terminate()` 终止它，Stop 不再等脚本让出主线程。

## 验证

已验证（vitest，plain Node 22）：
- `sandbox.test.ts`：逃逸尝试（构造器链、`eval` / `Function`、`import()`、`globalThis` 探测、原型污染、getter 调宿主函数、Proxy）、参数校验（非字符串、数组、函数、Proxy）、死循环和只等待的脚本都按时停下、等审批不计时、内存炸弹、超长字符串、深递归、深层嵌套 JSON（宿主栈溢出后下一个脚本正常）、调用次数和并发上限、代码 / 结果 / 返回值 / 日志上限、停止时中止进行中的调用、没有 dispose 泄漏。
- `script.test.ts`：列出 → `parallel` 扇出 → 汇总、逐调用脱敏、写 / tier C / 名称不明 / `ce` 被拒且不调 AWS、tier B 合并审批（5 个并发的同类调用只出 1 张卡，敏感读取每次都问）、拒绝时抛「用户拒绝」、等卡片的时间不计时、输出截断、300 次上限、停止、`opts` 校验、错误和日志在围栏里、审计不含代码、参数和结果。
- `service.test.ts`（faux 模型）：45 次 `aws()` 的脚本是 1 次工具调用（超过 40 次的工具调用上限也不收尾）；事件里有代码和调用列表；审批时的等待行和卡片，允许后脚本继续。
- `ToolRow.test.tsx`：工具行文字、展开后的调用列表和纯文本代码，以及多张卡时的等待状态。
- `npm run build`：`out/main/sandbox.worker.js` 和相邻 chunks 包含 Worker 与内嵌 wasm，没有单独的 `.wasm` 文件要找。

没验证：
1. **完整打包后的界面**：已把构建出的 Worker 和相邻 chunks 放进临时 asar，并用 Electron 运行时执行本地脚本；尚未启动完整界面。
2. **真实模型**：模型会不会在该用脚本时用、写出能运行的脚本、返回精简的汇总，只用 faux 模型验证过。工具描述约 1.5 KB，没量 token。
3. **真实 AWS**：只对假 AWS 测过，没有用真实账号跑过并发查询，限流也没测。
4. **界面**：展开后的代码块在 320–640px 宽度下的版式只做过静态渲染测试。
