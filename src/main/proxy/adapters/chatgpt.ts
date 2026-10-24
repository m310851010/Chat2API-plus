/**
 * ChatGPT Adapter
 * Implements ChatGPT web backend API protocol with Access Token
 *
 * NOTE: Tool prompt injection is handled by Forwarder.transformRequestForPromptToolUse()
 * This adapter only handles message format conversion and API communication
 */

import axios, { AxiosResponse } from 'axios'
import type { Account, Provider } from '../../store/types'
import type { ChatCompletionRequest } from '../types'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import {
  buildLegacyRequirementsToken,
  buildProofToken,
  chatgptJsonRequest,
  newUUID,
  parsePowResources,
  PowResources,
} from './chatgpt-pow'
import { solveTurnstileToken } from './chatgpt-turnstile'
import { getProxyAgents, type ProxyAgents } from './chatgpt-proxy'

const CHATGPT_API_BASE = 'https://chatgpt.com'
const CLIENT_VERSION = 'prod-a194cd50d4416d3c0b47c740f206b12ce60f5887'
const CLIENT_BUILD_NUMBER = '6708908'

const FAKE_HEADERS = {
  Accept: 'text/event-stream',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  Origin: CHATGPT_API_BASE,
  Referer: `${CHATGPT_API_BASE}/`,
  'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  'Sec-Ch-Ua-Arch': '"x86"',
  'Sec-Ch-Ua-Bitness': '"64"',
  'Sec-Ch-Ua-Full-Version': '"143.0.3650.96"',
  'Sec-Ch-Ua-Full-Version-List': '"Microsoft Edge";v="143.0.3650.96", "Chromium";v="143.0.7499.147", "Not A(Brand";v="24.0.0.0"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Model': '""',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Ch-Ua-Platform-Version': '"19.0.0"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
  'OAI-Language': 'zh-CN',
  'OAI-Client-Version': CLIENT_VERSION,
  'OAI-Client-Build-Number': CLIENT_BUILD_NUMBER,
}

interface ChatGPTMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatRequirements {
  token: string
  proofToken: string
  turnstileToken: string
  soToken: string
}

interface RequirementsCache {
  requirements: ChatRequirements
  createdAt: number
}

const requirementsCache = new Map<string, RequirementsCache>()
const REQUIREMENTS_TTL = 120000

interface CookieCache {
  jar: Record<string, string>
  createdAt: number
}
/** Per-account Cloudflare/OpenAI cookies. Requests without them get 403 "Unusual activity". */
const cookieCache = new Map<string, CookieCache>()
const COOKIE_TTL = 1500000 // ~25 min, just under __cf_bm lifetime

function absorbCookies(
  jar: Record<string, string>,
  setCookieHeaders: string[] | undefined
): void {
  if (!setCookieHeaders) return
  for (const raw of setCookieHeaders) {
    const firstPair = raw.split(';')[0]
    const eq = firstPair.indexOf('=')
    if (eq > 0) {
      const name = firstPair.slice(0, eq).trim()
      const value = firstPair.slice(eq + 1).trim()
      if (name) jar[name] = value
    }
  }
}

function buildCookieHeader(jar: Record<string, string>): string {
  const parts = Object.entries(jar).map(([name, value]) => `${name}=${value}`)
  return parts.join('; ')
}

function buildBaseHeaders(token: string, deviceId: string, sessionId: string): Record<string, string> {
  return {
    ...FAKE_HEADERS,
    Authorization: `Bearer ${token}`,
    'OAI-Device-Id': deviceId,
    'OAI-Session-Id': sessionId,
  }
}

function withTargetPath(headers: Record<string, string>, path: string): Record<string, string> {
  return {
    ...headers,
    'X-OpenAI-Target-Path': path,
    'X-OpenAI-Target-Route': path,
  }
}

