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
- 设备指纹：19 位 `device_id` 与 32 位指纹由账号 id 确定性派生，`web_tab_id` 每次请求刷新；响应头 `x-ms-token` 会被捕获并持久化到账号，后续请求与验证窗口复用。
- 响应为 SSE，`data:` 行内 JSON 事件：`event_type` 2001 为正文增量（`event_data.message.content` 中的 `text`），2002 携带新 `conversation_id`（单次会话模式下用于 `POST /samantha/thread/delete` 删除线程），2003 为结束，2008 / 10040 为思考内容（思考文本在 `content.think`）。
- 账号校验不走 ByteDance passport 接口（其拒绝豆包会话），而是拉取 `https://www.doubao.com/chat/` 页面，通过内嵌 `"user_id_str"` 判断登录态并提取用户名；登录过期等 JSON 错误体（如 `{"code":710012001,"msg":"登录已过期"}`）会上报为流错误。
- 风控错误码 710022002 / 710022004 触发应用内滑块验证窗口（打开真实豆包页面并在其输入框发送探针消息，由页面自身弹出官方滑块；用户完成并关闭窗口后，应用快照整个 cookie jar（更新后的 `msToken` / `ttwid`）回写账号凭证并重试，最多 3 次，单次窗口安全超时 3 分钟）。

后续验证：官网 Bot ID 变化、深度思考事件的字段升级。

## 教程

1. 登录 `https://www.doubao.com`。
2. 浏览器开发者工具（Application > Cookies > www.doubao.com）复制完整 Cookie 字符串（需包含 `sessionid`）。
3. 在供应商管理中添加豆包账号并粘贴 Cookie。
4. 模型管理中可使用内置默认模型，或手动添加别名映射。
