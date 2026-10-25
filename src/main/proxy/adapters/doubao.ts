/**
 * Doubao Web Proxy Adapter
 * Reimplemented following the open-source doubao2api project
 * (https://github.com/wangchuxiaoji-oss/doubao2api, Apache-2.0).
 *
 * Protocol:
 * - POST https://www.doubao.com/samantha/chat/completion with session cookies
 * - Security query params: aid=582478, device_platform=web, samantha_web=1,
 *   desktop-client version fields, a fresh web_tab_id per request, and
 *   msToken only when known (empty/fake values trigger rate limiting 710022002)
 * - Body: message content is a JSON string {"text": ...} with content_type
 *   2001 (SamanthaText); completion_option controls deep-think mode; the
 *   client supplies fresh local_conversation_id/local_message_id UUIDs and
 *   need_create_conversation: true — the upstream keeps history server-side,
 *   this proxy flattens the whole OpenAI message list into one prompt
 * - Response: SSE `data:` lines with JSON events — 2001 CMPL chunks,
 *   2002 conversation ACK, 2003 FIN, 2005 ERR. "Agw-Js-Conv: str" forces
 *   the gateway to return event_data as JSON strings
 * - Risk-control codes 710022002/710022004 open the in-app captcha window
 */

import { net } from 'electron'
import { Readable } from 'stream'
import { Account, Provider } from '../../store/types'
import { AccountManager } from '../../store/accounts'
import type { ChatCompletionRequest } from '../types'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { solveDoubaoCaptcha } from './doubao-captcha'
import {
  extractDoubaoVerifyData,
  hasNormalDoubaoEvent,
  RISK_SCAN_BUFFER_LIMIT,
} from './doubao-protocol'

const DOUBAO_URL = 'https://www.doubao.com'
const CHAT_COMPLETION_PATH = '/samantha/chat/completion'

/** Web app default chat bot ("assistant" experience) */
const DEFAULT_BOT_ID = '7234781073513644036'
/** Doubao pro web bot used by the web composer */
const PRO_BOT_ID = '7338286299411103781'

export interface DoubaoModelConfig {
  botId: string
  deepThink: boolean
}

const MODEL_CONFIGS: Record<string, DoubaoModelConfig> = {
  'doubao-pro-chat': { botId: PRO_BOT_ID, deepThink: false },
  'doubao-deep-think': { botId: DEFAULT_BOT_ID, deepThink: true },
}

export function resolveDoubaoModel(model: string): { name: string; config: DoubaoModelConfig } {
  if (MODEL_CONFIGS[model]) {
    return { name: model, config: MODEL_CONFIGS[model] }
  }
  const lower = model.toLowerCase()
  if (lower.includes('think') || lower.includes('deep')) {
    return { name: 'doubao-deep-think', config: MODEL_CONFIGS['doubao-deep-think'] }
  }
  return { name: 'doubao-pro-chat', config: MODEL_CONFIGS['doubao-pro-chat'] }
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
        const profile = getProviderToolProfile('doubao')
        parts.push(`[Assistant]: ${content || ''}\n${profile.formatAssistantToolCalls(calls)}`)
      } else {
        parts.push(`[Assistant]: ${content}`)
      }
    } else if (role === 'tool') {
      const name = (msg as any).name || ''
      const contentText = extractText(msg.content)
      const profile = getProviderToolProfile('doubao')
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

/** Deterministic 19-digit numeric device id derived from a seed string */
function stableNumericId(seed: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash ^ seed.charCodeAt(i)) * 0x01000193) >>> 0
  }
  let out = ''
  for (let i = 0; i < 19; i++) {
    hash = (hash * 1103515245 + 12345) >>> 0
    out += String((hash >>> 16) % 10)
  }
  return out.replace(/^0+/, '1')
}

/** Deterministic hex fingerprint derived from a seed string */
function stableFingerprint(seed: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash ^ seed.charCodeAt(i)) * 0x01000193) >>> 0
  }
  let out = ''
  for (let i = 0; i < 32; i++) {
    hash = (hash * 1103515245 + 12345) >>> 0
    out += '0123456789abcdef'[(hash >>> 16) % 16]
  }
  return out
}

function parseCookieString(cookieStr: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const pair of cookieStr.split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (key && value) map[key] = value
  }
  return map
}

/**
 * Gate between the raw upstream response and the client stream: buffers the
 * first bytes to detect a risk-control challenge. Normal traffic is pushed
 * through untouched; a challenge is withheld so the caller can solve the
 * captcha and retry.
 */
class DoubaoRiskGate {
  private buffer = ''
  private decided = false
  private decidedRisk = false
  riskVerifyData: string | null = null
  failError: Error | null = null

