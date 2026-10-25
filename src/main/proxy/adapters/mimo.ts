/**
 * Mimo Adapter
 * Implements Mimo (Xiaomi AI Studio) API protocol
 */

import axios from 'axios'
import type { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import type { Account, Provider } from '../../store/types'
import type { ChatMessage } from '../types.ts'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../toolCalling/types.ts'
import { getProviderToolProfile } from '../toolCalling/providerProfiles.ts'

const MIMO_API_BASE = 'https://aistudio.xiaomimimo.com'

/**
 * Chat protocol paths. The web client sends chats to the react protocol (v3)
 * and only falls back to the legacy bot protocol (v2) when it 404s; the legacy
 * endpoint now replies with an upgrade notice ("平台升级…请刷新页面").
 */
const MIMO_CHAT_PATH_V3 = '/open-apis/react/chat'
const MIMO_CHAT_PATH_V2 = '/open-apis/bot/chat'

const MIMO_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

const MIMO_THINKING_SUFFIX = /-(think|thinking)$/i

/**
 * Nudge appended to a retried query when upstream returns an empty answer
 * (rate-limited replies arrive as empty SSE content, see mimo2api).
 */
export const MIMO_EMPTY_ANSWER_HINT = '（请直接回答用户的问题。）'

export interface MimoThinkingOptions {
  upstreamModel: string
  enableThinking: boolean
}

/**
 * Resolves the upstream model id and thinking switch the way the mimo2api
 * reference does: a `-think` / `-thinking` model suffix turns thinking on and
 * is stripped before the request reaches Xiaomi AI Studio; `reasoning_effort`
 * and think/r1 model names enable thinking without renaming the model.
 */
export function resolveMimoThinkingOptions(
  model: string,
  reasoningEffort?: string | null,
  modelMappings?: Record<string, string>
): MimoThinkingOptions {
  let upstreamModel = model.trim()
  let enableThinking = false

  if (MIMO_THINKING_SUFFIX.test(upstreamModel)) {
    enableThinking = true
    upstreamModel = upstreamModel.replace(MIMO_THINKING_SUFFIX, '')
  }

  if (!enableThinking && reasoningEffort) {
    enableThinking = true
  }

  const lower = upstreamModel.toLowerCase()
  if (!enableThinking && (lower.includes('think') || lower.includes('r1'))) {
    enableThinking = true
  }

  // A `-think` suffix survives model mapping (no exact display-name match),
  // so re-map the stripped base name back to its upstream id.
  if (modelMappings) {
    const mappedKey = Object.keys(modelMappings).find(
      (key) => key.toLowerCase() === upstreamModel.toLowerCase()
    )
    if (mappedKey) {
      upstreamModel = modelMappings[mappedKey]
    }
  }

  return { upstreamModel, enableThinking }
}

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

type MimoMessage = ChatMessage

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: MimoMessage[]
  stream?: boolean
  temperature?: number
  reasoning_effort?: 'low' | 'medium' | 'high'
}

interface MimoUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens: number
}

/**
 * v2 (bot/chat) nests the counters under a `usage` key; react/chat (v3) sends
 * them top-level with an OpenAI-style `nativeUsage` companion.
 */
function extractMimoUsage(data: any): MimoUsage | null {
  if (data?.usage && typeof data.usage.promptTokens === 'number') {
    return data.usage as MimoUsage
  }
  if (typeof data?.promptTokens === 'number') {
    return {
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens ?? 0,
      totalTokens: data.totalTokens ?? 0,
      reasoningTokens: data.nativeUsage?.completion_tokens_details?.reasoning_tokens ?? 0,
    }
  }
  return null
}

interface MimoChunk {
  type: 'text' | 'usage' | 'dialogId' | 'finish' | 'message'
  content?: string
  reasoningContent?: string
  messageType?: string
  usage?: MimoUsage
}

export interface ParsedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

function parseXmlParam(xml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const re = /<(?:parameter|arg) name="([^"]+)">((?:.|\n|\r)*?)<\/(?:parameter|arg)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const key = m[1]
    const val = m[2].trim()
    try {
      result[key] = JSON.parse(val)
    } catch {
      result[key] = val
    }
  }
  return result
}

