/**
 * Doubao Risk-Control Captcha Window
 *
 * When Doubao's risk control (shark_admin) intercepts a chat request it
 * replies with a STREAM_ERROR event (code 710022002 / 710022004) asking for
 * a slide verification.
 *
 * Injecting the challenge into our own overlay fails: the verify service
 * validates the full browser/device context of the caller, and any mismatch
 * (origin, UA, fingerprints) is rejected with 参数错误[5005] or
 * 网络环境较差[5014] — even with the official captcha.js SDK on the real
 * page. So instead we drive the REAL doubao.com page: type a probe message
 * into its own composer, let the page raise ITS OWN captcha when risk
 * control kicks in, and let the user solve that fully-authentic challenge.
 *
 * Success is detected on the network layer: once the page's own
 * /samantha/chat/completion request completes with 200, the risk state has
 * cleared and the caller can retry the original request.
 */

import { BrowserWindow, session } from 'electron'
import { Account, Provider } from '../../store/types'

const DOUBAO_CHAT_URL = 'https://www.doubao.com/chat/'
const CAPTCHA_PARTITION = 'doubao-captcha'
/** Composer probe message sent through the real page */
const PROBE_MESSAGE = '你好'

export interface DoubaoCaptchaResult {
  outcome: DoubaoCaptchaOutcome
  /** The page session's complete doubao.com cookie jar at close time —
   * fresher than the originally pasted cookie string */
  capturedCookieJar?: string
}

export interface DoubaoCaptchaParams {
  /** Raw ext.decision JSON string from the STREAM_ERROR payload (unused by
   * the page-native flow; kept for API compatibility) */
  verifyData: string
  provider: Provider
  account: Account
}

export type DoubaoCaptchaOutcome = 'closed' | 'failed'

function parseCookieString(cookieStr: string): Array<{ name: string; value: string }> {
  const pairs: Array<{ name: string; value: string }> = []
  for (const part of cookieStr.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (name && value) pairs.push({ name, value })
  }
  return pairs
}

async function setDoubaoCookies(cookieStr: string): Promise<void> {
  const ses = session.fromPartition(CAPTCHA_PARTITION)
  for (const { name, value } of parseCookieString(cookieStr)) {
    for (const url of ['https://www.doubao.com', 'https://doubao.com']) {
      try {
        await ses.cookies.set({
          url,
          name,
          value,
          domain: '.doubao.com',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'no_restriction',
        })
      } catch {
        // duplicate/expired cookies are fine to skip
      }
    }
  }
}

/** Script that types the probe message into the real composer and sends it */
function buildComposerScript(message: string): string {
  return `
(function () {
  function findComposer() {
    var candidates = [
      'textarea.semi-input-textarea',
      'textarea[placeholder*="发消息"]',
      'textarea[placeholder*="输入"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
    ]
    for (var i = 0; i < candidates.length; i++) {
      var el = document.querySelector(candidates[i])
      if (el) return el
    }
    return null
  }

  function setValue(el, text) {
    el.focus()
    var tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      var proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      var descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
      if (descriptor && descriptor.set) descriptor.set.call(el, text)
      else el.value = text
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })) }
      catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })) }
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      // contenteditable composer
      el.textContent = text
      var sel = window.getSelection()
      var range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })) }
      catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })) }
    }
  }

  function pressEnter(el) {
    var opts = { bubbles: true, cancelable: true, keyCode: 13, which: 13, key: 'Enter', code: 'Enter' }
    el.dispatchEvent(new KeyboardEvent('keydown', opts))
    el.dispatchEvent(new KeyboardEvent('keypress', opts))
    el.dispatchEvent(new KeyboardEvent('keyup', opts))
  }

  function clickSendButton() {
    var btn = document.querySelector('[class*="send-button"]:not([disabled])')
      || document.querySelector('button[aria-label*="发送"]')
      || document.querySelector('[class*="send"][class*="icon"]:not([disabled])')
    if (btn) { btn.click(); return true }
    return false
  }

  var attempts = 0
  function trySend() {
    attempts += 1
    var el = findComposer()
    if (!el) {
      if (attempts < 20) { setTimeout(trySend, 1000); return }
      console.log('[c2a-compose] composer not found')
      window.__C2A_COMPOSER__ = 'not-found'
      return
    }
    setValue(el, ${JSON.stringify(message)})
    setTimeout(function () {
      pressEnter(el)
      if (!clickSendButton()) {
        // Enter may not have dispatched through the framework; retry click
        setTimeout(clickSendButton, 300)
      }
      console.log('[c2a-compose] message sent (attempt ' + attempts + ')')
      window.__C2A_COMPOSER__ = 'sent'
    }, 400)
  }

  trySend()
  return 'started'
})()
`
}

let activeCaptchaWindow: BrowserWindow | null = null

