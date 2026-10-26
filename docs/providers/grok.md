# Grok

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | grok |
| 官网 | https://grok.com |
| API Base | https://grok.com |
| 认证 | Cookie |
| 凭据字段 | `cookie` |
| 聊天协议 | `POST /rest/app-chat/conversations/new`（NDJSON） |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| grok-4 | grok-4 |
| grok-4-fast | grok-4-fast |
| grok-3 | grok-3 |
| grok-3-mini | grok-3-mini |
| grok-auto | grok-auto |

## 适配状态

已适配：流式对话、非流式对话、多轮会话。响应为 NDJSON 格式（每行一个 JSON 对象），由流处理器转换为 OpenAI 兼容的 SSE / 完整响应。

Cookie 要求：粘贴完整 `grok.com` Cookie 字符串，关键 Cookie 为 `sso` / `sso-rw`；请求携带浏览器 User-Agent。

应用内浏览器登录：OAuth 登录页的 Grok 标签页会自动从 `grok.com` 采集 `sso` / `sso-rw` Cookie 并映射为 `cookie` 凭据。

## 教程

1. 登录 `https://grok.com`。
2. 获取 Cookie（二选一）：
   - F12 打开 DevTools -> Application -> Cookies -> `https://grok.com`，复制完整 Cookie 字符串（需包含 `sso` / `sso-rw`）；
   - 或使用应用内浏览器登录（OAuth 登录页），自动提取所需 Cookie。
3. 在供应商管理中添加 Grok 账号，粘贴完整 Cookie。
4. 优先使用 `grok-4` 验证流式与非流式对话。