/** Convert OpenAI messages into ChatGPT web conversation messages. */
function toConversationMessages(messages: ChatGPTMessage[]): any[] {
  const toolProfile = getProviderToolProfile('chatgpt')
  const conversationMessages: any[] = []

  for (const item of messages) {
    let text: string
    let role = item.role

    if (item.role === 'assistant' && item.tool_calls && item.tool_calls.length > 0) {
      text = toolProfile.formatAssistantToolCalls(item.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })))
      role = 'assistant'
    } else if (item.role === 'tool') {
      text = toolProfile.formatToolResult({
        toolCallId: item.tool_call_id || '',
        content: String(item.content ?? ''),
      })
      role = 'user'
    } else if (Array.isArray(item.content)) {
      text = item.content
        .filter((p: any) => p && p.type === 'text')
        .map((p: any) => String(p.text || ''))
        .join('')
    } else {
      text = String(item.content ?? '')
    }

    if (!text && role !== 'system') {
      continue
    }

    conversationMessages.push({
      id: newUUID(),
      author: { role: role === 'system' ? 'system' : role },
      content: { content_type: 'text', parts: [text] },
    })
  }

  return conversationMessages
}

export function normalizeThinkingEffort(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized || normalized === 'none' || normalized === 'auto') return ''
  if (['low', 'medium', 'high', 'standard', 'max'].includes(normalized)) return normalized
  if (normalized === 'xhigh' || normalized === 'extended') return 'extended'
  return ''
}

export class ChatGPTAdapter {
  private provider: Provider
  private account: Account
  private token: string
  private deviceId: string
  private sessionId: string
  private powResources?: PowResources

  private getOrCreateJar(): Record<string, string> {
    const cached = cookieCache.get(this.account.id)
    if (cached && Date.now() - cached.createdAt < COOKIE_TTL) {
      return cached.jar
    }
    const jar: Record<string, string> = cached ? { ...cached.jar } : {}
    cookieCache.set(this.account.id, { jar, createdAt: Date.now() })
    return jar
  }

  private touchJar(): void {
    const cached = cookieCache.get(this.account.id)
    if (cached) {
      cookieCache.set(this.account.id, { jar: cached.jar, createdAt: Date.now() })
    }
  }

