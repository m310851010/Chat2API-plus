/**
 * Mimo Authentication Adapter
 * Authentication method: full browser Cookie string from aistudio.xiaomimimo.com
 *
 * The cookie string must contain at least `serviceToken` (httpOnly login state)
 * and `xiaomichatbot_ph` (per-chat query parameter).
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
import { getMimoServiceToken, parseCookieValue } from '../../proxy/adapters/mimo'

const MIMO_WEB_BASE = 'https://aistudio.xiaomimimo.com'

/** Composes a full cookie string from loosely collected cookie entries. */
export function composeMimoCookie(entries: Record<string, string>): string {
  const nameMap: Array<[string, string]> = [
    ['xiaomichatbot_serviceToken', 'xiaomichatbot_serviceToken'],
    ['serviceToken', 'serviceToken'],
    ['service_token', 'serviceToken'],
    ['userId', 'userId'],
    ['user_id', 'userId'],
    ['xiaomichatbot_ph', 'xiaomichatbot_ph'],
    ['ph_token', 'xiaomichatbot_ph'],
  ]

  const parts: string[] = []
  for (const [sourceKey, cookieName] of nameMap) {
    const value = entries[sourceKey]
    if (value && !parts.some((part) => part.startsWith(`${cookieName}=`))) {
      parts.push(`${cookieName}=${value}`)
    }
  }
  return parts.join('; ')
}

/** Required entries of a usable Mimo cookie string. */
function findMissingCookieEntries(cookie: string): string[] {
  const missing: string[] = []
  if (!getMimoServiceToken(cookie)) {
    missing.push('serviceToken (or xiaomichatbot_serviceToken)')
  }
  if (!parseCookieValue(cookie, 'xiaomichatbot_ph')) {
    missing.push('xiaomichatbot_ph')
  }
  return missing
}

export class MimoAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'mimo',
      authMethods: ['manual', 'cookie'],
      loginUrl: MIMO_WEB_BASE,
      apiUrl: MIMO_WEB_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'mimo',
      error: `Use startInAppLogin for automatic cookie extraction, or paste the full cookie string from ${MIMO_WEB_BASE}`,
    }
  }

  async loginWithCookies(providerId: string, cookies: Record<string, string>): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating cookies...')

    const cookie = cookies.cookie || composeMimoCookie(cookies)

    const missing = findMissingCookieEntries(cookie)
    if (!cookie || missing.length > 0) {
      return {
        success: false,
        providerId,
        providerType: 'mimo',
        error: `Cookie is missing required entries: ${missing.join(', ')}. Sign in at ${MIMO_WEB_BASE} and copy the full cookie string.`,
      }
    }

    this.emitProgress('success', 'Cookie validation successful')

    return {
      success: true,
      providerId,
      providerType: 'mimo',
      credentials: { cookie },
      accountInfo: {
        userId: parseCookieValue(cookie, 'userId'),
        name: 'Mimo User',
      },
    }
  }

  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // No callback processing needed for cookie-based auth
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    // New single-field accounts store the full cookie string; legacy accounts
    // keep the three split fields and are composed back into one string.
    const cookie = (credentials.cookie || composeMimoCookie(credentials)).trim()

    if (!cookie) {
      return {
        valid: false,
        error: `Missing Mimo cookie. Sign in at ${MIMO_WEB_BASE} and paste the full cookie string (must include serviceToken and xiaomichatbot_ph).`,
      }
    }

    const missing = findMissingCookieEntries(cookie)
    if (missing.length > 0) {
      return {
        valid: false,
        error: `Cookie is missing required entries: ${missing.join(', ')}`,
      }
    }

    return {
      valid: true,
      tokenType: 'cookie',
      accountInfo: {
        userId: parseCookieValue(cookie, 'userId'),
        name: 'Mimo User',
      },
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const cookie = (credentials.cookie || composeMimoCookie(credentials)).trim()

    if (!cookie) {
      return null
    }

    return {
      type: 'cookie',
      value: cookie,
      extra: { cookie },
    }
  }
}

export default MimoAdapter
