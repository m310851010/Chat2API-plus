/**
 * Grok Authentication Adapter
 * Authentication method: SSO cookie-based authentication with in-app browser login
 *
 * Note: grok.com uses the `sso` cookie (X.com account session). We accept the
 * SSO token directly; token validity is only discoverable when chatting.
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

const GROK_WEB_BASE = 'https://grok.com'

export class GrokAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'grok',
      authMethods: ['manual', 'cookie'],
      loginUrl: GROK_WEB_BASE,
      apiUrl: GROK_WEB_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'grok',
      error: 'Use startInAppLogin for automatic cookie extraction',
    }
  }

  async loginWithCookies(providerId: string, cookies: Record<string, string>): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating cookies...')

    const sso = this.resolveSsoToken(cookies)

    if (!sso) {
      return {
        success: false,
        providerId,
        providerType: 'grok',
        error: 'SSO token is required (the "sso" cookie from grok.com)',
      }
    }

    this.emitProgress('success', 'Cookie validation successful')

    return {
      success: true,
      providerId,
      providerType: 'grok',
      credentials: {
        cookie: Object.entries(cookies)
          .map(([name, value]) => `${name}=${value}`)
          .join('; '),
      },
      accountInfo: {
        name: 'Grok User',
      },
    }
  }

  protected async processCallback(data: OAuthCallbackData): Promise<void> {
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const sso = this.resolveSsoToken(credentials)

    if (!sso) {
      return {
        valid: false,
        error: 'Cookie is required (paste the full grok.com cookie string)',
      }
    }

    return {
      valid: true,
      tokenType: 'cookie',
      accountInfo: {
        name: 'Grok User',
      },
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const sso = this.resolveSsoToken(credentials)

    if (!sso) {
      return null
    }

    return {
      type: 'cookie',
      value: sso,
      extra: credentials,
    }
  }

  private resolveSsoToken(credentials: Record<string, string>): string | undefined {
    const raw = (
      credentials.cookie ||
      credentials.token ||
      credentials.sso ||
      credentials['sso-rw'] ||
      credentials.sessionToken ||
      ''
    ).trim()
    if (!raw) return undefined

    // Full cookie string (name=value pairs) → extract the sso value
    const pairs: Record<string, string> = {}
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=')
      if (idx > 0) {
        pairs[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
      }
    }
    const ssoVal = pairs['sso'] || pairs['sso-rw']
    if (ssoVal) return ssoVal

    // Pasted cookie pairs but no sso cookie → invalid
    return Object.keys(pairs).length ? undefined : raw
  }
}

export default GrokAdapter
