# ChatGPT

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | chatgpt |
| 官网 | https://chatgpt.com |
| API Base | https://chatgpt.com |
| 认证 | Access Token |
| 凭据字段 | `token` |
| 聊天协议 | `POST /backend-api/conversation`（SSE） |
| 模型列表接口 | `GET /backend-api/models?history_and_training_disabled=false` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| auto | auto |
| gpt-5 | gpt-5 |
| gpt-5-1 | gpt-5-1 |
| gpt-5-2 | gpt-5-2 |
| gpt-5-3 | gpt-5-3 |
| gpt-5-3-mini | gpt-5-3-mini |
| gpt-5-mini | gpt-5-mini |

## 适配状态

已适配：流式对话、非流式对话、多轮会话、账号校验（`GET /backend-api/me`）、动态模型列表刷新、Cloudflare Turnstile / PoW（工作量证明）与浏览器指纹伪装（`chatgpt-turnstile.ts`、`chatgpt-pow.ts`、`chatgpt-proxy.ts`），思考内容输出到 `reasoning_content`。

应用内浏览器登录：OAuth 登录页的 ChatGPT 标签页起始地址为 `https://chatgpt.com/auth/login`，登录窗口会自动捕获 `backend-api` 请求头中的 `authorization: Bearer` 值并映射为 `token` 凭据。

## 教程

1. 登录 `https://chatgpt.com`。
2. 获取 Access Token（二选一）：
   - 浏览器打开 `https://chatgpt.com/api/auth/session`，复制返回 JSON 中 `accessToken` 字段的值（推荐）；
   - 或使用应用内浏览器登录（OAuth 登录页），自动提取 Access Token。
3. 在供应商管理中添加 ChatGPT 账号，填入 `token`。
4. 默认模型 `auto` 会按网页端自动路由；也可手动添加别名映射。
