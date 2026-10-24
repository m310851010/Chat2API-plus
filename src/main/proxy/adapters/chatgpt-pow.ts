/**
 * ChatGPT Sentinel / Proof-of-Work utilities
 * Ported from chatgpt2api reference implementation (utils/pow.py)
 */

import crypto from 'crypto'
import https from 'https'
import { sha3_512 } from 'js-sha3'

const DEFAULT_POW_SCRIPT = 'https://chatgpt.com/backend-api/sentinel/sdk.js'

const CORES = [8, 16, 24, 32]
const DOCUMENT_KEYS = [
  '__reactContainer$fzelfjyxej8',
  '_reactListening5dehydibo78',
  'location',
]
const SCREEN_RESOLUTIONS = [
  [1920, 1080],
  [1440, 900],
  [2560, 1440],
  [3840, 2160],
]

const NAVIGATOR_KEYS = [
  'registerProtocolHandler−function registerProtocolHandler() { [native code] }',
  'storage−[object StorageManager]',
  'locks−[object LockManager]',
  'appCodeName−Mozilla',
  'permissions−[object Permissions]',
  'share−function share() { [native code] }',
  'webdriver−false',
  'managed−[object NavigatorManagedData]',
  'canShare−function canShare() { [native code] }',
  'vendor−Google Inc.',
  'mediaDevices−[object MediaDevices]',
  'vibrate−function vibrate() { [native code] }',
  'storageBuckets−[object StorageBucketManager]',
  'mediaCapabilities−[object MediaCapabilities]',
  'cookieEnabled−true',
  'virtualKeyboard−[object VirtualKeyboard]',
  'product−Gecko',
  'presentation−[object Presentation]',
  'onLine−true',
  'mimeTypes−[object MimeTypeArray]',
  'credentials−[object CredentialsContainer]',
  'serviceWorker−[object ServiceWorkerContainer]',
  'keyboard−[object Keyboard]',
  'gpu−[object GPU]',
  'doNotTrack',
  'serial−[object Serial]',
  'pdfViewerEnabled−true',
  'language−zh-CN',
  'geolocation−[object Geolocation]',
  'userAgentData−[object NavigatorUAData]',
  'getUserMedia−function getUserMedia() { [native code] }',
  'sendBeacon−function sendBeacon() { [native code] }',
  'hardwareConcurrency−32',
  'windowControlsOverlay−[object WindowControlsOverlay]',
]

const WINDOW_KEYS = [
  '0', 'window', 'self', 'document', 'name', 'location', 'customElements',
  'history', 'navigation', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY',
  'visualViewport', 'screenX', 'screenY', 'outerWidth', 'outerHeight',
  'devicePixelRatio', 'screen', 'chrome', 'navigator', 'onresize',
  'performance', 'crypto', 'indexedDB', 'sessionStorage', 'localStorage',
  'scheduler', 'alert', 'atob', 'btoa', 'fetch', 'matchMedia', 'postMessage',
  'queueMicrotask', 'requestAnimationFrame', 'setInterval', 'setTimeout',
  'caches', '__NEXT_DATA__', '__BUILD_MANIFEST', '__NEXT_PRELOADREADY',
]

export function newUUID(): string {
  return crypto.randomUUID()
}

function legacyParseTime(): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const shifted = new Date(Date.now() - 5 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = names[shifted.getUTCDay()]
  const month = months[shifted.getUTCMonth()]
  return (
    `${day} ${month} ${String(shifted.getUTCDate()).padStart(2, '0')} ${shifted.getUTCFullYear()} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())} ` +
    'GMT-0500 (Eastern Standard Time)'
  )
}

function pickRandom<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

export interface PowResources {
  scriptSources: string[]
  dataBuild: string
}

/** Parse ChatGPT landing page HTML to extract PoW script references and build tag. */
export function parsePowResources(html: string): PowResources {
  const scriptSources: string[] = []
  const scriptRe = /<script[^>]*\ssrc=["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  while ((match = scriptRe.exec(html)) !== null) {
    scriptSources.push(match[1])
  }
  let dataBuild = ''
  const buildMatch = html.match(/data-build="([^"]*)"/)
  if (buildMatch) {
    dataBuild = buildMatch[1]
  }

  return {
    scriptSources: scriptSources.length > 0 ? scriptSources : [DEFAULT_POW_SCRIPT],
    dataBuild,
  }
}