function extractName(inner: string): string | null {
  let m = inner.match(/<name>([^<\n]+?)<\/name>/)
  if (m) return m[1].trim()
  m = inner.match(/<name=([^<>\n\/]+)/)
  if (m) return m[1].trim()
  return null
}

function normalizeToolCallMarkers(text: string): string {
  // Older captures carried mangled open markers; normalize before parsing
  return text.replace(/<tool_callgt;/g, '<tool_call>')
}

function parseMimoNativeToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  const normalized = normalizeToolCallMarkers(text)
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let block: RegExpExecArray | null
  while ((block = blockRe.exec(normalized)) !== null) {
    let inner = block[1].trim()
    if (inner.startsWith('<tool_result>')) inner = inner.slice('<tool_result>'.length).trim()
    if (inner.endsWith('</tool_result>')) inner = inner.slice(0, -'</tool_result>'.length).trim()
    if (inner.startsWith('{')) {
      try {
        const parsed = JSON.parse(inner)
        if (parsed.name) {
          let args: Record<string, unknown> = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {}
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args)
            } catch {
              args = { value: args }
            }
          }
          calls.push({
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            name: parsed.name,
            arguments: args,
          })
        }
      } catch {
        // skip
      }
    } else if (inner.includes('<name')) {
      const name = extractName(inner)
      if (!name) continue
      const args = parseXmlParam(inner)
      calls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name,
        arguments: args,
      })
    } else {
      const tagMatch = inner.match(/^<([a-zA-Z_][a-zA-Z0-9_]*)>/)
      if (!tagMatch) continue
      const name = tagMatch[1].trim()
      const args: Record<string, unknown> = {}
      const paramRe4 = /<([a-zA-Z_][a-zA-Z0-9_]*?)>((?:.|\n|\r)*?)<\/\1>/g
      let pm: RegExpExecArray | null
      while ((pm = paramRe4.exec(inner)) !== null) {
        if (pm[1] === name) continue
        const key = pm[1].trim()
        const val = pm[2].trim()
        try {
          args[key] = JSON.parse(val)
        } catch {
          args[key] = val
        }
      }
      calls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name,
        arguments: args,
      })
    }
  }
  return calls
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  if (text.includes('<tool_call')) {
    const calls = parseMimoNativeToolCalls(text)
    return calls
  }
  const calls: ParsedToolCall[] = []
  const blockRe = /<function_calls>([\s\S]*?)<\/function_calls>/g
  let block: RegExpExecArray | null
  while ((block = blockRe.exec(text)) !== null) {
    const invokeRe = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g
    let inv: RegExpExecArray | null
    while ((inv = invokeRe.exec(block[1])) !== null) {
      calls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name: inv[1],
        arguments: parseXmlParam(inv[2]),
      })
    }
  }
  return calls
}

export function hasToolCallMarker(text: string): boolean {
  return text.includes('<tool_call') || text.includes('<function_calls>')
}

/** Removes parsed native tool-call blocks from visible content (mimo2api parity). */
function stripNativeToolCallBlocks(text: string): string {
  return normalizeToolCallMarkers(text)
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .trim()
}

/** Extracts a single cookie value from a raw `k1=v1; k2=v2` cookie string. */
export function parseCookieValue(cookieString: string, name: string): string {
  for (const pair of cookieString.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() === name) {
      const value = pair.slice(eq + 1).trim()
      // Cookie values may be serialized with surrounding double quotes
      if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1)
      }
      return value
    }
  }
  return ''
}

/** The login-state cookie ships as either `serviceToken` or `xiaomichatbot_serviceToken`. */
export function getMimoServiceToken(cookieString: string): string {
  return (
    parseCookieValue(cookieString, 'xiaomichatbot_serviceToken') ||
    parseCookieValue(cookieString, 'serviceToken')
  )
}

const CITATION_PATTERN = '(?:从)?\\(citation:\\d+\\)(?:中[：:])?'
const CITATION_PATTERN_LOOSE = 'citation:\\d+'
const CITATION_START = '(citation'

