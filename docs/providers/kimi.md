# Kimi

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | kimi |
| 官网 | https://www.kimi.com |
| API Base | https://www.kimi.com |
| 认证 | JWT Token |
| 凭据字段 | `token`、`refresh_token`（可选） |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| Kimi-K3 | kimi-k3 |
| Kimi-K2.8-Preview | kimi-k28-preview |
| Kimi-K2.6 | kimi-k2.6 |

## 适配状态

已适配：Connect JSON 对话接口、流式对话、非流式对话、多轮会话、账号级批量清理对话记录、联网搜索和思考参数。

K3 / K2.8 Preview 走官网的 `SCENARIO_OK_COMPUTER` 智能体场景（kimiplus id `ok-computer`），K2.6 沿用 `SCENARIO_K2D6`，其余模型回落到 `SCENARIO_CHAT`（`k2d6-chat`）。

支持 Token 自动续期：本地解析 JWT `exp` 判断过期，过期或上游返回 401（服务端吊销，例如异地重新登录）时通过 `auth.kimi.com` 的 RefreshToken 接口用 `refresh_token` 换取新 Access Token 并重试一次，新凭据回写到账号存储，重启后仍然有效。

后续验证：官网 `ChatService` 协议字段、批量删除接口的返回格式。

## 教程

1. 登录 `www.kimi.com`。
2. 获取 Access Token（推荐）：打开 DevTools -> Network，任选一个 `/apiv2/` 请求，复制请求头 `Authorization: Bearer` 后面的值；也可以从 Application -> Cookies 复制 `kimi-auth` 值。
3. （可选）获取 Refresh Token：DevTools -> Application -> Local Storage -> `www.kimi.com` -> `refresh_token`。填写后 Access Token 过期会自动续期。
4. 在供应商管理中添加 Kimi 账号，填入 `token`（以及可选的 `refresh_token`）。
5. 默认模型为 `Kimi-K3` / `Kimi-K2.8-Preview` / `Kimi-K2.6`；旧的 `Kimi-K2.5` 不再作为内置默认模型。
