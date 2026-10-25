import axios, { AxiosError } from 'axios'
import { net } from 'electron'
import { getBuiltinProvider } from './builtin'
import type { Provider, ProviderCheckResult, Account } from '../../shared/types'
import type { BuiltinProviderConfig } from '../store/types'
import { getProxyAgents } from '../proxy/adapters/chatgpt-proxy'

const CHECK_TIMEOUT = 15000

export interface TokenCheckResult {
  valid: boolean
  error?: string
  userInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
  }
}

export class ProviderChecker {
  static async checkProviderStatus(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const builtinConfig = provider.type === 'builtin' 
        ? getBuiltinProvider(provider.id) 
        : null
      
      if (builtinConfig) {
        return await this.checkBuiltinProvider(builtinConfig)
      }
      
      return await this.checkCustomProvider(provider)
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  private static async checkBuiltinProvider(config: BuiltinProviderConfig): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const checkUrl = `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint || '/health'}`
      
      const response = await axios({
        method: 'GET',
        url: checkUrl,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: config.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: config.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: config.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  private static async checkCustomProvider(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers: provider.headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: provider.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: provider.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  static async checkAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    const builtinConfig = provider.type === 'builtin' 
      ? getBuiltinProvider(provider.id) 
      : null
    
    if (!builtinConfig) {
      return this.checkCustomAccountToken(provider, account)
    }
    
    switch (provider.id) {
      case 'chatgpt':
        return this.checkChatGPTToken(account.credentials.token)
      case 'deepseek':
        return this.checkDeepSeekToken(account.credentials.token)
      case 'glm':
        return this.checkGLMToken(account.credentials.refresh_token)
      case 'kimi':
        return this.checkKimiToken(account.credentials.token)
      case 'minimax':
        return this.checkMiniMaxToken(
          account.credentials.realUserID || '',
          account.credentials.token
        )
      case 'qwen':
        return this.checkQwenToken(account.credentials.ticket)
      case 'qwen-ai':
        return this.checkQwenAiToken(account.credentials.token)
      case 'perplexity':
        return this.checkPerplexityToken(account.credentials.sessionToken || account.credentials.token)
      case 'mimo': {
        // Legacy accounts store three split fields; compose them back into a cookie string
        const credentials = account.credentials
        const legacyParts: string[] = []
        if (credentials.service_token) legacyParts.push(`serviceToken=${credentials.service_token}`)
        if (credentials.user_id) legacyParts.push(`userId=${credentials.user_id}`)
        if (credentials.ph_token) legacyParts.push(`xiaomichatbot_ph=${credentials.ph_token}`)
        return this.checkMimoCookie(account.credentials.cookie || legacyParts.join('; '))
      }
      case 'doubao':
        return this.checkDoubaoCookie(account.credentials.cookie || account.credentials.sessionToken || '')
      case 'gemini':
        return this.checkGeminiCookie(account.credentials.cookie || '')
      case 'grok':
        return this.checkGrokToken(account.credentials.cookie || account.credentials.token || '')
      default:
        if (!builtinConfig.tokenCheckEndpoint) {
          return { valid: true }
        }
        return this.checkGenericToken(builtinConfig, account)
    }
  }

  private static checkMimoCookie(cookie: string): TokenCheckResult {
    const parseCookieValue = (name: string): string => {
      for (const pair of cookie.split(';')) {
        const eq = pair.indexOf('=')
        if (eq !== -1 && pair.slice(0, eq).trim() === name) {
          const value = pair.slice(eq + 1).trim()
          if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
            return value.slice(1, -1)
          }
          return value
        }
      }
      return ''
    }

    const missing: string[] = []
    if (!parseCookieValue('xiaomichatbot_serviceToken') && !parseCookieValue('serviceToken')) {
      missing.push('serviceToken (or xiaomichatbot_serviceToken)')
    }
    if (!parseCookieValue('xiaomichatbot_ph')) {
      missing.push('xiaomichatbot_ph')
    }
    if (!cookie || missing.length > 0) {
      return {
        valid: false,
        error: `Cookie is missing required entries: ${missing.join(', ')}. Sign in at https://aistudio.xiaomimimo.com and paste the full cookie string.`,
      }
    }

    return {
      valid: true,
      userInfo: {
        name: 'Mimo User',
      },
    }
  }

  /**
   * GET request via Electron net (follows the system proxy automatically).
   */
  private static electronNetGet(
    url: string,
    headers: Record<string, string>,
    timeoutMs = 20000
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
      let done = false
      const finish = (status: number, body: string) => {
        if (!done) {
          done = true
          resolve({ status, body })
        }
      }
      try {
        const req = net.request({ method: 'GET', url })
        for (const [k, v] of Object.entries(headers)) {
          req.setHeader(k, v)
        }
        let body = ''
        const timer = setTimeout(() => {
          try {
            req.abort()
          } catch {
            // ignore
          }
          finish(0, body.slice(0, 500))
        }, timeoutMs)

        req.on('response', (res) => {
          const status = res.statusCode || 0
          res.on('data', (chunk: Buffer) => {
            if (body.length < 5 * 1024 * 1024) {
              body += chunk.toString()
            }
          })
          res.on('end', () => {
            clearTimeout(timer)
            finish(status, body)
          })
        })

        req.on('error', (error) => {
          clearTimeout(timer)
          finish(0, String(error))
        })

        req.end()
      } catch (error) {
        finish(0, String(error))
      }
    })
  }