function stripCitations(text: string): string {
  return text
    .replace(/从\(citation:\d+\)中[：:]\s*/g, '')
    .replace(/-?\s*citation:\d+[：:]\s*/g, '')
    .replace(/[（\(]\s*citation:\d+(?:,\s*citation:\d+)*\s*[）\)]/g, '')
    .replace(/citation:\d+(?:,\s*citation:\d+)*/g, '')
    .replace(/\(citation:\d+\)/g, '')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripCitationsWithBuffer(text: string, buffer: { value: string }): string {
  const combined = buffer.value + text
  
  let cleaned = combined
    .replace(/从\(citation:\d+\)中[：:]\s*/g, '')
    .replace(/-?\s*citation:\d+[：:]\s*/g, '')
    .replace(/[（\(]\s*citation:\d+(?:,\s*citation:\d+)*\s*[）\)]/g, '')
    .replace(/citation:\d+(?:,\s*citation:\d+)*/g, '')
    .replace(/\(citation:\d+\)/g, '')
    .replace(/\[\d+\]/g, '')
  
  const lastCitationStart = cleaned.lastIndexOf(CITATION_START)
  if (lastCitationStart !== -1) {
    const afterCitation = cleaned.slice(lastCitationStart)
    if (!afterCitation.includes(')')) {
      buffer.value = afterCitation
      cleaned = cleaned.slice(0, lastCitationStart)
    } else {
      buffer.value = ''
    }
  } else {
    buffer.value = ''
  }
  
  return cleaned.replace(/\s+/g, ' ').trim()
}

function stripThinkTags(text: string): string {
  text = text.replace(/\u0000/g, '')
  // Remove opening think tag (including partial ones at the beginning)
  text = text.replace(/^<think[^>]*>/, '')
  // Remove &gt; entity which might be part of a broken tag
  text = text.replace(/^&gt;/, '')
  // Also handle cases where only part of the tag is present
  text = text.replace(/^hink>/, '')
  text = text.replace(/^ink>/, '')
  text = text.replace(/^nk>/, '')
  text = text.replace(/^k>/, '')
  text = text.replace(/^>/, '')
  return text
}

function stripThink(text: string): string {
  text = text.replace(/\u0000/g, '')
  text = text.replace(/<think[\s\S]*?<\/think>/g, '')
  text = text.replace(/<think[\s\S]*?<\/thinkgt;/g, '')
  const openIdx = text.indexOf('<think')
  if (openIdx !== -1) text = text.slice(0, openIdx)
  return text.trimStart()
}

function extractThinkContent(text: string): { thinking: string; content: string } {
  let thinking = ''
  let content = text

  const thinkRegex = /<think[^>]*>([\s\S]*?)<\/think>/g
  let match
  while ((match = thinkRegex.exec(text)) !== null) {
    thinking += match[1]
  }

  const thinkRegex2 = /<think[^>]*>([\s\S]*?)<\/thinkgt;/g
  while ((match = thinkRegex2.exec(text)) !== null) {
    thinking += match[1]
  }

  content = stripThink(text)

  const openIdx = text.indexOf('<think')
  if (openIdx !== -1 && !text.includes('</think') && !text.includes('</thinkgt;')) {
    const partialThink = text.slice(openIdx)
    thinking += partialThink.replace(/<think[^>]*>/, '')
  }

  return { thinking, content }
}

function extractTextContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part === 'object' && part !== null && part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('\n')
  }
  return ''
}

export function buildMimoQuery(messages: MimoMessage[]): string {
  const toolProfile = getProviderToolProfile('mimo')
  const entries: Array<{ role: string; content: string }> = []

  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      entries.push({
        role: 'Assistant',
        content: toolProfile.formatAssistantToolCalls(message.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }))),
      })
      continue
    }

    if (message.role === 'tool' && message.tool_call_id) {
      entries.push({
        role: 'User',
        content: toolProfile.formatToolResult({
          toolCallId: message.tool_call_id,
          content: extractTextContent(message.content),
        }),
      })
      continue
    }

    const content = extractTextContent(message.content).trim()
    if (!content) {
      continue
    }

    const role = message.role === 'system'
      ? 'System'
      : message.role === 'assistant'
        ? 'Assistant'
        : 'User'

    entries.push({ role, content })
  }

  if (entries.length === 1 && entries[0].role === 'User') {
    return entries[0].content
  }

  return entries.map((entry) => `${entry.role}: ${entry.content}`).join('\n\n')
}

