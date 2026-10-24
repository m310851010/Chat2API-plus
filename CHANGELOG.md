# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-10-24

### Added

- **New providers: ChatGPT, Gemini, Grok**
  - ChatGPT: web-based `gpt-5` family models (`auto`, `gpt-5`, `gpt-5-1`, `gpt-5-2`, `gpt-5-3`, `gpt-5-3-mini`, `gpt-5-mini`) via Access Token, with dedicated PoW / Turnstile / browser-impersonation support (`chatgpt-pow.ts`, `chatgpt-turnstile.ts`, `chatgpt-proxy.ts`)
  - Gemini: web-based Flash / Thinking / Pro models via the StreamGenerate protocol, Cookie auth
  - Grok: `grok-4` / `grok-4-fast` / `grok-3` family models via the app-chat NDJSON protocol, Cookie auth
- **Built-in Chat page**: in-app chat playground with conversations sidebar, streaming output, per-conversation model selection, fork and stop-generation support
- **Anthropic Messages API compatibility**: new `/v1/messages` endpoint that accepts Anthropic-format requests (tools, system prompts, thinking blocks) and translates them to OpenAI format, streaming Anthropic SSE events back (`src/main/proxy/routes/messages.ts`)
- **Dynamic model refresh service**: providers that expose a models API are polled every 30 minutes and their `supportedModels` / `/v1/models` lists stay in sync automatically (`modelRefreshService.ts`, `modelsFetchedAt` provider field)
- **Outbound API proxy**: configurable HTTP/HTTPS/SOCKS5 proxy URL for provider requests (`apiProxyUrl`), independent of the OAuth proxy mode
- **Account failover**: optional automatic retry on the next active account when a request fails (`accountFailoverRetry`)

### Changed

- Project rebranded to **Chat2API Plus** (product name, repository links, updater target)
- MiniMax model list refreshed: adds `MiniMax-M3`
- Z.ai model list refreshed (GLM-5.1 / GLM-5-Turbo / GLM-5V-Turbo / GLM-5 / GLM-4.7)
- Tool calling engine and stream parser updates for the Anthropic / managed XML / managed bracket protocols
- Provider card and add-account dialogs gained new credential field types and login-guide improvements

### Fixed

- Stream handling and session cleanup hardening across the GLM, Qwen AI and Z.ai adapters
- Tray and window manager stability fixes