  constructor(
    private readonly output: Readable,
    private readonly onNormal: () => void,
    private readonly onRisk: () => void
  ) {}

  handleChunk(chunk: Buffer): void {
    if (this.decided) {
      if (!this.decidedRisk) this.output.push(chunk)
      return
    }
    this.buffer += chunk.toString()

    if (hasNormalDoubaoEvent(this.buffer)) {
      this.decideNormal()
      return
    }

    const verifyData = extractDoubaoVerifyData(this.buffer)
    if (verifyData) {
      this.riskVerifyData = verifyData
      this.decideRisk()
      return
    }

    // The samantha endpoint can hard-fail with a JSON error body
    // (code 710012001 "登录已过期" etc.) when the session is expired or the
    // account is flagged — route that into the captcha flow as well
    if (/71001200[01]|user invalid|login invalid|登录已过期/.test(this.buffer)) {
      this.riskVerifyData = ''
      this.decideRisk()
      return
    }

    if (this.buffer.length > RISK_SCAN_BUFFER_LIMIT) {
      this.decideNormal()
    }
  }

  /** Upstream stream ended — flush whatever is pending */
  finish(): void {
    if (!this.decided) {
      this.decideNormal()
    }
    if (!this.decidedRisk) {
      this.output.push(null)
    }
  }

  fail(error: unknown): void {
    // Mid-attempt failures must NOT reach the client stream: the caller
    // decides whether to retry or surface the error after the last attempt
    this.failError = error instanceof Error ? error : new Error(String(error))
  }

  private decideNormal(): void {
    this.decided = true
    this.decidedRisk = false
    if (this.buffer) {
      this.output.push(Buffer.from(this.buffer, 'utf8'))
      this.buffer = ''
    }
    this.onNormal()
  }

  private decideRisk(): void {
    this.decided = true
    this.decidedRisk = true
    this.buffer = ''
    this.onRisk()
  }
}

export class DoubaoAdapter {
  private provider: Provider
  private account: Account
  private cookie: string
  /**
   * Doubao rotates msToken on every response via the x-ms-token header.
   * Stale tokens trigger rate limiting (710022002), so the freshest token is
   * kept here and persisted to the account credentials for the captcha
   * window to reuse.
   */
  private msToken: string = ''
  /** Stable per-account device identifiers for the security query params */
  private readonly deviceId: string
  private readonly fingerprint: string

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account

    const credentials = account.credentials as Record<string, any>

    const rawCookie = (
      credentials.cookie ||
      credentials.sessionToken ||
      credentials.token ||
      credentials.sessionid ||
      ''
    ).toString().trim()