export class MimoAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getCredentials(): { cookie: string; phToken: string } {
    const credentials = this.account.credentials

    // Legacy accounts store three split fields; compose them back into one
    // cookie string. New accounts store the full browser cookie string.
    const legacyParts: string[] = []
    if (credentials.service_token) legacyParts.push(`serviceToken=${credentials.service_token}`)
    if (credentials.user_id) legacyParts.push(`userId=${credentials.user_id}`)
    if (credentials.ph_token) legacyParts.push(`xiaomichatbot_ph=${credentials.ph_token}`)

    const cookie = (credentials.cookie || legacyParts.join('; ')).trim()
    const phToken = parseCookieValue(cookie, 'xiaomichatbot_ph') || credentials.ph_token || ''
    return { cookie, phToken }
  }

  static isMimoProvider(provider: Provider): boolean {
    return provider.id === 'mimo' || provider.name?.toLowerCase().includes('mimo')
  }

  private buildUrl(path: string, phToken: string): string {
    return `${MIMO_API_BASE}${path}?xiaomichatbot_ph=${encodeURIComponent(phToken)}`
  }

  private buildHeaders(cookie: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: MIMO_API_BASE,
      Referer: `${MIMO_API_BASE}/`,
      'User-Agent': MIMO_USER_AGENT,
      'X-Timezone': 'Asia/Shanghai',
      Accept: '*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Sec-Ch-Ua': '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    }
  }

  private async saveConversation(conversationId: string): Promise<void> {
    const { cookie, phToken } = this.getCredentials()
    const response = await axios.post(
      this.buildUrl('/open-apis/chat/conversation/save', phToken),
      {
        conversationId,
        title: '新对话',
        type: 'chat',
      },
      {
        headers: this.buildHeaders(cookie),
        timeout: 30000,
        validateStatus: () => true,
      }
    )

    const { code, msg, message } = response.data || {}
    if (response.status !== 200 || code !== 0) {
      throw new Error(`Mimo failed to save conversation: ${msg || message || `HTTP ${response.status}`}`)
    }
  }

  async generateConversationTitle(conversationId: string, query: string, answer: string): Promise<boolean> {
    const content = `${query} ${answer}`.trim()
    if (!conversationId || !content) {
      return false
    }

    try {
      const { cookie, phToken } = this.getCredentials()
      const response = await axios.post(
        this.buildUrl('/open-apis/chat/conversation/genTitle', phToken),
        {
          conversationId,
          content,
        },
        {
          headers: this.buildHeaders(cookie),
          timeout: 30000,
          validateStatus: () => true,
        }
      )

      const { code } = response.data || {}
      if (response.status !== 200 || code !== 0) {
        console.warn('[Mimo] Failed to generate conversation title:', response.status, response.data)
        return false
      }
      return true
    } catch (error) {
      console.warn('[Mimo] Failed to generate conversation title:', error)
      return false
    }
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    querySuffix?: string
  ): Promise<{
    response: AxiosResponse
    conversationId: string
    query: string
  }> {
    const { cookie, phToken } = this.getCredentials()

    if (!cookie || !phToken) {
      throw new Error(
        'Mimo credentials not configured. Paste the full aistudio.xiaomimimo.com cookie string (must include serviceToken and xiaomichatbot_ph) in account settings.'
      )
    }

    const conversationId = uuid(false)
    const msgId = uuid(false).slice(0, 32)
    const baseQuery = buildMimoQuery(request.messages)
    const query = querySuffix ? `${baseQuery}\n\n${querySuffix}` : baseQuery
    await this.saveConversation(conversationId)

    const { upstreamModel, enableThinking } = resolveMimoThinkingOptions(
      request.model,
      request.reasoning_effort,
      this.provider.modelMappings
    )

    const requestBody = {
      msgId,
      conversationId,
      query,
      isEditedQuery: false,
      modelConfig: {
        enableThinking,
        webSearchStatus: 'disabled',
        model: upstreamModel,
        temperature: request.temperature ?? 0.8,
        topP: 0.95,
      },
      multiMedias: [],
    }

    const sendChat = (path: string) =>
      axios({
        method: 'POST',
        url: this.buildUrl(path, phToken),
        data: requestBody,
        responseType: 'stream',
        headers: this.buildHeaders(cookie),
        // A 404 from the react protocol must not throw so we can fall back
        validateStatus: () => true,
      })

    let response = await sendChat(MIMO_CHAT_PATH_V3)
    if (response.status === 404) {
      // Legacy backend without the react protocol — mirror the web client's
      // v3 -> v2 fallback
      console.warn('[Mimo] react/chat unavailable (404), falling back to bot/chat')
      response = await sendChat(MIMO_CHAT_PATH_V2)
    }

    return { response, conversationId, query }
  }

  private async getConversationList(pageNum: number = 1, pageSize: number = 100): Promise<{
    conversationIds: string[]
    hasMore: boolean
  }> {
    const { cookie, phToken } = this.getCredentials()

    if (!cookie || !phToken) {
      throw new Error('Mimo credentials not configured')
    }

    const url = `${MIMO_API_BASE}/open-apis/chat/conversation/list?xiaomichatbot_ph=${encodeURIComponent(phToken)}`

    const response = await axios.post(
      url,
      {
        pageInfo: {
          pageNum,
          pageSize,
        },
      },
      {
        headers: this.buildHeaders(cookie),
        timeout: 30000,
        validateStatus: () => true,
      }
    )

    console.log('[Mimo] Get conversation list page', pageNum, 'response:', JSON.stringify(response.data, null, 2))

    const { code, data } = response.data || {}
    if (response.status !== 200 || code !== 0) {
      console.error('[Mimo] Failed to get conversation list')
      return { conversationIds: [], hasMore: false }
    }

    const conversationList = data?.dataList || []
    const conversationIds = conversationList.map((c: any) => c.conversationId).filter(Boolean)
    const hasMore = conversationList.length >= pageSize

    console.log('[Mimo] Found', conversationIds.length, 'conversations, hasMore:', hasMore)
    return { conversationIds, hasMore }
  }

  private async deleteConversations(conversationIds: string[]): Promise<boolean> {
    if (conversationIds.length === 0) {
      return true
    }

    const { cookie, phToken } = this.getCredentials()

    if (!cookie || !phToken) {
      throw new Error('Mimo credentials not configured')
    }

    const url = `${MIMO_API_BASE}/open-apis/chat/conversation/delete?xiaomichatbot_ph=${encodeURIComponent(phToken)}`

    const response = await axios.post(
      url,
      conversationIds,
      {
        headers: this.buildHeaders(cookie),
        timeout: 60000,
        validateStatus: () => true,
      }
    )

    console.log('[Mimo] Delete conversations response:', JSON.stringify(response.data, null, 2))

    const { code } = response.data || {}
    return response.status === 200 && code === 0
  }

  async deleteSession(conversationId: string): Promise<boolean> {
    if (!conversationId) {
      return false
    }
    return await this.deleteConversations([conversationId])
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const allConversationIds: string[] = []
      let pageNum = 1
      let hasMore = true

      while (hasMore) {
        const { conversationIds, hasMore: more } = await this.getConversationList(pageNum, 100)
        allConversationIds.push(...conversationIds)
        hasMore = more
        pageNum++

        if (conversationIds.length === 0) {
          break
        }
      }

      if (allConversationIds.length === 0) {
        console.log('[Mimo] No conversations to delete')
        return true
      }

      console.log('[Mimo] Found', allConversationIds.length, 'conversations to delete')

      const success = await this.deleteConversations(allConversationIds)
      if (success) {
        console.log('[Mimo] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[Mimo] Failed to delete all chats:', error)
      return false
    }
  }
}

