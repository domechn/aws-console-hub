# 安全政策

## 支持版本

仅维护最新 `main` 分支。请先确认问题在最新代码中仍可复现。

## 私密报告

请通过本仓库 GitHub 的 **Private vulnerability reporting / Security advisories** 私密提交漏洞，附上影响、复现步骤和必要的脱敏日志。不要用公开 issue 报告漏洞，也不要粘贴凭证或真实账号信息。

维护者须在仓库设置中启用 GitHub Private vulnerability reporting。若私密报告入口不可用，请只开一个不含漏洞细节的 issue，请维护者提供私密联系方式。

## 凭证与数据边界

用户配置的凭证命令在本机 shell 中运行；输出的临时密钥用于 AWS STS、Console 联邦登录及应用执行的 AWS 查询（包括自动查询 EC2 名称），只留在内存，不写盘。每个账号的 `persist:account-<id>` 分区会在磁盘上保存 Console 登录 cookie 等会话数据；删除账号或修改登录身份时会清除该分区数据。手动重新登录会更新会话，不主动清空分区。应用没有遥测。具体数据流见 [README「隐私与安全」](README.md#隐私与安全)及 [开发文档「数据与凭证」](docs/DEVELOPMENT.md#数据与凭证)。

内嵌 AWS Console 页面的内容和行为由 AWS 提供。AI 助手会把提问、上下文和脱敏后的工具结果发给用户配置的 LLM 服务商；见 [开发文档「AI 助手」](docs/DEVELOPMENT.md#ai-助手)。请检查该服务商的数据处理政策。
