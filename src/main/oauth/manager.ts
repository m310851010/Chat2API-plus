/**
 * OAuth Flow Manager
 * Manages authentication flows for providers, including local callback server and browser login
 */

import { BrowserWindow, shell, app } from 'electron'
import http from 'http'
import { EventEmitter } from 'events'
import {
  ProviderType,
  OAuthResult,
  OAuthOptions,
  OAuthStatus,
  OAuthProgressEvent,
  TokenValidationResult,
  CredentialInfo,
} from './types'
import { createAdapter, BaseOAuthAdapter } from './adapters'
import { composeMimoCookie } from './adapters/mimo'
import { getMimoServiceToken, parseCookieValue } from '../proxy/adapters/mimo'
import { storeManager } from '../store/store'
import { inAppLoginManager, InAppLoginResult } from './inAppLogin'

const DEFAULT_CALLBACK_PORT = 8311
const DEFAULT_TIMEOUT = 300000 // 5 minutes

/**
 * OAuth Manager class
 */
export class OAuthManager extends EventEmitter {
  private adapters: Map<string, BaseOAuthAdapter> = new Map()
  private mainWindow: BrowserWindow | null = null
  private currentLogin: {
    providerId: string
    adapter: BaseOAuthAdapter
    resolve: (result: OAuthResult) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  } | null = null

  constructor() {
    super()
  }

  /**
   * Set main window reference
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Get or create adapter
   */
  private getAdapter(providerId: string, providerType: ProviderType): BaseOAuthAdapter {
    const key = `${providerId}_${providerType}`
    
    if (!this.adapters.has(key)) {
      const adapter = createAdapter(providerType, {
        providerId,
        providerType,
        authMethods: [],
        callbackPort: DEFAULT_CALLBACK_PORT,
      })
      
      if (this.mainWindow) {
        adapter.setMainWindow(this.mainWindow)
      }
      
      adapter.setProgressCallback((event) => {
        this.emit('progress', event)
        this.sendProgressToRenderer(event)
      })
      
      this.adapters.set(key, adapter)
    }
    
    return this.adapters.get(key)!
  }