export class MimoStreamHandler {
  private model: string
  private conversationId: string
  private content: string = ''
  private thinking: string = ''
  private usage: MimoUsage | null = null
  private dialogId: string = ''
  private toolCalls: ParsedToolCall[] = []
  private thinkingMode: 'passthrough' | 'strip' | 'separate' = 'strip'
  private lastSentContentLen: number = 0
  private lastSentThinkLen: number = 0
  private toolCallBuf: string | null = null
  private pendingText: string = ''
  private citationBuffer: { value: string } = { value: '' }
  private thinkingCitationBuffer: { value: string } = { value: '' }
  private toolStreamParser?: ToolStreamParser
  private retryStream?: () => Promise<NodeJS.ReadableStream | null>
  private retried: boolean = false
  private sawUpstreamError: boolean = false

  constructor(
    model: string,
    conversationId: string,
    thinkingMode: 'passthrough' | 'strip' | 'separate' = 'strip',
    toolCallingPlan?: ToolCallingPlan,
    retryStream?: () => Promise<NodeJS.ReadableStream | null>
  ) {
    this.model = model
    this.conversationId = conversationId
    this.thinkingMode = thinkingMode
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
    this.retryStream = retryStream
  }

  async *handleStream(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
    const id = `chatcmpl-${uuid(false)}`
    const created = Math.floor(Date.now() / 1000)

    yield this.formatOpenAIChunk(id, created, { role: 'assistant', content: '' }, 'role')

    yield* this.pumpUpstreamEvents(stream, id, created)

    const retryStream = await this.openRetryStreamIfNeeded()
    if (retryStream) {
      yield* this.pumpUpstreamEvents(retryStream, id, created)
    }

    const flushChunks = this.toolStreamParser?.flush(this.createBaseChunk(id, created)) ?? []
    for (const chunk of flushChunks) {
      yield `data: ${JSON.stringify(chunk)}\n\n`
    }

    yield this.formatOpenAIChunk(id, created, {}, this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop')

    if (this.usage) {
      yield this.formatOpenAIUsageChunk(id, created, this.usage)
    }
  }

  private async *pumpUpstreamEvents(
    stream: NodeJS.ReadableStream,
    id: string,
    created: number
  ): AsyncGenerator<string> {
    let buffer = ''
    let currentEvent = ''

    // Track state and content
    let state: 'init' | 'thinking' | 'content' = 'init'
    let totalContent = ''
    let lastProcessedIndex = 0
    let thinkEndTagFound = false
    const thinkEndTag1 = '</think>'
    const thinkEndTag2 = '</thinkgt;'

    for await (const chunk of stream) {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()

        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim()
        } else if (trimmed.startsWith('data:')) {
          try {
            const dataStr = trimmed.slice(5).trim()
            const data = JSON.parse(dataStr)
            const mimoChunk: MimoChunk = { type: currentEvent as any, ...data }

            // react/chat (v3) streams reasoning as a dedicated field instead
            // of <think> tags
            if (typeof data.reasoningContent === 'string' && data.reasoningContent) {
              this.thinking += data.reasoningContent
              if (this.thinkingMode === 'separate') {
                const cleaned = stripCitationsWithBuffer(data.reasoningContent, this.thinkingCitationBuffer)
                if (cleaned) {
                  yield this.formatOpenAIChunk(id, created, { reasoning_content: cleaned })
                }
              }
            }

            if (currentEvent === 'error' && typeof data.content === 'string' && data.content) {
              // Surface upstream errors (auth expiry, risk control, upgrade
              // notices) visibly instead of dropping them silently
              console.warn('[Mimo] Upstream error event:', data.content)
              this.sawUpstreamError = true
              yield this.formatOpenAIChunk(id, created, { content: `\n\n[Mimo] ${data.content}` })
            } else if ((mimoChunk.type === 'message' || mimoChunk.type === 'text') && mimoChunk.content) {
              const newText = (mimoChunk.content ?? '').replace(/\u0000/g, '')
              totalContent += newText
              this.content = totalContent

              if (state === 'init') {
                const thinkStartIdx = totalContent.indexOf('<think')
                if (thinkStartIdx !== -1) {
                  state = 'thinking'
                  // Skip any content before <think tag
                  lastProcessedIndex = thinkStartIdx
                } else {
                  state = 'content'
                }
              }

              if (state === 'thinking') {
                if (!thinkEndTagFound) {
                  // Look for think end tag
                  let thinkEndIdx = totalContent.indexOf(thinkEndTag1, lastProcessedIndex)
                  let actualEndTag = thinkEndTag1
                  
                  if (thinkEndIdx === -1) {
                    thinkEndIdx = totalContent.indexOf(thinkEndTag2, lastProcessedIndex)
                    actualEndTag = thinkEndTag2
                  }

                  if (thinkEndIdx !== -1) {
                    // Found the end of thinking
                    thinkEndTagFound = true
                    
                    // Extract the thinking content between lastProcessedIndex and thinkEndIdx
                    const thinkContent = totalContent.slice(lastProcessedIndex, thinkEndIdx)
                    const cleanedThink = stripThinkTags(thinkContent)
                    const cleanedThinkWithCitations = stripCitationsWithBuffer(cleanedThink, this.thinkingCitationBuffer)
                    
                    if (cleanedThinkWithCitations && this.thinkingMode === 'separate') {
                      yield this.formatOpenAIChunk(id, created, { reasoning_content: cleanedThinkWithCitations })
                    }
                    
                    // Move past the end tag
                    lastProcessedIndex = thinkEndIdx + actualEndTag.length
                    state = 'content'
                  } else {
                    // Still in thinking, process new content
                    const thinkContent = totalContent.slice(lastProcessedIndex)
                    const cleanedThink = stripThinkTags(thinkContent)
                    const cleanedThinkWithCitations = stripCitationsWithBuffer(cleanedThink, this.thinkingCitationBuffer)
                    
                    if (cleanedThinkWithCitations && this.thinkingMode === 'separate') {
                      yield this.formatOpenAIChunk(id, created, { reasoning_content: cleanedThinkWithCitations })
                    }
                    
                    lastProcessedIndex = totalContent.length
                  }
                }
              }
              
              if (state === 'content' && lastProcessedIndex < totalContent.length) {
                // Process content after thinking
                const contentPart = totalContent.slice(lastProcessedIndex)
                const cleanedContent = stripCitationsWithBuffer(contentPart, this.citationBuffer)
                
                if (cleanedContent) {
                  if (this.toolStreamParser) {
                    const chunks = this.toolStreamParser.push(cleanedContent, this.createBaseChunk(id, created))
                    for (const chunk of chunks) {
                      yield `data: ${JSON.stringify(chunk)}\n\n`
                    }
                    if (chunks.length > 0 || this.toolStreamParser.isBuffering() || this.toolStreamParser.hasEmittedToolCall()) {
                      lastProcessedIndex = totalContent.length
                      continue
                    }
                  }
                  yield this.formatOpenAIChunk(id, created, { content: cleanedContent })
                }
                
                lastProcessedIndex = totalContent.length
              }
            } else if (mimoChunk.type === 'usage') {
              const usage = extractMimoUsage(data)
              if (usage) this.usage = usage
            } else if (mimoChunk.type === 'dialogId' && mimoChunk.content) {
              this.dialogId = mimoChunk.content
            }
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    }
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<string> {
    await this.consumeUpstream(stream)

    const retryStream = await this.openRetryStreamIfNeeded()
    if (retryStream) {
      this.content = ''
      await this.consumeUpstream(retryStream)
    }

    // Check for tool calls
    if (hasToolCallMarker(this.content)) {
      this.toolCalls = parseToolCalls(this.content)
    }

    // Process thinking content based on mode
    let finalContent = this.content
    let reasoningContent: string | undefined

    if (this.thinkingMode === 'strip') {
      finalContent = stripThink(this.content)
    } else if (this.thinkingMode === 'separate') {
      const extracted = extractThinkContent(this.content)
      finalContent = extracted.content
      reasoningContent = extracted.thinking
    }

    // react/chat reasoning arrives via the reasoningContent field rather than
    // <think> tags; merge both sources
    if (this.thinking) {
      reasoningContent = reasoningContent ? `${reasoningContent}\n${this.thinking}` : this.thinking
    }

    if (this.toolCalls.length > 0) {
      finalContent = stripNativeToolCallBlocks(finalContent)
    }

    finalContent = stripCitations(finalContent)
    if (reasoningContent) {
      reasoningContent = stripCitations(reasoningContent)
    }

    const id = `chatcmpl-${uuid(false)}`
    const created = Math.floor(Date.now() / 1000)

    const response: any = {
      id,
      object: 'chat.completion',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: finalContent,
          },
          finish_reason: this.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage: this.usage
        ? {
            prompt_tokens: this.usage.promptTokens,
            completion_tokens: this.usage.completionTokens,
            total_tokens: this.usage.totalTokens,
          }
        : undefined,
    }

    if (this.toolCalls.length > 0) {
      response.choices[0].message.tool_calls = this.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }))
    }

