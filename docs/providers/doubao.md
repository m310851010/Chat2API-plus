# Doubao

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | doubao |
| 官网 | https://www.doubao.com |
| API Base | https://www.doubao.com |
| 认证 | Cookie |
| 凭据字段 | `cookie` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| doubao-pro-chat | doubao-pro-chat |
| doubao-deep-think | doubao-deep-think |

`doubao-pro-chat` 走豆包网页版默认对话 Bot（Pro 体验），`doubao-deep-think` 通过 `completion_option.use_deep_think` 开启深度思考，思考内容会输出到 `reasoning_content` 字段。

## 适配状态

已适配：流式对话、非流式对话、思考内容转发（`reasoning_content`）、提示词注入的工具调用（managed XML 协议）、单次会话模式下删除对话线程（`/samantha/thread/delete`）。

协议要点（参考开源项目 [doubao2api](https://github.com/wangchuxiaoji-oss/doubao2api) 实现）：

- `POST /samantha/chat/completion`，携带 `aid=582478`、`samantha_web=1`、桌面客户端版本字段及每次请求刷新的 `web_tab_id`；`msToken` 仅在已知时携带（空值会触发限流 710022002）。
- 请求体 `messages[0].content` 为 `JSON.stringify({ text })`，`content_type: 2001`；`completion_option.need_create_conversation: true`，每次请求新建上游会话（本代理将完整消息历史折叠进单条 prompt）。
- 请求头 `Agw-Js-Conv: str` 使网关以字符串返回 `event_data`。
- 响应为 SSE，`data:` 行内 JSON 事件：`event_type` 2001 为正文增量（`event_data.message.content` 中的 `text`），2002 携带新 `conversation_id`，2003 为结束，2008 / 10040 为思考内容（思考文本在 `content.think`）。
- 风控错误码 710022002 / 710022004 触发应用内滑块验证窗口（驱动真实豆包页面完成验证后重试）；登录过期等 JSON 错误体（如 `{"code":710012001,"msg":"登录已过期"}`）会上报为流错误。

后续验证：官网 Bot ID 变化、深度思考事件的字段升级、风险控制（验证码）场景。

## 教程

1. 登录 `https://www.doubao.com`。
2. 浏览器开发者工具（Application > Cookies > www.doubao.com）复制完整 Cookie 字符串（需包含 `sessionid`）。
3. 在供应商管理中添加豆包账号并粘贴 Cookie。
4. 模型管理中可使用内置默认模型，或手动添加别名映射。
