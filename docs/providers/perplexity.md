# Perplexity

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | perplexity |
| 官网 | https://www.perplexity.ai |
| API Base | https://www.perplexity.ai |
| 认证 | Cookie |
| 凭据字段 | `sessionToken` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| Auto | auto |
| Turbo | turbo |
| PPLX-Pro | pplx_pro |
| GPT-5 | gpt5 |
| Gemini-2.5-Pro | gemini25pro |
| Claude-Sonnet-4 | claude4sonnet |
| Claude-Opus-4 | claude4opus |
| Nemotron | nemotron |

## 适配状态

已适配：搜索增强对话、流式响应、非流式响应、账号级清理对话记录、多模型映射。

后续验证：官网模型代号、搜索来源字段、回答引用字段。

## 教程

1. 登录 `www.perplexity.ai`。
2. 打开 DevTools -> Application -> Cookies，复制 `__Secure-next-auth.session-token`。
3. 在供应商管理中添加 Perplexity 账号，填入 `sessionToken`。
4. 如需固定模型，在模型管理中选择对应显示名称。
