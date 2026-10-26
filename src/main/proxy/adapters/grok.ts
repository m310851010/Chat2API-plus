/**
 * Grok Web Proxy Adapter
 * Forwards OpenAI chat requests to grok.com /rest/app-chat/conversations/new.
 *
 * Protocol (reverse-engineered from grok-web2api / grok2api):
 * - POST https://grok.com/rest/app-chat/conversations/new with SSO cookie
 * - Body JSON: { temporary, modelName, modelMode, message, fileAttachments, ... }
 *   (the legacy modelSlug field is rejected with "Model is not found" — the
 *   upstream now selects models via modelName + modelMode pairs)
 * - Response: NDJSON stream, each line JSON with
 *   result.response.{token, isThinking, messageTag, isFinished}
 *
 * Uses Electron's `net` module (real Chromium network stack) together with a
 * dedicated session partition so browser cookies (grok_device_id, __cf_bm)
 * are collected the same way a real browser would.
 */

import { net, session } from 'electron'
import { Readable } from 'stream'
import { Account, Provider } from '../../store/types'
import type { ChatCompletionRequest } from '../types'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'

const GROK_URL = 'https://grok.com'
const CONVERSATION_ENDPOINT = `${GROK_URL}/rest/app-chat/conversations/new`

interface GrokModelSelection {
  modelName: string
  modelMode: string
}

const MODEL_SELECTIONS: Record<string, GrokModelSelection> = {
  'grok-3': { modelName: 'grok-3', modelMode: 'MODEL_MODE_GROK_3' },
  'grok-3-mini': { modelName: 'grok-3', modelMode: 'MODEL_MODE_GROK_3_MINI_THINKING' },
  'grok-3-thinking': { modelName: 'grok-3', modelMode: 'MODEL_MODE_GROK_3_THINKING' },
  'grok-4': { modelName: 'grok-4', modelMode: 'MODEL_MODE_GROK_4' },
  'grok-4-fast': { modelName: 'grok-4-1-thinking-1129', modelMode: 'MODEL_MODE_FAST' },
  'grok-4-mini': { modelName: 'grok-4-mini', modelMode: 'MODEL_MODE_GROK_4_MINI_THINKING' },
  'grok-4-thinking': { modelName: 'grok-4', modelMode: 'MODEL_MODE_GROK_4_THINKING' },
  'grok-auto': { modelName: 'grok-4', modelMode: 'MODEL_MODE_FAST' },
}

export function resolveGrokModelSelection(model: string): GrokModelSelection {
  if (MODEL_SELECTIONS[model]) return MODEL_SELECTIONS[model]
  const lower = model.toLowerCase()
  if (lower.includes('fast')) return MODEL_SELECTIONS['grok-4-fast']
  if (lower.includes('mini')) return MODEL_SELECTIONS['grok-3-mini']
  if (lower.includes('think')) return MODEL_SELECTIONS['grok-4-thinking']
  if (lower.includes('auto')) return MODEL_SELECTIONS['grok-auto']
  if (lower.includes('grok-3')) return MODEL_SELECTIONS['grok-3']
  return MODEL_SELECTIONS['grok-4']
}

export function resolveGrokModel(model: string): string {
  return resolveGrokModelSelection(model).modelName
}

function extractText(content: ChatCompletionRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((item: any) => item.type === 'text' && item.text)
      .map((item: any) => item.text)
      .join('\n')
  }
  return ''
}

function buildPrompt(messages: ChatCompletionRequest['messages']): string {
  const parts: string[] = []

  for (const msg of messages) {
    const role = msg.role
    const content = extractText(msg.content)

    if (role === 'system') {
      parts.push(`[System: ${content}]`)
    } else if (role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const calls = msg.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || '{}',
        }))
        const profile = getProviderToolProfile('grok')
        parts.push(`[Assistant]: ${content || ''}\n${profile.formatAssistantToolCalls(calls)}`)
      } else {
        parts.push(`[Assistant]: ${content}`)
      }
    } else if (role === 'tool') {
      const name = (msg as any).name || ''
      const contentText = extractText(msg.content)
      const profile = getProviderToolProfile('grok')
      parts.push(
        `[Tool result for ${name}]:\n${profile.formatToolResult({ toolCallId: (msg as any).tool_call_id || '', content: contentText })}`,
      )
    } else if (role === 'user') {
      parts.push(content)
    }
  }

  return parts.filter(part => part && part.trim()).join('\n\n')
}