/**
 * Open the real Doubao page, send a probe message through its own composer
 * and let the page raise its own captcha when risk control kicks in.
 *
 * The result is NOT judged by timers: the user interacts with the page
 * (slides the page's own captcha if one appears — the page then answers on
 * its own) and closes the window when done. Closing resolves 'closed' and
 * the caller retries the original request; whether that retry passes is the
 * actual verification result. A generous safety timeout resolves 'failed'.
 */
export function solveDoubaoCaptcha(params: DoubaoCaptchaParams, timeoutMs = 180000): Promise<DoubaoCaptchaResult> {
  return new Promise((resolve) => {
    if (activeCaptchaWindow && !activeCaptchaWindow.isDestroyed()) {
      activeCaptchaWindow.focus()
      // Serialize: surface failure for the new request while the previous
      // window is still open; the user can retry after finishing it
      resolve({ outcome: 'failed' })
      return
    }

    let settled = false
    let timeoutTimer: NodeJS.Timeout | null = null
    let capturedCookieJar: string | undefined

    const settle = (outcome: DoubaoCaptchaOutcome) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      resolve({ outcome, capturedCookieJar })
    }

    try {
      const credentials = params.account.credentials as Record<string, any>
      const cookieStr = (
        credentials.cookie ||
        credentials.sessionToken ||
        credentials.token ||
        ''
      ).toString()

      const ses = session.fromPartition(CAPTCHA_PARTITION)

      /** Snapshot the page session's full cookie jar while the window lives */
      const captureCookieJar = async (): Promise<void> => {
        try {
          const cookies = await ses.cookies.get({ url: 'https://www.doubao.com' })
          if (cookies.length > 0) {
            capturedCookieJar = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ')
            console.log('[Doubao Captcha] captured cookie jar:', cookies.length, 'cookies')
          }
        } catch {
          // best effort
        }
      }

      // Keep the request context consistent with the adapter's chat request
      const adapterHeaders = (params.provider.headers || {}) as Record<string, string>
      const ua = adapterHeaders['User-Agent']
      if (ua) {
        ses.setUserAgent(ua)
        ses.webRequest.onBeforeSendHeaders((details, callback) => {
          const headers: Record<string, string> = { ...details.requestHeaders }
          headers['User-Agent'] = ua
          for (const hint of ['Sec-Ch-Ua', 'Sec-Ch-Ua-Platform', 'Sec-Ch-Ua-Mobile', 'Sec-Ch-Ua-Full-Version-List']) {
            if (adapterHeaders[hint]) {
              headers[hint] = adapterHeaders[hint]
            } else {
              delete headers[hint]
            }
          }
          callback({ requestHeaders: headers })
        })
      }

      // Prefer the freshest msToken: Doubao rotates it on every response and
      // a stale token makes risk control more aggressive
      const freshMsToken = (credentials.msToken || '').toString()
      const effectiveCookie = freshMsToken
        ? cookieStr.includes('msToken=')
          ? cookieStr.replace(/(^|;\s*)msToken=[^;]*/, (_m: any, sep: any) => `${sep}msToken=${freshMsToken}`)
          : `${cookieStr}; msToken=${freshMsToken}`
        : cookieStr

      setDoubaoCookies(effectiveCookie)
        .catch(() => {})
        .then(() => {
          const win = new BrowserWindow({
            width: 720,
            height: 900,
            title: '豆包安全验证 — 请在页面中完成验证',
            autoHideMenuBar: true,
            alwaysOnTop: true,
            webPreferences: {
              session: ses,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
            },
          })
          activeCaptchaWindow = win

          // Safety net only: results are judged by the caller's retry after
          // the user closes the window, not by timers
          timeoutTimer = setTimeout(() => {
            settle('failed')
            if (!win.isDestroyed()) win.close()
          }, timeoutMs)

          win.on('close', () => {
            // Snapshot while the session is still alive
            void captureCookieJar()
          })

          win.on('closed', () => {
            activeCaptchaWindow = null
            // The user closing the window is the completion signal: the
            // caller retries the original request and the retry result is
            // the actual verification verdict
            settle('closed')
          })

          win.webContents.on('console-message', (_event, _level, message) => {
            if (message.includes('[c2a-')) {
              console.log('[Doubao Captcha][page]', message)
            }
          })

          let composerInjected = false
          win.webContents.on('did-finish-load', () => {
            if (composerInjected) return
            if (!win.webContents.getURL().includes('doubao.com/chat')) return
            composerInjected = true
            win.webContents
              .executeJavaScript(buildComposerScript(PROBE_MESSAGE))
              .catch(() => {})
          })

          // Redirects mid-load reject loadURL with ERR_ABORTED while the
          // window keeps working — never treat that as a failure
          win.loadURL(DOUBAO_CHAT_URL).catch((error) => {
            console.warn('[Doubao Captcha] loadURL interrupted (page redirect?):', String(error).slice(0, 120))
          })
        })
    } catch (error) {
      console.error('[Doubao Captcha] Failed to open captcha window:', error)
      settle('failed')
    }
  })
}