    if (reasoningContent) {
      response.choices[0].message.reasoning_content = reasoningContent
    }

    return JSON.stringify(response)
  }

  private async consumeUpstream(stream: NodeJS.ReadableStream): Promise<void> {
    let buffer = ''
    let currentEvent = ''

    for await (const chunk of stream) {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()

        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim()
        } else if (trimmed.startsWith('data:')) {
          try {
            const data = JSON.parse(trimmed.slice(5).trim())
            const mimoChunk: MimoChunk = { type: currentEvent as any, ...data }

            if (typeof data.reasoningContent === 'string' && data.reasoningContent) {
              this.thinking += data.reasoningContent
            }

            if (currentEvent === 'error' && typeof data.content === 'string' && data.content) {
              console.warn('[Mimo] Upstream error event:', data.content)
              this.sawUpstreamError = true
              this.content += `\n\n[Mimo] ${data.content}`
            } else if ((mimoChunk.type === 'message' || mimoChunk.type === 'text') && mimoChunk.content) {
              const text = (mimoChunk.content ?? '').replace(/\u0000/g, '')
              this.content += text
            } else if (mimoChunk.type === 'usage') {
              const usage = extractMimoUsage(data)
              if (usage) this.usage = usage
            } else if (mimoChunk.type === 'dialogId' && mimoChunk.content) {
              this.dialogId = mimoChunk.content
            }
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    }
  }

  /**
   * Rate-limited Mimo replies often arrive as an empty answer (thinking only
   * or nothing at all). Like the mimo2api reference, wait briefly and re-ask
   * once with a nudge appended to the query; the retry stream is opened by the
   * caller-supplied callback so both attempts share one outbound stream.
   */
  private async openRetryStreamIfNeeded(): Promise<NodeJS.ReadableStream | null> {
    if (this.retried || !this.retryStream || !this.hasEmptyAnswer()) {
      return null
    }
    this.retried = true
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const retryStream = await this.retryStream()
      if (!retryStream) {
        return null
      }
      console.warn('[Mimo] Upstream returned an empty answer, retrying once with a nudge')
      return retryStream
    } catch (error) {
      console.error('[Mimo] Empty-answer retry failed:', error)
      return null
    }
  }

  private hasEmptyAnswer(): boolean {
    // Do not retry genuine upstream errors — a nudge will not fix them
    if (this.sawUpstreamError) {
      return false
    }
    return this.getAssistantContentForTitle().trim().length === 0
  }

  private formatOpenAIChunk(
    id: string,
    created: number,
    delta: { role?: string; content?: string; reasoning_content?: string },
    finishReason?: string
  ): string {
    const chunk: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason || null,
        },
      ],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  private createBaseChunk(id: string, created: number): any {
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
    }
  }

  private formatOpenAIToolCallChunk(
    id: string,
    created: number,
    toolCalls: ParsedToolCall[]
  ): string {
    const chunk: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: toolCalls.map((tc, index) => ({
              index,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
          finish_reason: null,
        },
      ],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  private formatOpenAIUsageChunk(id: string, created: number, usage: MimoUsage): string {
    const chunk: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: null,
        },
      ],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  getConversationId(): string {
    return this.conversationId
  }

  getAssistantContentForTitle(): string {
    let content = this.content
    if (this.thinkingMode === 'strip') {
      content = stripThink(content)
    } else if (this.thinkingMode === 'separate') {
      content = extractThinkContent(content).content
    }
    return stripCitations(content)
  }

  getDialogId(): string {
    return this.dialogId
  }

  getUsage(): MimoUsage | null {
    return this.usage
  }
}

export const mimoAdapter = {
  MimoAdapter,
  MimoStreamHandler,
}
