# 参与贡献

需要 Node.js ≥ 22.19。克隆仓库后运行：

```bash
npm ci
npm run dev
npm test
npm run typecheck
npm run build
npm run ai-smoke
```

提交 PR 前，请为行为变更补充测试，并运行 `npm test`、`npm run typecheck` 和 `npm run build`；AI 相关改动再运行 `npm run ai-smoke`。`ai-smoke` 使用本地假模型和断网守卫。真实 AWS 验证只在获授权的沙箱账号中进行；自动测试使用假凭证，不应使用开发机凭证创建 Console 会话。

PR 必须保持 AI 安全模型：普通模型卡片只能回复或打开链接，审批和变更确认只能在应用生成的系统卡片上完成；变更须经过两步确认。细节见 [开发文档](docs/DEVELOPMENT.md)和 [审批设计记录](docs/plans/ai-approval.md)。

提交信息请用简短的动词开头，说明改动内容；PR 描述写明原因、验证方式和未验证的部分。不要提交凭证、真实账号 ID 或含敏感数据的日志。