export function buildPowConfig(
  userAgent: string,
  scriptSources: string[] = [DEFAULT_POW_SCRIPT],
  dataBuild: string = ''
): unknown[] {
  return [
    pickRandom(SCREEN_RESOLUTIONS)[0] + pickRandom(SCREEN_RESOLUTIONS)[1],
    legacyParseTime(),
    4294705152,
    1,
    userAgent,
    pickRandom(scriptSources),
    dataBuild,
    'en-US',
    'en-US,es-US,en,es',
    Math.random(),
    pickRandom(NAVIGATOR_KEYS),
    pickRandom(DOCUMENT_KEYS),
    pickRandom(WINDOW_KEYS),
    (Date.now() % 1e9) + Math.random(),
    newUUID(),
    '',
    pickRandom(CORES),
    Date.now() - ((Date.now() % 1e9) + Math.random()),
    0, 0, 0, 0, 0, 0,
    0,
  ]
}

function b64(data: unknown): string {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64')
}

/** sha3-512 digested bytes. Electron's bundled OpenSSL lacks SHA3, so use the pure-JS implementation. */
function sha3Digest(data: Buffer): Buffer {
  return Buffer.from(sha3_512.arrayBuffer(data as unknown as Uint8Array) as ArrayBuffer)
}

/** Solve the sha3-512 proof-of-work challenge. */
export function solvePow(seed: string, difficulty: string, config: unknown[], limit = 500000): string | null {
  const target = Buffer.from(difficulty, 'hex')
  if (target.length === 0) {
    return b64(config)
  }
  const diffLen = target.length
  const seedBytes = Buffer.from(seed, 'utf8')

  const head = JSON.stringify(config.slice(0, 3)).slice(0, -1) + ','
  const mid = ',' + JSON.stringify(config.slice(4, 9)).slice(1, -1) + ','
  const tail = ',' + JSON.stringify(config.slice(10)).slice(1)

  const prefix = Buffer.concat([seedBytes])
  for (let i = 0; i < limit; i++) {
    const finalJson = `${head}${i}${mid}${i >> 1}${tail}`
    const encoded = Buffer.from(finalJson, 'utf8').toString('base64')
    const digest = sha3Digest(Buffer.concat([prefix, Buffer.from(encoded, 'ascii')]))
    if (Buffer.compare(digest.subarray(0, diffLen), target) <= 0) {
      return encoded
    }
  }
  return null
}

/** Generate the gAAAAAC requirements token (no solving required). */
export function buildLegacyRequirementsToken(
  userAgent: string,
  scriptSources: string[] = [DEFAULT_POW_SCRIPT],
  dataBuild: string = ''
): string {
  const config = buildPowConfig(userAgent, scriptSources, dataBuild)
  return 'gAAAAAC' + b64(config)
}

/** Generate the gAAAAAB proof token solving the difficulty challenge. */
export function buildProofToken(
  seed: string,
  difficulty: string,
  userAgent: string,
  scriptSources: string[] = [DEFAULT_POW_SCRIPT],
  dataBuild: string = ''
): string {
  const config = buildPowConfig(userAgent, scriptSources, dataBuild)
  const answer = solvePow(seed || '', difficulty || '', config)
  if (!answer) {
    throw new Error(`failed to solve proof token: difficulty=${difficulty}`)
  }
  return 'gAAAAAB' + answer
}

/** GET or POST JSON helper used by sentinel bootstrap requests. */
export async function chatgptJsonRequest(
  url: string,
  options: {
    method?: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: unknown
    timeout?: number
    agent?: any
  } = {}
): Promise<{ status: number; data: any; text: string; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET'
    const payload = options.body !== undefined ? Buffer.from(JSON.stringify(options.body), 'utf8') : undefined
    const headers: Record<string, string | number> = { ...(options.headers || {}) }
    if (payload) {
      headers['Content-Length'] = payload.length
    }
    const req = https.request(url, {
      method,
      headers,
      ...(options.agent ? { agent: options.agent } : {}),
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data: any = null
        try {
          data = JSON.parse(text)
        } catch {
          data = null
        }
        const setCookieRaw = res.headers['set-cookie']
        const setCookie = Array.isArray(setCookieRaw) ? setCookieRaw : setCookieRaw ? [setCookieRaw] : []
        resolve({ status: res.statusCode || 0, data, text, setCookie })
      })
    })
    req.setTimeout(options.timeout || 30000, () => {
      req.destroy(new Error('request timeout'))
    })
    req.on('error', reject)
    if (payload) {
      req.write(payload)
    }
    req.end()
  })
}
