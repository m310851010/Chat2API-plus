/**
 * Doubao Authentication Adapter
 * Authentication method: Cookie-based authentication (manual entry)
 *
 * Note: Doubao web (www.doubao.com) uses ByteDance session cookies
 * (sessionid / sessionid_ss) for authenticated requests.
 * We only collect the cookie; the chat requests themselves carry it.
 */

import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const DOUBAO_WEB_BASE = 'https://www.doubao.com'

export class DoubaoAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'doubao',
      authMethods: ['manual'],
      loginUrl: DOUBAO_WEB_BASE,
      apiUrl: DOUBAO_WEB_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'doubao',
      error: 'Please log in via browser and paste the full doubao.com cookie string',
    }
  }

  protected async processCallback(data: OAuthCallbackData): Promise<void> {}

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    // In-app login collects the sessionid / sessionid_ss cookies individually
    const sessionCookie = credentials.sessionid || credentials.sessionid_ss || ''
    const cookie = credentials.cookie || credentials.sessionToken || credentials.token || sessionCookie

    if (!cookie) {
      return {
        valid: false,
        error: 'Cookie is required (full doubao.com cookie string)',
      }
    }

    if (sessionCookie && !credentials.cookie && !credentials.sessionToken && !credentials.token) {
      // Bare session token from the in-app login flow
      return {
        valid: true,
        tokenType: 'cookie',
        accountInfo: {
          name: 'Doubao User',
        },
      }
    }

    if (!cookie.includes('=')) {
      return {
        valid: false,
        error: 'Cookie is malformed (expected name=value pairs)',
      }
    }

    const hasSession = /(^|;\s*)sessionid\s*=/.test(cookie) || /(^|;\s*)sessionid_ss\s*=/.test(cookie)
    if (!hasSession) {
      return {
        valid: false,
        error: 'Cookie must contain the sessionid (or sessionid_ss) entry',
      }
    }

    return {
      valid: true,
      tokenType: 'cookie',
      accountInfo: {
        name: 'Doubao User',
      },
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const cookie =
      credentials.cookie || credentials.sessionToken || credentials.token || credentials.sessionid || ''
    if (!cookie) {
      return null
    }
    return {
      type: 'cookie',
      value: cookie,
      extra: credentials,
    }
  }
}

export default DoubaoAdapter
