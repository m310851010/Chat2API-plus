# Mimo

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | mimo |
| 官网 | https://aistudio.xiaomimimo.com |
| API Base | https://aistudio.xiaomimimo.com |
| 认证 | Cookie |
| 凭据字段 | `cookie`（完整 Cookie 字符串，需包含 `xiaomichatbot_serviceToken`（或 `serviceToken`）与 `xiaomichatbot_ph`） |
| 聊天协议 | `POST /open-apis/react/chat`（v3，现行）；404 时自动回退 `POST /open-apis/bot/chat`（v2，官方已提示"平台升级"） |
| 模型列表接口 | `GET /open-apis/bot/config`（公开接口，返回 `modelConfigList`） |
| 协议参考 | [mimo2api](https://github.com/NZX2007/webchat2api/blob/main/services/mimo2api/mimo2api.py)（v2 时代实现，本仓库已升级 v3） |

## 默认模型

与 `https://aistudio.xiaomimimo.com/open-apis/bot/config` 返回的 `modelConfigList` 保持一致：

| 显示名称 | 实际模型 ID |
| --- | --- |
| MiMo-V2.6-Flash | mimo-v2.6-flash |
| MiMo-V2.6-Pro | mimo-v2.6-pro |
| MiMo-V2.6-Pro-UltraSpeed | mimo-v2.6-pro-ultraspeed-studio |
| mimo-v2-flash | mimo-v2-flash |
| mimo-v2-pro | mimo-v2-pro |
| mimo-v2-omni | mimo-v2-omni |
| mimo-v2.5-pro | mimo-v2.5-pro |
| mimo-v2.5 | mimo-v2.5 |
| mimo-v2-flash-studio | mimo-v2-flash-studio |
| clawm-alpha | clawm-alpha |
| clawl-alpha | clawl-alpha |
| mimo-v2.1-omni | mimo-v2.1-omni |
| mimo-v2.1-omni-preview | mimo-v2.1-omni-preview |
| mimo-v2.1-pro | mimo-v2.1-pro |
| mimo-v2.1-pro-preview | mimo-v2.1-pro-preview |

## 适配状态

已适配：流式对话、非流式对话、多轮会话、会话保存、标题生成、账号级清理对话记录、托管工具调用、原生 `<tool_call>` 工具块解析、思考模式（`reasoning_content`）。

思考输出：

- v3（react/chat）协议下思考通过独立的 `reasoningContent` 字段下发，直接映射为 OpenAI `reasoning_content`；
- v2（bot/chat）回退时仍解析 `<think>...</think>` 标签（含 `\0` 变体），两种来源自动合并。

思考开关：

- 模型名加 `-think` / `-thinking` 后缀（如 `MiMo-V2.6-Pro-think`）会开启思考并在转发前剥掉后缀、映射回真实模型 ID；
- 请求携带 `reasoning_effort`（或 `X-Reasoning-Effort` 头）时开启思考；
- 模型名含 `think` / `r1` 时开启思考。

空回复自愈：上游被限流时常返回空回答，代理会等待 1.5 秒后追加提示语重试一次（流式与非流式均支持），重试产生的会话会一并纳入标题生成与会话清理；上游显式 `error` 事件（如登录过期、风控、平台升级提示）会作为可见内容返回且不触发重试。

## 教程

1. 打开 https://aistudio.xiaomimimo.com 并登录。
2. F12 打开 DevTools，从 Application -> Cookies（或 Network 任意请求的 Cookie 请求头）复制完整 Cookie 字符串，需包含 `serviceToken` 与 `xiaomichatbot_ph`。
3. 在供应商管理中添加 Mimo 账号，粘贴完整 Cookie（也支持应用内浏览器登录自动提取）。
4. 使用 `MiMo-V2.6-Pro` 作为首选验证模型。