const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export class GrokAdapter {
  private provider: Provider
  private account: Account
  private ssoToken: string
  private cookiePairs: Record<string, string> = {}

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account

    const credentials = account.credentials as Record<string, any>

    const parseCookieString = (raw: string): Record<string, string> => {
      const pairs: Record<string, string> = {}
      for (const part of raw.split(';')) {
        const idx = part.indexOf('=')
        if (idx > 0) {
          const key = part.slice(0, idx).trim()
          const value = part.slice(idx + 1).trim()
          if (key && value) pairs[key] = value
        }
      }
      return pairs
    }

    let pairs: Record<string, string> = {}
    const rawCookie = (
      credentials.cookie ||
      credentials.cookies ||
      credentials.token ||
      credentials.sso ||
      credentials['sso-rw'] ||
      credentials.sessionToken ||
      ''
    ).toString().trim()

    pairs = parseCookieString(rawCookie)
    if (!Object.keys(pairs).length) {
      // Single token value (e.g. just the sso value)
      pairs = { sso: rawCookie, 'sso-rw': rawCookie }
    }

    this.cookiePairs = pairs
    this.ssoToken = (pairs['sso'] || pairs['sso-rw'] || rawCookie).trim()
  }

  static isGrokProvider(provider: Provider): boolean {
    return provider.id === 'grok' || provider.apiEndpoint.includes('grok.com')
  }

  private buildRequestBody(
    prompt: string,
    selection: GrokModelSelection,
    conversationId?: string,
    temporary?: boolean,
  ): any {
    const body: any = {
      temporary: temporary !== undefined ? temporary : true,
      modelName: selection.modelName,
      modelMode: selection.modelMode,
      message: prompt,
      fileAttachments: [],
      imageAttachments: [],
      disableSearch: false,
      enableImageGeneration: false,
      returnImageBytes: false,
      returnRawGrokInXaiRequest: false,
      enableImageStreaming: false,
      imageGenerationCount: 2,
      forceOnce: false,
      isPreset: false,
      sendFinalMetadata: true,
      customInstructions: '',
    }
    if (conversationId) body.conversationId = conversationId
    return body
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    options: { conversationId?: string; temporary?: boolean } = {}
  ): Promise<{ stream: Readable; sessionId: string }> {
    if (!this.ssoToken) {
      throw new Error('No SSO token configured — get it from grok.com browser cookies')
    }

    const prompt = buildPrompt(request.messages)
    if (!prompt.trim()) {
      throw new Error('No usable content in request messages')
    }

    const modelSelection = resolveGrokModelSelection(request.model)
    const sessionId = options.conversationId || `grok-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

    const stream = new Readable({ read() {} })

    // Use a dedicated session partition so Set-Cookie responses (device id,
    // Cloudflare cookies) are stored and replayed like a real browser
    const ses = session.fromPartition(`grok-${sessionId}`)

    // Register parsed grok.com cookies (sso, sso-rw, grok_device_id, __cf_bm...)
    for (const [name, value] of Object.entries(this.cookiePairs)) {
      try {
        await ses.cookies.set({
          url: `${GROK_URL}/`,
          name,
          value,
          domain: '.grok.com',
          path: '/',
          secure: true,
          httpOnly: name !== 'grok_device_id' && name !== '__cf_bm',
          sameSite: 'no_restriction',
        })
      } catch (error) {
        console.warn('[Grok] Failed to set cookie:', name, error)
      }
    }

    const baseHeaders: Record<string, string> = {
      ...this.provider.headers,
    }
    if (!baseHeaders['User-Agent']) baseHeaders['User-Agent'] = FALLBACK_UA
    // The session cookie jar provides cookies; do not override the Cookie header

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const warmCookies = (): Promise<void> =>
      new Promise((resolve) => {
        const request_ = net.request({
          method: 'GET',
          url: `${GROK_URL}/`,
          session: ses,
          useSessionCookies: true,
        })
        request_.on('response', (response) => {
          response.on('data', () => {})
          response.on('end', () => resolve())
        })
        request_.on('error', () => resolve())
        // Small body-less GET
        request_.end()
      })

    const sendConversation = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const request_ = net.request({
          method: 'POST',
          url: CONVERSATION_ENDPOINT,
          session: ses,
          useSessionCookies: true,
        })

        for (const [key, value] of Object.entries(baseHeaders)) {
          request_.setHeader(key, value)
        }

        let errorBody = ''

        request_.on('response', (response) => {
          const statusCode = response.statusCode || 0

          if (statusCode === 401) {
            response.on('data', () => {})
            response.on('end', () => reject(new Error('grok.com: 401 unauthorized (SSO token expired or invalid)')))
            return
          }

          if (statusCode === 429) {
            response.on('data', () => {})
            response.on('end', () => reject(new Error('grok.com: rate limited (429)')))
            return
          }

          if (statusCode >= 400) {
            response.on('data', (chunk: Buffer) => {
              errorBody += chunk.toString()
            })
            response.on('end', () => {
              reject(new Error(`grok.com conversation failed: HTTP ${statusCode} ${errorBody.slice(0, 300)}`))
            })
            return
          }

          // Resolve on response headers so the caller receives the stream immediately;
          // data keeps flowing into the Readable as upstream batches arrive.
          // Resolving on 'end' instead would buffer the entire generation and hand
          // the client one full burst (breaking streaming output).
          resolve()
          response.on('data', (chunk) => stream.push(chunk))
          response.on('end', () => {
            stream.push(null)
          })
          response.on('error', (error) => {
            reject(error)
          })
        })

        request_.on('error', (error) => {
          reject(error)
        })

        request_.write(JSON.stringify(this.buildRequestBody(prompt, modelSelection, options.conversationId, options.temporary)))
        request_.end()
      })

    const run = async (attemptsLeft: number): Promise<void> => {
      await warmCookies()
      try {
        await sendConversation()
        return
      } catch (error) {
        // 401/429 are terminal; only retry transient/network failures
        const message = error instanceof Error ? error.message : String(error)
        const isTerminal = message.includes('401') || message.includes('429')
        const retryable = attemptsLeft > 0 && !isTerminal

        if (retryable) {
          console.warn('[Grok] Transient failure, retrying:', message)
          await delay(2000)
          await run(attemptsLeft - 1)
          return
        }

        stream.emit('error', error instanceof Error ? error : new Error(message))
      }
    }

    await run(2)

    return { stream, sessionId }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    // Grok temporary chats are auto-discarded; nothing to delete
    return true
  }
}

export const grokAdapter = {
  GrokAdapter,
}
