/**
 * Gemini Web Proxy Adapter
 * Forwards OpenAI chat requests to gemini.google.com StreamGenerate endpoint.
 *
 * Protocol (reverse-engineered from gemini-web2api):
 * - POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
 * - Body: f.req=json([null, json(inner)]) where inner is a positional array
 * - Model selection via inner[79] (MODE_CATEGORY), thinking depth via inner[17]
 * - Response: chunked lines like ["wrb.fr", ...,"<json string>",...] where
 *   inner2[4][*][1][*] contains the growing response text
 */

import { net } from 'electron'
import { Readable } from 'stream'
import crypto from 'crypto'
import { Account, Provider } from '../../store/types'
import type { ChatCompletionRequest } from '../types'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'

const GEMINI_URL = 'https://gemini.google.com'
const STREAM_GENERATE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
const DEFAULT_BL = 'boq_assistant-bard-web-server_20260716.08_p0'

interface GeminiModelConfig {
  mode: number
  think: number
}

const MODEL_CONFIGS: Record<string, GeminiModelConfig> = {
  'gemini-3.7-flash': { mode: 1, think: 4 },
  'gemini-3.6-flash': { mode: 1, think: 4 },
  'gemini-3.5-flash': { mode: 1, think: 4 },
  'gemini-3.5-flash-thinking': { mode: 2, think: 0 },
  'gemini-3.5-flash-thinking-lite': { mode: 5, think: 0 },
  'gemini-3.1-pro': { mode: 3, think: 4 },
  'gemini-auto': { mode: 4, think: 4 },
  'gemini-flash-lite': { mode: 6, think: 4 },
}

export function resolveGeminiModel(model: string): { name: string; config: GeminiModelConfig } {
  let name = model
  let thinkOverride: number | undefined

  const thinkIndex = model.lastIndexOf('@think=')
  if (thinkIndex !== -1) {
    name = model.slice(0, thinkIndex)
    const parsed = Number.parseInt(model.slice(thinkIndex + 7), 10)
    if (Number.isFinite(parsed)) {
      // 0 = deepest, 4 = shallowest
      thinkOverride = Math.min(4, Math.max(0, parsed))
    }
  }

  if (MODEL_CONFIGS[name]) {
    return {
      name,
      config: thinkOverride !== undefined
        ? { ...MODEL_CONFIGS[name], think: thinkOverride }
        : MODEL_CONFIGS[name],
    }
  }

  const lower = name.toLowerCase()
  if (lower.includes('pro')) return { name: 'gemini-3.1-pro', config: MODEL_CONFIGS['gemini-3.1-pro'] }
  if (lower.includes('flash') && lower.includes('lite') && lower.includes('think')) {
    return { name: 'gemini-3.5-flash-thinking-lite', config: MODEL_CONFIGS['gemini-3.5-flash-thinking-lite'] }
  }
  if (lower.includes('think')) return { name: 'gemini-3.5-flash-thinking', config: MODEL_CONFIGS['gemini-3.5-flash-thinking'] }
  if (lower.includes('auto')) return { name: 'gemini-auto', config: MODEL_CONFIGS['gemini-auto'] }
  if (lower.includes('flash')) return { name: 'gemini-3.6-flash', config: MODEL_CONFIGS['gemini-3.6-flash'] }
  return { name: 'gemini-3.6-flash', config: MODEL_CONFIGS['gemini-3.6-flash'] }
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
      parts.push(`[System instruction]: ${content}`)
    } else if (role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const calls = msg.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || '{}',
        }))
        const profile = getProviderToolProfile('gemini')
        parts.push(`[Assistant]: ${content || ''}\n${profile.formatAssistantToolCalls(calls)}`)
      } else {
        parts.push(`[Assistant]: ${content}`)
      }
    } else if (role === 'tool') {
      const name = (msg as any).name || ''
      const contentText = extractText(msg.content)
      const profile = getProviderToolProfile('gemini')
      parts.push(
        `[Tool result for ${name}]:\n${profile.formatToolResult({ toolCallId: (msg as any).tool_call_id || '', content: contentText })}`,
      )
    } else if (role === 'user') {
      parts.push(content)
    }
  }

  return parts.filter(part => part && part.trim()).join('\n\n')
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function parseCookieString(cookieStr: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const pair of cookieStr.split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (key) map[key] = value
  }
  return map
}

interface GeminiSessionInfo {
  bl: string | null
  snlM0e: string | null
  fetchedAt: number
}

const SESSION_CACHE_TTL = 10 * 60 * 1000

// Per-account session cache (keyed by sha1 of cookie string).
// SNlM0e ("at" param) is required for authenticated StreamGenerate calls and is
// auto-extracted from the /app page together with the latest BL token — the
// user only needs to configure the Cookie.
const sessionCache: Record<string, GeminiSessionInfo> = {}