  private static async checkDoubaoCookie(cookie: string): Promise<TokenCheckResult> {
    try {
      if (!cookie || !cookie.includes('=')) {
        return { valid: false, error: 'Cookie is empty or malformed' }
      }

      if (!/(^|;\s*)sessionid(_ss)?\s*=/.test(cookie)) {
        return { valid: false, error: 'Cookie must contain the sessionid (or sessionid_ss) entry' }
      }

      // ByteDance's passport account/info endpoint rejects doubao sessions
      // (error_code 16 "该应用无权限"), so it cannot be used to verify login.
      // The /chat/ page instead embeds the signed-in user block
      // ("user_id_str":"<uid>"); logged-out responses only carry "user_id":0.
      const { status, body } = await this.electronNetGet(
        'https://www.doubao.com/chat/',
        {
          'Cookie': cookie,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': 'https://www.doubao.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        }
      )

      if (status === 0) {
        return { valid: false, error: `Network error: ${body || 'request failed'}` }
      }

      if (status !== 200) {
        return {
          valid: false,
          error: `Doubao returned HTTP ${status}; cookie may be invalid or expired`,
        }
      }

      if (/"user_id_str":"\d+"/.test(body)) {
        let name: string | undefined
        const nameMatch = body.match(/"screen_name":"((?:[^"\\]|\\.)*)","sec_user_id"/)
        if (nameMatch) {
          try {
            name = JSON.parse(`"${nameMatch[1]}"`)
          } catch {
            name = nameMatch[1]
          }
        }
        return {
          valid: true,
          userInfo: {
            name: name || 'Doubao User',
          },
        }
      }

      return {
        valid: false,
        error: 'Cookie is invalid or expired (session not recognized by Doubao)',
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Cookie validation failed',
      }
    }
  }

  private static async checkGeminiCookie(cookie: string): Promise<TokenCheckResult> {
    try {
      if (!cookie || !cookie.includes('=')) {
        return { valid: false, error: 'Cookie is empty or malformed' }
      }

      const { status, body } = await this.electronNetGet('https://gemini.google.com/app', {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      })

      if (status === 0) {
        return { valid: false, error: `Network error: ${body || 'request failed'}` }
      }

      if (status !== 200) {
        return {
          valid: false,
          error: `Gemini returned HTTP ${status}; cookie may be invalid or expired`,
        }
      }

      if (/"SNlM0e":"[^"]+"/.test(body)) {
        return {
          valid: true,
          userInfo: { name: 'Gemini User' },
        }
      }

      return {
        valid: false,
        error: 'Cookie is invalid or expired (SNlM0e token not found on the page)',
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Cookie validation failed',
      }
    }
  }

  private static async checkGrokToken(rawCredential: string): Promise<TokenCheckResult> {
    try {
      if (!rawCredential) {
        return { valid: false, error: 'Cookie is empty or malformed' }
      }

      // Accept either a full cookie string or a bare sso token value
      const pairs: Record<string, string> = {}
      for (const part of rawCredential.split(';')) {
        const idx = part.indexOf('=')
        if (idx > 0) {
          pairs[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
        }
      }
      const sso = pairs['sso'] || pairs['sso-rw'] || rawCredential
      if (!sso) {
        return { valid: false, error: 'Cookie must contain the "sso" value' }
      }

      const { status, body } = await this.electronNetGet(
        'https://grok.com/rest/app-chat/conversations?order_by=desc',
        {
          'Cookie': `sso=${sso}; sso-rw=${sso}`,
          'Accept': 'application/json',
          'Origin': 'https://grok.com',
          'Referer': 'https://grok.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        }
      )

      if (status === 0) {
        return { valid: false, error: `Network error: ${body || 'request failed'}` }
      }

      if (status === 401 || status === 403) {
        return { valid: false, error: 'Token is invalid or expired' }
      }

      if (status !== 200) {
        return {
          valid: false,
          error: `Grok returned HTTP ${status}; token may be invalid`,
        }
      }

      try {
        JSON.parse(body)
      } catch {
        return {
          valid: false,
          error: 'Grok returned a non-JSON response (login challenge or Cloudflare page)',
        }
      }

      return {
        valid: true,
        userInfo: { name: 'Grok User' },
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Token validation failed',
      }
    }
  }

  private static async checkChatGPTToken(token: string): Promise<TokenCheckResult> {
    try {
      if (!token) {
        return { valid: false, error: 'Access Token is empty' }
      }

      console.log('[ChatGPT] Validating Access Token:', token.substring(0, 20) + '...')

      const proxyAgents = getProxyAgents()
      const response = await axios.get(
        'https://chatgpt.com/backend-api/me',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Origin': 'https://chatgpt.com',
            'Referer': 'https://chatgpt.com/',
            'OAI-Language': 'zh-CN',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
          ...(proxyAgents
            ? { httpAgent: proxyAgents.httpAgent, httpsAgent: proxyAgents.httpsAgent }
            : {}),
        }
      )

      console.log('[ChatGPT] Validation response status:', response.status)

      if (response.status === 200 && response.data) {
        return {
          valid: true,
          userInfo: {
            name: response.data.name,
            email: response.data.email,
          },
        }
      }

      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: 'Access Token expired or invalid' }
      }

      return {
        valid: false,
        error: `Validation failed: HTTP ${response.status}`,
      }
    } catch (error) {
      console.error('[ChatGPT] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError
          ? error.message
          : 'Connection failed',
      }
    }
  }

  private static async checkDeepSeekToken(token: string): Promise<TokenCheckResult> {
    try {
      console.log('[DeepSeek] Validating Token:', token.substring(0, 20) + '...')
      
      const response = await axios.get(
        'https://chat.deepseek.com/api/v0/users/current',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://chat.deepseek.com',
            'Referer': 'https://chat.deepseek.com/',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[DeepSeek] Response status:', response.status)
      console.log('[DeepSeek] Response data:', JSON.stringify(response.data, null, 2))
      
      // Response format: { code: 0, data: { biz_data: { ... } } }
      if (response.status === 200 && response.data?.code === 0 && response.data?.data?.biz_data) {
        const bizData = response.data.data.biz_data
        return {
          valid: true,
          userInfo: {
            name: bizData.id_profile?.name,
            email: bizData.email,
          },
        }
      }
      
      if (response.status === 401 || response.data?.code === 40003 || response.data?.data?.biz_code === 40003) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.msg || response.data?.message || JSON.stringify(response.data)}` }
    } catch (error) {
      console.error('[DeepSeek] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkGLMToken(refreshToken: string): Promise<TokenCheckResult> {
    try {
      console.log('[GLM] Validating Token:', refreshToken.substring(0, 20) + '...')
      
      const sign = await this.generateGLMSignV2()
      
      const response = await axios.post(
        'https://chatglm.cn/chatglm/user-api/user/refresh',
        {},
        {
          headers: {
            'Accept': 'text/event-stream',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'App-Name': 'chatglm',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Origin': 'https://chatglm.cn',
            'Pragma': 'no-cache',
            'Priority': 'u=1, i',
            'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'X-App-Fr': 'browser_extension',
            'X-App-Platform': 'pc',
            'X-App-Version': '0.0.1',
            'X-Device-Brand': '',
            'X-Device-Model': '',
            'X-Exp-Groups': 'na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable',
            'X-Lang': 'zh',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            Authorization: `Bearer ${refreshToken}`,
            'X-Device-Id': this.generateUUID().replace(/-/g, ''),
            'X-Nonce': sign.nonce,
            'X-Request-Id': this.generateUUID().replace(/-/g, ''),
            'X-Sign': sign.sign,
            'X-Timestamp': `${sign.timestamp}`,
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[GLM] Response status:', response.status)
      console.log('[GLM] Response data:', JSON.stringify(response.data, null, 2))
      
      if (response.status === 200 && response.data?.result?.access_token) {
        return {
          valid: true,
          userInfo: {
            name: response.data.result.user?.name,
          },
        }
      }
      
      if (response.status === 401 || response.data?.status === 40001) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.message || response.data?.msg || JSON.stringify(response.data)}` }
    } catch (error) {
      console.error('[GLM] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }
  
  private static async generateGLMSignV2(): Promise<{ timestamp: string; nonce: string; sign: string }> {
    const crypto = await import('crypto')
    const secret = '8a1317a7468aa3ad86e997d08f3f31cb'
    
    // GLM timestamp algorithm
    const now = Date.now()
    const timestampStr = now.toString()
    const len = timestampStr.length
    const digits = timestampStr.split('').map(d => parseInt(d))
    const sum = digits.reduce((a, b) => a + b, 0) - digits[len - 2]
    const checkDigit = sum % 10
    const timestamp = timestampStr.substring(0, len - 2) + checkDigit + timestampStr.substring(len - 1)
    
    // Random UUID (no separators)
    const nonce = this.generateUUID().replace(/-/g, '')
    
    // Signature
    const sign = crypto.createHash('md5').update(`${timestamp}-${nonce}-${secret}`).digest('hex')
    
    return { timestamp, nonce, sign }
  }

  private static async checkKimiToken(token: string): Promise<TokenCheckResult> {
    try {
      console.log('[Kimi] Validating Token:', token.substring(0, 20) + '...')
      
      const response = await axios.post(
        'https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription',
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'Accept': '*/*',
            'Origin': 'https://www.kimi.com',
            'Referer': 'https://www.kimi.com/',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[Kimi] Response status:', response.status)
      console.log('[Kimi] Response data:', JSON.stringify(response.data, null, 2))
      
      if (response.status === 200 && response.data?.subscription) {
        return {
          valid: true,
          userInfo: {
            name: response.data.subscription.userName,
          },
        }
      }
      
      return { valid: false, error: 'Token expired or invalid' }
    } catch (error) {
      console.error('[Kimi] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkMiniMaxToken(
    _realUserID: string,
    token: string
  ): Promise<TokenCheckResult> {
    try {
      console.log('[MiniMax] Validating Token:', token.substring(0, 30) + '...')
      
      const crypto = await import('crypto')
      
      let realUserID = ''
      let jwtToken = token
      
      if (token.includes('+')) {
        const parts = token.split('+')
        realUserID = parts[0]
        jwtToken = parts[1]
      } else {
        try {
          const parts = token.split('.')
          if (parts.length >= 2) {
            let payload = parts[1]
            const padding = payload.length % 4
            if (padding > 0) {
              payload += '='.repeat(4 - padding)
            }
            payload = payload.replace(/-/g, '+').replace(/_/g, '/')
            const decoded = Buffer.from(payload, 'base64').toString('utf8')
            const data = JSON.parse(decoded)
            realUserID = data.user?.id || data.id || data.sub || ''
            console.log('[MiniMax] Extracted userId from token:', realUserID)
          }
        } catch (e) {
          console.log('[MiniMax] Failed to parse JWT:', e)
        }
      }
      
      if (!realUserID) {
        return { valid: false, error: 'Cannot extract user ID from token' }
      }
      
      const uuid = realUserID
      const unix = Date.now().toString()
      const timestamp = Math.floor(Date.now() / 1000)
      const dataJson = JSON.stringify({ uuid })
      
      const signature = crypto.createHash('md5').update(`${timestamp}${jwtToken}${dataJson}`).digest('hex')
      
      const queryParams = new URLSearchParams({
        device_platform: 'web',
        biz_id: '3',
        app_id: '3001',
        version_code: '22201',
        uuid: uuid,
        user_id: realUserID,
      }).toString()
      
      const fullUri = `/v1/api/user/device/register?${queryParams}`
      const yy = crypto.createHash('md5').update(`${encodeURIComponent(fullUri)}_${dataJson}${crypto.createHash('md5').update(unix).digest('hex')}ooui`).digest('hex')
      
      const response = await axios.post(
        `https://agent.minimaxi.com${fullUri}`,
        { uuid },
        {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Origin': 'https://agent.minimaxi.com',
            'Pragma': 'no-cache',
            'Referer': 'https://agent.minimaxi.com/',
            'Sec-Ch-Ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"macOS"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            'token': jwtToken,
            'x-timestamp': String(timestamp),
            'x-signature': signature,
            'yy': yy,
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[MiniMax] Response status:', response.status)
      console.log('[MiniMax] Response data:', JSON.stringify(response.data, null, 2))
      
      if (response.status === 200 && response.data?.data?.deviceIDStr) {
        const userInfo = response.data.data.userInfo
        return {
          valid: true,
          userInfo: {
            name: userInfo?.name || userInfo?.nickname,
            email: userInfo?.email,
          },
        }
      }
      
      if (response.data?.statusInfo?.code === 1001) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.statusInfo?.message || 'Unknown error'}` }
    } catch (error) {
      console.error('[MiniMax] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkQwenToken(ticket: string): Promise<TokenCheckResult> {
    try {
      const response = await axios.post(
        'https://chat2-api.qianwen.com/api/v2/session/page/list',
        {},
        {
          headers: {
            Cookie: `tongyi_sso_ticket=${ticket}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://www.qianwen.com',
            'Referer': 'https://www.qianwen.com/',
            'X-Platform': 'pc_tongyi',
            'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          params: {
            biz_id: 'ai_qwen',
            chat_client: 'h5',
            device: 'pc',
            fr: 'pc',
            pr: 'qwen',
            ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      if (response.status === 200 && response.data?.success) {
        return {
          valid: true,
        }
      }
      
      if (!response.data?.success) {
        return { valid: false, error: 'SSO ticket expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.errorMsg || 'Unknown error'}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkQwenAiToken(token: string): Promise<TokenCheckResult> {
    try {
      const response = await axios.get(
        'https://chat.qwen.ai/api/v2/user',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            source: 'web',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )

      if (response.status === 200 && response.data?.data) {
        return {
          valid: true,
          userInfo: {
            name: response.data.data.name || response.data.data.email,
            email: response.data.data.email,
          },
        }
      }

      if (response.status === 401) {
        return { valid: false, error: 'Token expired or invalid' }
      }

      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError
          ? error.message
          : 'Connection failed',
      }
    }
  }

  private static checkPerplexityToken(sessionToken: string): TokenCheckResult {
    if (!sessionToken) {
      return { valid: false, error: 'Session token is required' }
    }

    if (sessionToken.length < 100) {
      return { valid: false, error: 'Session token appears to be invalid (too short)' }
    }

    return {
      valid: true,
      userInfo: {
        name: 'Perplexity User',
      },
    }
  }

  private static async checkGenericToken(
    config: BuiltinProviderConfig,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...config.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: config.tokenCheckMethod || 'GET',
        url: `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint}`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkCustomAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...provider.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  private static async generateGLMSign(timestamp: string, nonce: string): Promise<string> {
    const crypto = await import('crypto')
    const secret = '8a1317a7468aa3ad86e997d08f3f31cb'
    return crypto.createHash('md5').update(`${timestamp}-${nonce}-${secret}`).digest('hex')
  }

  static async fetchProviderModels(
    providerId: string
  ): Promise<{
    supportedModels: string[]
    modelMappings: Record<string, string>
  }> {
    const builtinConfig = getBuiltinProvider(providerId)
    
    if (!builtinConfig) {
      throw new Error(`Provider ${providerId} not found`)
    }

    if (!builtinConfig.modelsApiEndpoint) {
      throw new Error(`Provider ${providerId} does not support dynamic model fetching`)
    }

    try {
      const headers: Record<string, string> = {
        ...(builtinConfig.modelsApiHeaders || builtinConfig.headers),
      }

      const response = await axios.get(builtinConfig.modelsApiEndpoint, {
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      if (response.status !== 200) {
        throw new Error(`Failed to fetch models: HTTP ${response.status}`)
      }

      // Compatible with different response shapes:
      // - OpenAI style:   { data: [{ id, name }] }
      // - ChatGPT web:    { models: [{ slug }] }
      // - Plain array:    [{ id | model_id | slug | name }]
      const models: unknown[] = Array.isArray(response.data?.data)
        ? response.data.data
        : Array.isArray(response.data?.models)
          ? response.data.models
          : Array.isArray(response.data)
            ? response.data
            : []

      const supportedModels: string[] = []
      const modelMappings: Record<string, string> = {}

      for (const model of models) {
        if (typeof model === 'string') {
          supportedModels.push(model)
          modelMappings[model] = model
          continue
        }
        if (!model || typeof model !== 'object') continue
        const item = model as Record<string, unknown>
        const modelId = String(item.id ?? item.model_id ?? item.slug ?? item.name ?? '').trim()
        if (!modelId) continue
        const displayName = String(item.name ?? item.display_name ?? item.title ?? '').trim()
        supportedModels.push(displayName || modelId)
        modelMappings[displayName || modelId] = modelId
      }

      if (supportedModels.length === 0) {
        throw new Error('No models found in the response')
      }

      return { supportedModels, modelMappings }
    } catch (error) {
      console.error(`[ProviderChecker] Failed to fetch models for ${providerId}:`, error)
      throw error
    }
  }
}

export default ProviderChecker