  private cookieHeader(jar: Record<string, string>): string | undefined {
    const line = buildCookieHeader(jar)
    return line || undefined
  }

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.token = account.credentials.token || ''
    this.deviceId = newUUID()
    this.sessionId = newUUID()
  }

  private assertToken(): string {
    if (!this.token) {
      throw new Error('ChatGPT Access Token not configured, please add Access Token in account settings')
    }
    return this.token
  }

  private async bootstrap(): Promise<PowResources> {
    if (this.powResources) {
      return this.powResources
    }

    const jar = this.getOrCreateJar()
    const cookie = this.cookieHeader(jar)

    const response = await axios.get(`${CHATGPT_API_BASE}/`, {
      headers: {
        'User-Agent': FAKE_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': FAKE_HEADERS['Accept-Language'],
        'Sec-Ch-Ua': FAKE_HEADERS['Sec-Ch-Ua'],
        'Sec-Ch-Ua-Mobile': FAKE_HEADERS['Sec-Ch-Ua-Mobile'],
        'Sec-Ch-Ua-Platform': FAKE_HEADERS['Sec-Ch-Ua-Platform'],
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      timeout: 30000,
      validateStatus: () => true,
      ...this.axiosAgentOptions(),
    })

    if (response.status < 200 || response.status >= 500) {
      throw new Error(`Failed to bootstrap ChatGPT page: HTTP ${response.status}`)
    }

    absorbCookies(jar, response.headers?.['set-cookie'] as unknown as string[])
    this.touchJar()

    const html = typeof response.data === 'string' ? response.data : ''
    this.powResources = parsePowResources(html)
    return this.powResources
  }

  private async getChatRequirements(): Promise<ChatRequirements> {
    const cacheKey = this.account.id
    const cached = requirementsCache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt < REQUIREMENTS_TTL) {
      return cached.requirements
    }

    this.assertToken()
    const token = this.token
    const baseHeaders = buildBaseHeaders(token, this.deviceId, this.sessionId)
    const { scriptSources, dataBuild } = await this.bootstrap()
    const userAgent = baseHeaders['User-Agent']
    const jar = this.getOrCreateJar()
    const cookie = this.cookieHeader(jar)

    const preparePath = '/backend-api/sentinel/chat-requirements/prepare'
    const requestToken = buildLegacyRequirementsToken(userAgent, scriptSources, dataBuild)
    const prepareResult = await chatgptJsonRequest(`${CHATGPT_API_BASE}${preparePath}`, {
      method: 'POST',
      headers: withTargetPath({
        ...baseHeaders,
        ...(cookie ? { Cookie: cookie } : {}),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }, preparePath),
      body: {
        p: requestToken,
      },
      timeout: 30000,
      agent: this.proxyAgents()?.httpsAgent,
    })

    absorbCookies(jar, prepareResult.setCookie)

    if (prepareResult.status !== 200 || !prepareResult.data) {
      throw new Error(`chat_requirements_prepare failed: HTTP ${prepareResult.status}`)
    }

    const prepareData = prepareResult.data

    if ((prepareData.arkose || {}).required) {
      throw new Error('chat requirements requires arkose token, which is not implemented')
    }

    let proofToken = ''
    const proofInfo = prepareData.proofofwork || {}
    if (proofInfo.required) {
      proofToken = buildProofToken(
        proofInfo.seed || '',
        proofInfo.difficulty || '',
        userAgent,
        scriptSources,
        dataBuild
      )
    }

    let turnstileToken = ''
    const turnstileInfo = prepareData.turnstile || {}
    if (turnstileInfo.required && turnstileInfo.dx) {
      turnstileToken = solveTurnstileToken(turnstileInfo.dx, requestToken) || ''
      if (!turnstileToken) {
        console.warn('[ChatGPT] Turnstile challenge detected but solver failed; continuing without turnstile token')
      }
    }

    const finalizePath = '/backend-api/sentinel/chat-requirements/finalize'
    const finalizeResult = await chatgptJsonRequest(`${CHATGPT_API_BASE}${finalizePath}`, {
      method: 'POST',
      headers: withTargetPath({
        ...baseHeaders,
        ...(this.cookieHeader(jar) ? { Cookie: this.cookieHeader(jar) } : {}),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }, finalizePath),
      body: {
        prepare_token: prepareData.prepare_token || '',
        proof_token: proofToken,
        turnstile_token: turnstileToken,
      },
      timeout: 30000,
      agent: this.proxyAgents()?.httpsAgent,
    })

    absorbCookies(jar, finalizeResult.setCookie)
    this.touchJar()

    if (finalizeResult.status !== 200 || !finalizeResult.data) {
      throw new Error(`chat_requirements_finalize failed: HTTP ${finalizeResult.status}`)
    }

    const data = finalizeResult.data
    const requirementsToken = String(data.token || '')
    if (!requirementsToken) {
      throw new Error(`missing auth chat requirements token: ${JSON.stringify(data)}`)
    }

    const requirements: ChatRequirements = {
      token: requirementsToken,
      proofToken,
      turnstileToken,
      soToken: String(data.so_token || ''),
    }

    requirementsCache.set(cacheKey, { requirements, createdAt: Date.now() })
    return requirements
  }

  private buildConversationPayload(
    messages: ChatCompletionRequest['messages'],
    model: string,
    thinkingEffort: string
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      action: 'next',
      messages: toConversationMessages(messages as ChatGPTMessage[]),
      model,
      parent_message_id: newUUID(),
      conversation_mode: { kind: 'primary_assistant' },
      conversation_origin: null,
      force_paragen: false,
      force_paragen_model_slug: '',
      force_rate_limit: false,
      force_use_sse: true,
      history_and_training_disabled: true,
      reset_rate_limits: false,
      suggestions: [],
      supported_encodings: [],
      system_hints: [],
      timezone: 'Asia/Shanghai',
      timezone_offset_min: -480,
      variant_purpose: 'comparison_implicit',
      websocket_request_id: newUUID(),
      client_contextual_info: {
        is_dark_mode: false,
        time_since_loaded: 120,
        page_height: 900,
        page_width: 1400,
        pixel_ratio: 2,
        screen_height: 1440,
        screen_width: 2560,
      },
    }
    const effort = normalizeThinkingEffort(thinkingEffort)
    if (effort) {
      payload.thinking_effort = effort
    }
    return payload
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; sessionId: string }> {
    const token = this.assertToken()
    const requirements = await this.getChatRequirements()

    const path = '/backend-api/conversation'

    const model =
      this.provider.modelMappings?.[request.model] ||
      request.model ||
      'auto'

    const effortLower = String(request.reasoning_effort || request.reasoningEffort || '').toLowerCase()
    const semanticModel = request.model.toLowerCase()
    let effort = effortLower
    if (!effort && /think|r1/.test(semanticModel)) {
      effort = 'medium'
    }

    const payload = this.buildConversationPayload(request.messages, model, effort)

    const headers: Record<string, string> = withTargetPath({
      ...buildBaseHeaders(token, this.deviceId, this.sessionId),
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'OpenAI-Sentinel-Chat-Requirements-Token': requirements.token,
    }, path)

    if (requirements.proofToken) {
      headers['OpenAI-Sentinel-Proof-Token'] = requirements.proofToken
    }
    if (requirements.turnstileToken) {
      headers['OpenAI-Sentinel-Turnstile-Token'] = requirements.turnstileToken
    }
    if (requirements.soToken) {
      headers['OpenAI-Sentinel-SO-Token'] = requirements.soToken
    }

    const jar = this.getOrCreateJar()
    if (!cookieCache.get(this.account.id)) {
      // ensure cookies exist before hitting the protected endpoint
      await this.bootstrap()
    }
    const cookie = this.cookieHeader(jar)
    if (cookie) {
      headers['Cookie'] = cookie
    }

    // Session id only serves as bookkeeping key; ChatGPT replays full history each turn
    const sessionId = `chatgpt-${this.account.id}`

    const response = await axios.post(
      `${CHATGPT_API_BASE}${path}`,
      payload,
      {
        headers,
        timeout: 300000,
        validateStatus: () => true,
        responseType: 'stream',
        ...this.axiosAgentOptions(),
      }
    )

    absorbCookies(jar, response.headers?.['set-cookie'] as unknown as string[])
    this.touchJar()

    console.log('[ChatGPT] Conversation response status:', response.status)

    if (response.status === 401) {
      requirementsCache.delete(this.account.id)
    }
    if (response.status === 403) {
      // Cloudflare/OpenAI device trust went stale; force a fresh cookie bootstrap next turn
      cookieCache.delete(this.account.id)
      requirementsCache.delete(this.account.id)
    }

    return { response, sessionId }
  }

  private proxyAgents(): ProxyAgents | null {
    return getProxyAgents()
  }

  private axiosAgentOptions(): { httpAgent?: ProxyAgents['httpAgent']; httpsAgent?: ProxyAgents['httpsAgent'] } {
    const agents = this.proxyAgents()
    return agents
      ? { httpAgent: agents.httpAgent, httpsAgent: agents.httpsAgent }
      : {}
  }

  async deleteSession(_sessionId: string): Promise<boolean> {
    // ChatGPT requests never persist server-side history (history_and_training_disabled)
    return true
  }

  /**
   * Fetch available models from the ChatGPT backend (mirrors chatgpt2api's list_models).
   * GET /backend-api/models?history_and_training_disabled=false with full browser
   * impersonation headers; response root field is `models[]` with `slug` as model id.
   */
  async listModels(): Promise<string[]> {
    const token = this.assertToken()

    const path = '/backend-api/models?history_and_training_disabled=false'
    const route = '/backend-api/models'

    if (!cookieCache.get(this.account.id)) {
      // ensure cookies exist before hitting the protected endpoint
      await this.bootstrap()
    }

    const headers = withTargetPath({
      ...buildBaseHeaders(token, this.deviceId, this.sessionId),
      Accept: 'application/json',
    }, route)

    const jar = this.getOrCreateJar()
    const cookie = this.cookieHeader(jar)
    if (cookie) {
      headers['Cookie'] = cookie
    }

    const response = await axios.get(`${CHATGPT_API_BASE}${path}`, {
      headers,
      timeout: 30000,
      validateStatus: () => true,
      ...this.axiosAgentOptions(),
    })

    absorbCookies(jar, response.headers?.['set-cookie'] as unknown as string[])
    this.touchJar()

    console.log('[ChatGPT] List models response status:', response.status)

    if (response.status !== 200) {
      throw new Error(`Failed to fetch ChatGPT models: HTTP ${response.status}`)
    }

    const rawModels = (response.data as { models?: unknown[] })?.models
    if (!Array.isArray(rawModels)) {
      throw new Error('Failed to fetch ChatGPT models: missing models array in response')
    }

    const slugs: string[] = []
    const seen = new Set<string>()
    for (const item of rawModels) {
      if (!item || typeof item !== 'object') continue
      const slug = String((item as { slug?: unknown }).slug || '').trim()
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      slugs.push(slug)
    }

    return slugs.sort()
  }

  static isChatGPTProvider(provider: Provider): boolean {
    return provider.id === 'chatgpt' || provider.apiEndpoint.includes('chatgpt.com')
  }
}

export const chatgptAdapter = {
  ChatGPTAdapter,
}