function cacheKeyForCookie(cookie: string): string {
  return crypto.createHash('sha1').update(cookie).digest('hex')
}

export class GeminiAdapter {
  private provider: Provider
  private account: Account
  private cookie: string
  private allCookies: Record<string, string>
  private authUser: string

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account

    const credentials = account.credentials as Record<string, any>

    // Manual-entry cookie string
    const cookieStr = credentials.cookie || credentials.sessionToken || credentials.token || ''

    // In-app login collected cookies (may be object or JSON string)
    let collected: Record<string, string> = {}
    const rawCookies = credentials.cookies
    if (rawCookies) {
      try {
        collected = typeof rawCookies === 'string'
          ? (JSON.parse(rawCookies as string) as Record<string, string>)
          : (rawCookies as Record<string, string>)
      } catch {
        collected = {}
      }
    }

    // Individually collected cookies from OAuth flow
    for (const name of ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID']) {
      if (credentials[name] && !collected[name]) {
        collected[name] = credentials[name]
      }
    }

    if (Object.keys(collected).length > 0 || cookieStr) {
      const parsed = cookieStr ? parseCookieString(cookieStr) : {}
      this.allCookies = { ...collected, ...parsed }
    } else {
      this.allCookies = {}
    }

    this.cookie = this.buildCookieHeader()
    this.authUser = String(credentials.authUser ?? credentials.auth_user ?? '').trim()
  }

  private buildCookieHeader(): string {
    return Object.entries(this.allCookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }

  private accountPrefix(): string {
    return this.authUser ? `/u/${this.authUser}` : ''
  }

  private makeSapisidhash(): string | null {
    const sapisid = this.allCookies['SAPISID']
    if (!sapisid) return null
    const ts = Math.floor(Date.now() / 1000)
    const hash = crypto
      .createHash('sha1')
      .update(`${ts} ${sapisid} ${GEMINI_URL}`)
      .digest('hex')
    return `SAPISIDHASH ${ts}_${hash}`
  }

  private buildParams(bl: string, at: string | null): string {
    const params = new URLSearchParams()
    params.set('bl', bl)
    params.set('hl', 'en')
    params.set('_reqid', String(Math.floor(Date.now() / 1000) % 1000000))
    params.set('rt', 'c')
    if (at) params.set('at', at)
    return params.toString()
  }

  static isGeminiProvider(provider: Provider): boolean {
    return provider.id === 'gemini' || provider.apiEndpoint.includes('gemini.google.com')
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    options: { temporaryChats?: boolean } = {}
  ): Promise<{ stream: Readable; sessionId: string }> {
    const prompt = buildPrompt(request.messages)
    if (!prompt.trim()) {
      throw new Error('No usable content in request messages')
    }

    const resolved = resolveGeminiModel(request.model)
    const { mode, think } = resolved.config
    const sessionId = uuid()

    const temporaryChats = options.temporaryChats !== false
    const prefix = this.accountPrefix()
    const sapisidhash = this.makeSapisidhash()

    const makeUrl = (bl: string, at: string | null) =>
      `${GEMINI_URL}${prefix}${STREAM_GENERATE_PATH}?${this.buildParams(bl, at)}`

    const makeHeaders = () => {
      const headers: Record<string, string> = {
        ...this.provider.headers,
        'Referer': `${GEMINI_URL}${prefix}/app`,
      }
      if (this.cookie) headers['Cookie'] = this.cookie
      if (prefix) headers['X-Goog-AuthUser'] = this.authUser
      if (sapisidhash) headers['Authorization'] = sapisidhash
      return headers
    }

    const buildBody = (bl: string) => {
      const inner: any[] = Array(80).fill(null)
      inner[0] = [prompt, 0, null, null, null, null, 0]
      inner[1] = ['en']
      inner[2] = ['', '', '', null, null, null, null, null, null, '']
      inner[6] = [0]
      inner[7] = 1
      inner[10] = 1
      inner[11] = 0
      inner[17] = [[think]]
      inner[18] = 0
      inner[27] = 1
      inner[30] = [4]
      inner[41] = temporaryChats ? [1] : [2]
      if (temporaryChats) inner[45] = 1
      inner[53] = 0
      inner[59] = sessionId
      inner[61] = []
      inner[68] = 1
      inner[79] = mode

      return `f.req=${encodeURIComponent(JSON.stringify([null, JSON.stringify(inner)]))}`
    }

    const stream = new Readable({ read() {} })
    let succeeded = false
    let failed = false
    let forceSessionRefresh = false

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const run = async (attemptsLeft: number): Promise<void> => {
      const info = await this.fetchSessionInfo(forceSessionRefresh)
      forceSessionRefresh = false
      const bl = info.bl || DEFAULT_BL
      const url = makeUrl(bl, info.snlM0e)
      const headers = makeHeaders()

      await new Promise<void>((resolve, reject) => {
        const request_ = net.request({ method: 'POST', url })
        for (const [key, value] of Object.entries(headers)) {
          request_.setHeader(key, value)
        }

        let errorBody = ''

        request_.on('response', (response) => {
          const statusCode = response.statusCode || 0

          if (statusCode === 405 && attemptsLeft > 0) {
            // BL likely outdated; invalidate cached session info and refresh on retry
            response.on('data', () => {})
            response.on('end', () => resolve())
            forceSessionRefresh = true
            return
          }

          if (statusCode === 401 || statusCode === 403) {
            response.on('data', (chunk: Buffer) => {
              errorBody += chunk.toString()
            })
            response.on('end', () => {
              failed = true
              const msg = `Gemini auth failed (HTTP ${statusCode}). Cookie may be expired or invalid. ${errorBody.slice(0, 200)}`
              stream.emit('error', new Error(msg))
              reject(new Error(msg))
            })
            return
          }

          if (statusCode >= 400) {
            response.on('data', (chunk: Buffer) => {
              errorBody += chunk.toString()
            })
            response.on('end', () => {
              const msg = `Gemini request failed (HTTP ${statusCode}): ${errorBody.slice(0, 300)}`
              if (attemptsLeft > 0) {
                resolve()
              } else {
                failed = true
                stream.emit('error', new Error(msg))
                reject(new Error(msg))
              }
            })
            return
          }

          succeeded = true
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
            failed = true
            stream.emit('error', error)
            reject(error)
          })
        })

        request_.on('error', (error) => {
          if (attemptsLeft > 0) {
            resolve()
          } else {
            failed = true
            stream.emit('error', error)
            reject(error)
          }
        })

        request_.write(buildBody(bl))
        request_.end()
      })

      if (succeeded || failed) return

      if (attemptsLeft > 0) {
        await delay(1500)
        await run(attemptsLeft - 1)
      } else {
        stream.emit('error', new Error('Gemini request failed after retries'))
      }
    }

    await run(3)

    return { stream, sessionId }
  }

  /**
   * Fetch per-account session info (latest BL + SNlM0e "at" token) from /app.
   * SNlM0e is mandatory for authenticated StreamGenerate requests; both values
   * are auto-extracted so the user only configures the cookie.
   */
  private fetchSessionInfo(force = false): Promise<{ bl: string | null; snlM0e: string | null }> {
    const key = cacheKeyForCookie(this.cookie)
    const cached = sessionCache[key]

    if (!force && cached && Date.now() - cached.fetchedAt < SESSION_CACHE_TTL) {
      return Promise.resolve({ bl: cached.bl, snlM0e: cached.snlM0e })
    }

    const fallback = () => {
      if (cached) return { bl: cached.bl, snlM0e: cached.snlM0e }
      sessionCache[key] = { bl: null, snlM0e: null, fetchedAt: Date.now() }
      return { bl: null, snlM0e: null }
    }

    return new Promise((resolve) => {
      let html = ''
      let timer: NodeJS.Timeout | undefined
      try {
        const req = net.request({ method: 'GET', url: `${GEMINI_URL}/app` })
        const headers: Record<string, string> = {
          ...this.provider.headers,
          'Referer': `${GEMINI_URL}/`,
        }
        if (this.cookie) headers['Cookie'] = this.cookie
        if (this.authUser) headers['X-Goog-AuthUser'] = this.authUser
        for (const [k, v] of Object.entries(headers)) {
          req.setHeader(k, v)
        }

        req.on('response', (response) => {
          response.on('data', (chunk: Buffer) => {
            html += chunk.toString()
          })
          response.on('end', () => {
            if (timer) clearTimeout(timer)
            const blMatch = html.match(/(boq_assistant-bard-web-server_\d+\.\d+_p\d+)/)
            const snlMatch = html.match(/"SNlM0e":"([^"]+)"/)
            const result = {
              bl: blMatch ? blMatch[1] : (cached?.bl ?? null),
              snlM0e: snlMatch ? snlMatch[1] : (cached?.snlM0e ?? null),
            }
            sessionCache[key] = { ...result, fetchedAt: Date.now() }
            resolve(result)
          })
        })

        req.on('error', () => {
          if (timer) clearTimeout(timer)
          resolve(fallback())
        })

        timer = setTimeout(() => {
          try {
            req.abort()
          } catch {
            // ignore
          }
          resolve(fallback())
        }, 20000)

        req.end()
      } catch {
        if (timer) clearTimeout(timer)
        resolve(fallback())
      }
    })
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    // Gemini temporary chats are auto-discarded; nothing to delete
    return true
  }
}

export const geminiAdapter = {
  GeminiAdapter,
}