    // Individually collected cookies from the in-app login flow
    const collected: Record<string, string> = {}
    for (const name of ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'ttwid', 'msToken']) {
      const value = credentials[name]
      if (value) collected[name] = value
    }

    const rawCookies = credentials.cookies
    if (rawCookies) {
      try {
        const obj = typeof rawCookies === 'string'
          ? (JSON.parse(rawCookies as string) as Record<string, string>)
          : (rawCookies as Record<string, string>)
        Object.assign(collected, obj)
      } catch {
        // ignore malformed cookie payload
      }
    }

    const allPairs = rawCookie.includes('=')
      ? { ...parseCookieString(rawCookie), ...collected }
      : collected
    this.msToken = allPairs['msToken'] || credentials.msToken || ''
    if (rawCookie.includes('=')) {
      this.cookie = this.buildCookieHeader({ ...parseCookieString(rawCookie), ...collected })
    } else if (rawCookie) {
      // Bare session token value
      collected['sessionid'] = rawCookie
      this.cookie = this.buildCookieHeader(collected)
    } else {
      this.cookie = this.buildCookieHeader(collected)
    }

    const seed = `${account.id}:${account.providerId || provider.id}`
    this.deviceId = stableNumericId(seed)
    this.fingerprint = stableFingerprint(seed)
  }

  private buildCookieHeader(pairs: Record<string, string>): string {
    return Object.entries(pairs)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }

  /**
   * Persist a rotated msToken (x-ms-token response header) so subsequent
   * chat requests and the captcha window share the same valid token.
   */
  private applyRotatedMsToken(token: string): void {
    if (!token || token === this.msToken) return
    console.log('[Doubao] msToken rotated, persisting fresh token')
    this.msToken = token
    try {
      AccountManager.update(this.account.id, {
        credentials: { ...this.account.credentials, msToken: token },
      } as any)
      this.account = { ...this.account, credentials: { ...this.account.credentials, msToken: token } }
    } catch (error) {
      console.warn('[Doubao] Failed to persist rotated msToken:', error)
    }
  }

  static isDoubaoProvider(provider: Provider): boolean {
    return provider.id === 'doubao' || provider.apiEndpoint.includes('doubao.com')
  }

  /**
   * Security query params, mirroring doubao2api's `_security_params()`:
   * web app ids, desktop-client version fields and per-request ids.
   * msToken is only appended when known — empty values trigger rate limiting.
   */
  private buildChatUrl(): string {
    const params = new URLSearchParams({
      'aid': '582478',
      'real_aid': '582478',
      'device_platform': 'web',
      'samantha_web': '1',
      'device_id': this.deviceId,
      'tea_uuid': this.deviceId,
      'web_id': this.deviceId,
      'fp': this.fingerprint,
      'client_platform': 'pc_client',
      'version_code': '20800',
      'pc_version': '2.1.7',
      'chromium_version': '138.0.7204.97',
      'web_tab_id': uuid(),
    })
    if (this.msToken) {
      params.set('msToken', this.msToken)
    }
    return `${DOUBAO_URL}${CHAT_COMPLETION_PATH}?${params.toString()}`
  }

  /**
   * Chat request body, mirroring doubao2api's `chat_stream_samantha` payload:
   * the text is a JSON-serialized string (content_type 2001) and a fresh
   * conversation is created per request (need_create_conversation: true).
   */
  private buildRequestBody(
    prompt: string,
    config: DoubaoModelConfig
  ): any {
    return {
      messages: [
        {
          content: JSON.stringify({ text: prompt }),
          content_type: 2001,
          attachments: [],
          references: [],
        },
      ],
      completion_option: {
        is_regen: false,
        with_suggest: true,
        need_create_conversation: true,
        launch_stage: 1,
        use_deep_think: config.deepThink,
        use_auto_cot: true,
        memory_type: 2,
        message_from: 0,
      },
      evaluate_option: { web_ab_params: '' },
      local_conversation_id: uuid(),
      local_message_id: uuid(),
      bot_id: config.botId,
    }
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    options: { conversationId?: string } = {}
  ): Promise<{ stream: Readable; sessionId: string }> {
    void options
    if (!this.cookie) {
      throw new Error('No cookie configured — paste the full doubao.com cookie string')
    }

    const prompt = buildPrompt(request.messages)
    if (!prompt.trim()) {
      throw new Error('No usable content in request messages')
    }

    const resolved = resolveDoubaoModel(request.model)
    const sessionId = `doubao-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

    const stream = new Readable({ read() {} })

    const sendRequest = (): Promise<any> =>
      new Promise((resolve, reject) => {
        let errorBody = ''

        const request_ = net.request({ method: 'POST', url: this.buildChatUrl() })

        const headers: Record<string, string> = { ...this.provider.headers }
        const cookie = this.currentCookie()
        if (cookie) headers['Cookie'] = cookie
        for (const [key, value] of Object.entries(headers)) {
          request_.setHeader(key, value)
        }

        request_.on('response', (response) => {
          const statusCode = response.statusCode || 0

          try {
            const rotated = response.headers['x-ms-token']
            if (typeof rotated === 'string' && rotated) this.applyRotatedMsToken(rotated)
          } catch {
            // header access is best-effort
          }

          if (statusCode >= 400) {
            response.on('data', (chunk: Buffer) => {
              errorBody += chunk.toString()
            })
            response.on('end', () => {
              const msg =
                statusCode === 401 || statusCode === 403
                  ? `Doubao auth failed (HTTP ${statusCode}). Cookie may be expired or invalid. ${errorBody.slice(0, 200)}`
                  : `Doubao request failed (HTTP ${statusCode}): ${errorBody.slice(0, 300)}`
              reject(new Error(msg))
            })
            return
          }

          resolve(response)
        })

        request_.on('error', (error) => {
          reject(error)
        })

        request_.write(JSON.stringify(this.buildRequestBody(prompt, resolved.config)))
        request_.end()
      })

    /**
     * Pipe the upstream response into the client stream, detecting a
     * risk-control slide-captcha challenge before any content flows.
     * Returns 'forward' when normal traffic is streaming, or the extracted
     * verify decision when risk control intercepted the request.
     */
    const pipeWithRiskDetection = (
      response: any
    ): Promise<
      | { kind: 'forward' }
      | { kind: 'risk'; verifyData: string }
      | { kind: 'failed'; error: Error }
    > =>
      new Promise((resolve) => {
        let settled = false
        const settle = (value: any) => {
          if (!settled) {
            settled = true
            resolve(value)
          }
        }
        const gate = new DoubaoRiskGate(
          stream,
          () => settle({ kind: 'forward' }),
          () => settle({ kind: 'risk', verifyData: gate.riskVerifyData || '' }),
        )

        response.on('data', (chunk: Buffer) => {
          gate.handleChunk(chunk)
        })
        response.on('end', () => {
          gate.finish()
          settle({ kind: 'forward' })
        })
        response.on('error', (error: Error) => {
          gate.fail(error)
          settle({ kind: 'failed', error })
        })
      })

    const maxAttempts = 3
    const run = async (attemptsLeft: number): Promise<void> => {
      let response: any
      try {
        response = await sendRequest()
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        if (attemptsLeft > 0) {
          console.warn('[Doubao] Request failed, retrying:', err.message)
          await run(attemptsLeft - 1)
          return
        }
        stream.emit('error', err)
        return
      }

      const outcome = await pipeWithRiskDetection(response)

      if (outcome.kind === 'forward') {
        return
      }

      if (outcome.kind === 'failed') {
        if (attemptsLeft > 0) {
          console.warn('[Doubao] Transport failed, retrying:', outcome.error.message)
          await run(attemptsLeft - 1)
          return
        }
        stream.emit('error', outcome.error)
        return
      }

      // Risk control challenge: open the real doubao page and let the user
      // complete verification there (the page raises its own captcha). The
      // actual result is the retry below — if it still gets challenged, the
      // window opens again until attempts are exhausted.
      if (attemptsLeft > 0) {
        console.log('[Doubao] Risk control challenged, showing captcha window')
        const { outcome: captchaOutcome, capturedCookieJar } = await solveDoubaoCaptcha({
          verifyData: outcome.verifyData,
          provider: this.provider,
          account: this.account,
        })
        if (captchaOutcome === 'closed') {
          console.log('[Doubao] Captcha window closed by user, retrying chat request')
        } else {
          console.log('[Doubao] Captcha window failed, retrying chat request')
        }
        if (capturedCookieJar) {
          this.adoptCookieJar(capturedCookieJar)
        }
        await run(attemptsLeft - 1)
        return
      }

      stream.emit(
        'error',
        new Error(
          'Doubao risk control blocked the request (slide captcha). 完成弹出的滑块验证后重试；若验证窗口已关闭，请重新发送消息。/ Complete the verification and try again.',
        ),
      )
    }

    await run(maxAttempts)

    return { stream, sessionId }
  }

  /** Current cookie header with the freshest msToken applied */
  private currentCookie(): string {
    if (!this.msToken) return this.cookie
    if (/(^|;\s*)msToken=/.test(this.cookie)) {
      return this.cookie.replace(/(^|;\s*)msToken=[^;]*/, (_m, sep) => `${sep}msToken=${this.msToken}`)
    }
    return `${this.cookie}; msToken=${this.msToken}`
  }

  /**
   * Adopt the captcha window session's full cookie jar: it is fresher than
   * the originally pasted cookie string (rotated msToken, refreshed ttwid).
   */
  private adoptCookieJar(cookieJar: string): void {
    try {
      const credentials = { ...this.account.credentials, cookie: cookieJar }
      AccountManager.update(this.account.id, { credentials } as any)
      this.account = { ...this.account, credentials }
      this.cookie = cookieJar
      const fresh = cookieJar.match(/msToken=([^;]*)/)?.[1] || ''
      if (fresh) this.msToken = fresh
      console.log('[Doubao] Adopted captured cookie jar (', cookieJar.length, 'chars )')
    } catch (error) {
      console.warn('[Doubao] Failed to adopt captured cookie jar:', error)
    }
  }

  async deleteSession(conversationId: string): Promise<boolean> {
    if (!conversationId || conversationId === '0') return true
    if (!this.cookie) return true

    return new Promise((resolve) => {
      try {
        const request_ = net.request({
          method: 'POST',
          url: `${DOUBAO_URL}/samantha/thread/delete`,
        })
        const headers: Record<string, string> = {
          ...this.provider.headers,
          'Accept': 'application/json',
        }
        const cookie = this.currentCookie()
        if (cookie) headers['Cookie'] = cookie
        for (const [key, value] of Object.entries(headers)) {
          request_.setHeader(key, value)
        }

        const finish = (result: boolean) => resolve(result)

        request_.on('response', (response) => {
          response.on('data', () => {})
          response.on('end', () => finish((response.statusCode || 500) < 400))
        })
        request_.on('error', () => finish(false))

        request_.write(JSON.stringify({ thread_id: String(conversationId) }))
        request_.end()
      } catch {
        resolve(false)
      }
    })
  }
}

export const doubaoAdapter = {
  DoubaoAdapter,
}
