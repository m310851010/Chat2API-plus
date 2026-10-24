/**
 * Gemini Authentication Adapter
 * Authentication method: Cookie-based authentication with in-app browser login
 *
 * Note: Gemini web requires Google account cookies (SID / HSID / SSID /
 * APISID / SAPISID / __Secure-1PSID) for authenticated requests.
 * Requests are validated directly in the browser; we only collect cookies.
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

const GEMINI_WEB_BASE = 'https://gemini.google.com'

const REQUIRED_COOKIES = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID']

function findCookie(cookies: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const value = cookies[name]
    if (value) return value
  }
  return undefined
}

export class GeminiAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'gemini',
      authMethods: ['manual', 'cookie'],
      loginUrl: GEMINI_WEB_BASE,
      apiUrl: GEMINI_WEB_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'gemini',
      error: 'Use startInAppLogin for automatic cookie extraction',
    }
  }

  async loginWithCookies(providerId: string, cookies: Record<string, string>): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating cookies...')

    const psid =
      findCookie(cookies, ['__Secure-1PSID', '__Secure-1PSIDTS']) ||
      cookies['cookie'] ||
      cookies['sessionToken']

    if (!psid) {
      return {
        success: false,
        providerId,
        providerType: 'gemini',
        error: 'Cookie is required (__Secure-1PSID). Please sign in to gemini.google.com and retry.',
      }
    }

    this.emitProgress('success', 'Cookie validation successful')

    const collectedCookies: Record<string, string> = {}
    for (const name of REQUIRED_COOKIES) {
      const value = cookies[name]
      if (value) collectedCookies[name] = value
    }

    const accountName = cookies['authUser'] || cookies['authuserid'] || 'Gemini User'

    return {
      success: true,
      providerId,
      providerType: 'gemini',
      credentials: {
        cookie: psid,
        ...collectedCookies,
        ...(cookies['cookies'] ? { cookies: JSON.stringify(cookies['cookies']) } : {}),
        ...(cookies['authUser'] ? { authUser: cookies['authUser'] } : {}),
      },
      accountInfo: {
        name: accountName,
      },
    }
  }

  protected async processCallback(data: OAuthCallbackData): Promise<void> {
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const cookieValue =
      credentials['__Secure-1PSID'] ||
      credentials['psid'] ||
      credentials['cookie'] ||
      credentials['token']

    if (!cookieValue) {
      return {
        valid: false,
        error: 'Cookie is required (at least __Secure-1PSID)',
      }
    }

    return {
      valid: true,
      tokenType: 'cookie',
      accountInfo: {
        name: 'Gemini User',
      },
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const cookieValue =
      credentials['__Secure-1PSID'] ||
      credentials['psid'] ||
      credentials['cookie'] ||
      credentials['token']

    if (!cookieValue) {
      return null
    }

    return {
      type: 'cookie',
      value: cookieValue,
      extra: credentials,
    }
  }
}

export default GeminiAdapter
