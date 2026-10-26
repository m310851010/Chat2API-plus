# Gemini

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | gemini |
| 官网 | https://gemini.google.com |
| API Base | https://gemini.google.com |
| 认证 | Cookie |
| 凭据字段 | `cookie` |
| 聊天协议 | `POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| gemini-3.7-flash | gemini-3.7-flash |
| gemini-3.6-flash | gemini-3.6-flash |
| gemini-3.5-flash | gemini-3.5-flash |
| gemini-3.5-flash-thinking | gemini-3.5-flash-thinking |
| gemini-3.5-flash-thinking-lite | gemini-3.5-flash-thinking-lite |
| gemini-3.1-pro | gemini-3.1-pro |
| gemini-auto | gemini-auto |
| gemini-flash-lite | gemini-flash-lite |

## 适配状态

已适配：流式对话、非流式对话、多轮会话、思考内容输出（thinking 系列模型输出到 `reasoning_content`）。

Cookie 要求：必须包含 `SID`、`HSID`、`SSID`、`APISID`、`SAPISID`、`__Secure-1PSID` 等关键 Cookie；请求以 `x-www-form-urlencoded` 提交并携带浏览器 User-Agent。

应用内浏览器登录：OAuth 登录页的 Gemini 标签页会自动从 `gemini.google.com` 采集 `__Secure-1PSID` / `SAPISID` 等 Cookie 并映射为 `cookie` 凭据。

## 教程

1. 登录 `https://gemini.google.com`。
2. 获取 Cookie（二选一）：
   - F12 打开 DevTools -> Application -> Cookies -> `https://gemini.google.com`，复制完整 Cookie 字符串（需包含上表关键 Cookie）；
   - 或使用应用内浏览器登录（OAuth 登录页），自动提取所需 Cookie。
3. 在供应商管理中添加 Gemini 账号，粘贴完整 Cookie。
4. 优先使用 `gemini-3.7-flash` 验证流式对话，思考模型使用 `gemini-3.5-flash-thinking`。
