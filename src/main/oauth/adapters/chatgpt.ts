/**
 * ChatGPT Authentication Adapter
 * Authentication method: Open browser and import Access Token manually
 */

import axios from 'axios'
import { shell } from 'electron'
import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const CHATGPT_API_BASE = 'https://chatgpt.com'

const FAKE_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Origin: CHATGPT_API_BASE,
  Referer: `${CHATGPT_API_BASE}/`,
  'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}

export class ChatGPTAuthAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'chatgpt',
      authMethods: ['manual'],
      loginUrl: CHATGPT_API_BASE,
      apiUrl: CHATGPT_API_BASE,
    })
  }

  /**
   * Start login flow - Open the session page where the user copies the Access Token
   */
  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    this.emitProgress('pending', 'Opening browser...')

    try {
      await shell.openExternal('https://chatgpt.com/api/auth/session')
      this.emitProgress('pending', 'Please log in and copy the accessToken value manually')

      return {
        success: false,
        providerId: options.providerId,
        providerType: 'chatgpt',
        error: 'Open https://chatgpt.com/api/auth/session, log in, and copy the accessToken value manually',
      }
    } catch (error) {
      console.error('[ChatGPT] startLogin error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to open browser'
      this.emitProgress('error', errorMessage)

      return {
        success: false,
        providerId: options.providerId,
        providerType: 'chatgpt',
        error: errorMessage,
      }
    }
  }

  /**
   * Complete authentication with manually entered token
   */
  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Access Token...')

    try {
      const validation = await this.validateToken({ token })

      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'chatgpt',
          error: validation.error || 'Token validation failed',
        }
      }

      this.emitProgress('success', 'Access Token validation successful')

      return {
        success: true,
        providerId,
        providerType: 'chatgpt',
        credentials: { token },
        accountInfo: validation.accountInfo,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.emitProgress('error', `Token validation failed: ${errorMessage}`)

      return {
        success: false,
        providerId,
        providerType: 'chatgpt',
        error: errorMessage,
      }
    }
  }

  /**
   * Handle callback (ChatGPT does not support)
   */
  protected async processCallback(_data: OAuthCallbackData): Promise<void> {
    // ChatGPT does not support OAuth callback
  }

  /**
   * Validate token validity via /backend-api/me
   */
  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const token = credentials.token || credentials.accessToken || credentials.userToken

    if (!token) {
      return {
        valid: false,
        error: 'Access Token cannot be empty',
      }
    }

    try {
      const response = await axios.get(`${CHATGPT_API_BASE}/backend-api/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      })

      console.log('[ChatGPT OAuth] Response status:', response.status)

      if (response.status === 401 || response.status === 403) {
        return {
          valid: false,
          error: 'Access Token is invalid or expired',
        }
      }

      if (response.status !== 200 || !response.data) {
        return {
          valid: false,
          error: `Token validation failed: HTTP ${response.status}`,
        }
      }

      const data = response.data
      return {
        valid: true,
        tokenType: 'access',
        accountInfo: {
          userId: data.id,
          email: data.email,
          name: data.name,
        },
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation request failed'
      return {
        valid: false,
        error: errorMessage,
      }
    }
  }

  /**
   * Refresh token - not supported, access token must be re-imported
   */
  async refreshToken(_credentials: Record<string, string>): Promise<CredentialInfo | null> {
    return null
  }
}

export default ChatGPTAuthAdapter