  /**
   * Send progress to renderer process
   */
  private sendProgressToRenderer(event: OAuthProgressEvent): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('oauth:progress', event)
    }
  }

  /**
   * Start OAuth login flow
   */
  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    if (this.currentLogin) {
      return {
        success: false,
        providerId: options.providerId,
        providerType: options.providerType,
        error: 'A login process is already in progress',
      }
    }

    return new Promise((resolve, reject) => {
      const adapter = this.getAdapter(options.providerId, options.providerType)
      
      const timeout = setTimeout(() => {
        this.cancelLogin()
        const result: OAuthResult = {
          success: false,
          providerId: options.providerId,
          providerType: options.providerType,
          error: 'Login timeout',
        }
        resolve(result)
      }, options.timeout || DEFAULT_TIMEOUT)

      this.currentLogin = {
        providerId: options.providerId,
        adapter,
        resolve,
        reject,
        timeout,
      }

      this.emit('statusChange', 'pending')

      adapter.startLogin(options)
        .then((result) => {
          this.cleanup()
          resolve(result)
        })
        .catch((error) => {
          this.cleanup()
          reject(error)
        })
    })
  }

  /**
   * Complete authentication with manually entered token
   */
  async loginWithToken(
    providerId: string,
    providerType: ProviderType,
    token: string,
    realUserID?: string,
    mimoUserId?: string,
    mimoPhToken?: string
  ): Promise<OAuthResult> {
    const adapter = this.getAdapter(providerId, providerType)
    
    if ('loginWithToken' in adapter && typeof (adapter as any).loginWithToken === 'function') {
      return await (adapter as any).loginWithToken(providerId, token, realUserID, mimoUserId, mimoPhToken)
    }
    
    // For Mimo, the token is the full aistudio.xiaomimimo.com cookie string
    // (legacy callers may still pass the three split fields)
    if (providerType === 'mimo') {
      if (mimoUserId && mimoPhToken) {
        const validation = await adapter.validateToken({
          service_token: token,
          user_id: mimoUserId,
          ph_token: mimoPhToken,
        })

        if (!validation.valid) {
          return {
            success: false,
            providerId,
            providerType,
            error: validation.error || 'Token validation failed',
          }
        }

        return {
          success: true,
          providerId,
          providerType,
          credentials: {
            service_token: token,
            user_id: mimoUserId,
            ph_token: mimoPhToken,
          },
          accountInfo: validation.accountInfo,
        }
      }

      const validation = await adapter.validateToken({ cookie: token })

      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType,
          error: validation.error || 'Token validation failed',
        }
      }

      return {
        success: true,
        providerId,
        providerType,
        credentials: { cookie: token },
        accountInfo: validation.accountInfo,
      }
    }
    
    const validation = await adapter.validateToken({ token })
    
    if (!validation.valid) {
      return {
        success: false,
        providerId,
        providerType,
        error: validation.error || 'Token validation failed',
      }
    }
    
    return {
      success: true,
      providerId,
      providerType,
      credentials: { token },
      accountInfo: validation.accountInfo,
    }
  }

  /**
   * Cancel current login flow
   */
  async cancelLogin(): Promise<void> {
    if (this.currentLogin) {
      await this.currentLogin.adapter.cancelLogin()
      this.cleanup()
      this.emit('statusChange', 'cancelled')
    }
  }

  /**
   * Clean up current login state
   */
  private cleanup(): void {
    if (this.currentLogin) {
      clearTimeout(this.currentLogin.timeout)
      this.currentLogin = null
    }
  }

  /**
   * Validate Token
   */
  async validateToken(
    providerId: string,
    providerType: ProviderType,
    credentials: Record<string, string>
  ): Promise<TokenValidationResult> {
    const adapter = this.getAdapter(providerId, providerType)
    return adapter.validateToken(credentials)
  }

  /**
   * Refresh Token
   */
  async refreshToken(
    providerId: string,
    providerType: ProviderType,
    credentials: Record<string, string>
  ): Promise<CredentialInfo | null> {
    const adapter = this.getAdapter(providerId, providerType)
    return adapter.refreshToken(credentials)
  }

  /**
   * Open browser
   */
  async openBrowser(url: string): Promise<void> {
    await shell.openExternal(url)
  }

  /**
   * Get current login status
   */
  getStatus(): OAuthStatus {
    return this.currentLogin ? 'pending' : 'idle'
  }

  /**
   * Start in-app login flow
   * Opens a new browser window within the app for login
   * Automatically extracts token after successful login
   */
  async startInAppLogin(
    providerId: string,
    providerType: ProviderType,
    timeout?: number,
    proxyMode?: 'system' | 'none'
  ): Promise<OAuthResult> {
    this.emit('statusChange', 'pending')
    this.sendProgressToRenderer({
      status: 'pending',
      message: 'Opening login window...',
    })

    return new Promise((resolve) => {
      const adapter = this.getAdapter(providerId, providerType)
      const collectedTokens: Record<string, string> = {}
      let isValidating = false

      const statusHandler = (event: { status: string; message: string }) => {
        this.sendProgressToRenderer({
          status: event.status as OAuthStatus,
          message: event.message,
        })
      }

      const completeHandler = (result: { success: boolean; credentials?: Record<string, string>; error?: string }) => {
        inAppLoginManager.off('status', statusHandler)
        inAppLoginManager.off('tokenFound', tokenFoundHandler)
        inAppLoginManager.off('complete', completeHandler)

        if (result.success && result.credentials) {
          this.emit('statusChange', 'success')
          this.sendProgressToRenderer({
            status: 'success',
            message: 'Login successful',
          })
          resolve({
            success: true,
            providerId,
            providerType,
            credentials: result.credentials,
          })
        } else {
          this.emit('statusChange', 'error')
          resolve({
            success: false,
            providerId,
            providerType,
            error: result.error || 'Login failed',
          })
        }
      }

      let validationTimeout: NodeJS.Timeout | null = null

      const tokenFoundHandler = async (event: { key: string; value: string; allCookies?: Record<string, string> }) => {
        console.log('[OAuthManager] tokenFoundHandler called, isValidating:', isValidating, 'event:', event.key, event.value.substring(0, 50) + '...')

        // Store the token
        collectedTokens[event.key] = event.value
        
        // Store all cookies if provided (needed for Cloudflare-protected requests)
        if (event.allCookies) {
          collectedTokens['cookies'] = event.allCookies as any
          console.log('[OAuthManager] Stored all cookies:', Object.keys(event.allCookies).length, 'cookies')
        }
        
        console.log('[OAuthManager] Collected tokens:', Object.keys(collectedTokens))

        // For MiniMax, we need both token and realUserID before validating
        if (providerType === 'minimax') {
          if (!collectedTokens.token) {
            console.log('[OAuthManager] Waiting for JWT token...')
            return
          }

          // If we just got the token, wait a bit for realUserID to be collected
          if (event.key === 'token' && !collectedTokens.realUserID) {
            console.log('[OAuthManager] Got token, waiting for realUserID...')

            // Clear any existing timeout
            if (validationTimeout) {
              clearTimeout(validationTimeout)
            }

            // Wait 500ms for realUserID to be collected
            validationTimeout = setTimeout(() => {
              console.log('[OAuthManager] Proceeding with validation, collected tokens:', Object.keys(collectedTokens))
              validateAndComplete()
            }, 500)
            return
          }

          // If we got realUserID but already have token, trigger validation immediately
          if (event.key === 'realUserID' && collectedTokens.token && !isValidating) {
            console.log('[OAuthManager] Got realUserID, token already available, validating...')
            if (validationTimeout) {
              clearTimeout(validationTimeout)
            }
            validateAndComplete()
            return
          }
        }

        // For Mimo, wait until the cookie carries the login state (serviceToken
        // + xiaomichatbot_ph) before validating
        if (providerType === 'mimo') {
          const cookie = composeMimoCookie(collectedTokens)
          const hasServiceToken = !!getMimoServiceToken(cookie)
          const hasPhToken = !!parseCookieValue(cookie, 'xiaomichatbot_ph')

          if (!hasServiceToken || !hasPhToken) {
            console.log('[OAuthManager] Waiting for Mimo cookies...', {
              hasServiceToken,
              hasPhToken,
            })

            // Clear any existing timeout
            if (validationTimeout) {
              clearTimeout(validationTimeout)
            }

            // Wait 500ms for the cookies to be collected
            validationTimeout = setTimeout(() => {
              console.log('[OAuthManager] Proceeding with Mimo validation, collected tokens:', Object.keys(collectedTokens))
              validateAndComplete()
            }, 500)
            return
          }

          // Required cookies collected, trigger validation immediately
          if (!isValidating) {
            console.log('[OAuthManager] Mimo cookies collected, validating...')
            if (validationTimeout) {
              clearTimeout(validationTimeout)
            }
            validateAndComplete()
            return
          }
        }

        // For Gemini, we need __Secure-1PSID and SAPISID before validating
        if (providerType === 'gemini') {
          const hasPsid = collectedTokens['__Secure-1PSID'] || collectedTokens.psids || collectedTokens.cookie
          const hasSapisid = collectedTokens['SAPISID']

          if (!hasPsid) {
            console.log('[OAuthManager] Gemini: Waiting for __Secure-1PSID cookie...')
            return
          }

          if (event.key === '__Secure-1PSID' && !hasSapisid && !isValidating) {
            console.log('[OAuthManager] Gemini: Got __Secure-1PSID, waiting for SAPISID...')

            if (validationTimeout) {
              clearTimeout(validationTimeout)
            }

            // Give SAPISID a short window to be collected, then proceed anyway
            validationTimeout = setTimeout(() => {
              if (!isValidating) {
                console.log('[OAuthManager] Gemini: Proceeding with validation (collected tokens):', Object.keys(collectedTokens))
                validateAndComplete()
              }
            }, 800)
            return
          }
        }

        // For non-MiniMax/Mimo providers, validate immediately when we have a token
        if (providerType !== 'minimax' && providerType !== 'mimo') {
          if (isValidating) {
            console.log('[OAuthManager] Already validating, skipping')
            return
          }
          validateAndComplete()
        }
      }

      const validateAndComplete = async () => {
        if (isValidating) {
          console.log('[OAuthManager] Already validating, skipping')
          return
        }

        isValidating = true
        this.sendProgressToRenderer({
          status: 'pending',
          message: 'Validating token...',
        })

        try {
          let validationCredentials: Record<string, string>
          let finalCredentials: Record<string, string>

          if (providerType === 'minimax') {
            const token = collectedTokens.token
            const realUserID = collectedTokens.realUserID

            if (realUserID) {
              const combinedToken = `${realUserID}+${token}`
              validationCredentials = { token: combinedToken }
              finalCredentials = { token, realUserID }
              console.log('[OAuthManager] MiniMax: Using combined token for validation, saving separately')
            } else {
              validationCredentials = { token }
              finalCredentials = { token }
              console.log('[OAuthManager] MiniMax: Using token only (realUserID not found)')
            }
          } else if (providerType === 'mimo') {
            const cookie = composeMimoCookie(collectedTokens)

            console.log('[OAuthManager] Mimo collectedTokens:', JSON.stringify(collectedTokens, null, 2))

            if (!getMimoServiceToken(cookie) || !parseCookieValue(cookie, 'xiaomichatbot_ph')) {
              console.log('[OAuthManager] Mimo: Missing required cookies, aborting validation')
              this.sendProgressToRenderer({
                status: 'pending',
                message: 'Missing required cookies (serviceToken / xiaomichatbot_ph), waiting for valid login...',
              })
              isValidating = false
              return
            }

            validationCredentials = { cookie }
            finalCredentials = { cookie }
            console.log('[OAuthManager] Mimo: Final credentials prepared:', Object.keys(finalCredentials))
          } else {
            validationCredentials = { ...collectedTokens }
            finalCredentials = { ...collectedTokens }
          }

          console.log('[OAuthManager] Calling adapter.validateToken with credentials:', Object.keys(validationCredentials))
          const validation = await adapter.validateToken(validationCredentials)
          console.log('[OAuthManager] Validation result:', validation)

          if (validation.valid) {
            console.log('[OAuthManager] Token is valid, completing login with credentials:', JSON.stringify(finalCredentials, null, 2))
            inAppLoginManager.completeWithSuccess(finalCredentials)
          } else {
            console.log('[OAuthManager] Token validation failed:', validation.error)
            this.sendProgressToRenderer({
              status: 'pending',
              message: `Token invalid: ${validation.error}, waiting for valid login...`,
            })
            isValidating = false
          }
        } catch (error) {
          console.error('[OAuthManager] Validation error:', error)
          this.sendProgressToRenderer({
            status: 'pending',
            message: 'Validation error, waiting for valid login...',
          })
          isValidating = false
        }
      }

      inAppLoginManager.on('status', statusHandler)
      inAppLoginManager.on('tokenFound', tokenFoundHandler)
      inAppLoginManager.on('complete', completeHandler)

      inAppLoginManager.startLogin({
        providerId,
        providerType,
        timeout: timeout || DEFAULT_TIMEOUT,
        proxyMode,
      }).then((result) => {
        if (!result.success) {
          completeHandler(result)
        }
      })
    })
  }

  /**
   * Cancel in-app login
   */
  cancelInAppLogin(): void {
    inAppLoginManager.cancel()
  }

  /**
   * Check if in-app login window is open
   */
  isInAppLoginOpen(): boolean {
    return inAppLoginManager.isWindowOpen()
  }

  /**
   * Destroy manager
   */
  destroy(): void {
    this.cancelLogin()
    inAppLoginManager.destroy()
    this.adapters.forEach((adapter) => adapter.destroy())
    this.adapters.clear()
    this.removeAllListeners()
  }
}

/**
 * Singleton instance
 */
export const oauthManager = new OAuthManager()

export default OAuthManager
