/**
 * ChatGPT Turnstile challenge solver
 * Ported from chatgpt2api reference implementation (utils/turnstile.py)
 * Interprets OpenAI's obfuscated DX bytecode to produce a turnstile token.
 */

export interface OrderedMap {
  keys: string[]
  values: Record<string, any>
}

function createOrderedMap(): OrderedMap {
  return { keys: [], values: {} }
}

function orderedMapSet(map: OrderedMap, key: string, value: any): void {
  if (!(key in map.values)) {
    map.keys.push(key)
  }
  map.values[key] = value
}

function turnstileToStr(value: any): string {
  if (value === null || value === undefined) return 'undefined'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    const special: Record<string, string> = {
      'window.Math': '[object Math]',
      'window.Reflect': '[object Reflect]',
      'window.performance': '[object Performance]',
      'window.localStorage': '[object Storage]',
      'window.Object': 'function Object() { [native code] }',
      'window.Reflect.set': 'function set() { [native code] }',
      'window.performance.now': 'function () { [native code] }',
      'window.Object.create': 'function create() { [native code] }',
      'window.Object.keys': 'function keys() { [native code] }',
      'window.Math.random': 'function random() { [native code] }',
    }
    return special[value] ?? value
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join(',')
  }
  return Array.isArray(value) ? JSON.stringify(value) : String(value)
}

function xorString(text: string, key: string): string {
  if (!key) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length))
  }
  return out
}

function isNumber(value: any): value is number {
  return typeof value === 'number' && !Number.isNaN(value)
}

export function solveTurnstileToken(dx: string, p: string): string | null {
  try {
    const decoded = Buffer.from(dx, 'base64').toString('utf8')
    const tokenList = JSON.parse(xorString(decoded, p))
    if (!Array.isArray(tokenList)) return null
    return solveTurnstile(tokenList, p)
  } catch {
    return null
  }
}

function solveTurnstile(tokenList: any[], p: string): string | null {
  const processMap = new Map<number, any>()
  let result = ''
  const startTime = Date.now()

  const normalise = (value: any): any => {
    if (value instanceof OrderedMapLike) {
      // map participates in operations via string merge etc.
      return value
    }
    return value
  }

  class OrderedMapLike {
    map = createOrderedMap()
    add(key: string, value: any) {
      orderedMapSet(this.map, key, value)
    }
  }

  function getValue(e: number): any {
    return processMap.get(e)
  }

  const func1 = (e: number, t: number): void => {
    processMap.set(e, xorString(turnstileToStr(getValue(e)), turnstileToStr(getValue(t))))
  }

  const func2 = (e: number, t: any): void => {
    processMap.set(e, normalise(t))
  }

  const func3 = (e: string): void => {
    result = Buffer.from(String(e), 'utf8').toString('base64')
  }

  const func5 = (e: number, t: number): void => {
    const current = getValue(e)
    const incoming = getValue(t)
    if (Array.isArray(current)) {
      processMap.set(e, [...current, incoming])
      return
    }
    if (
      typeof current === 'string' || isNumber(current) ||
      typeof incoming === 'string' || isNumber(incoming)
    ) {
      processMap.set(e, turnstileToStr(current) + turnstileToStr(incoming))
      return
    }
    processMap.set(e, 'NaN')
  }

  const func6 = (e: number, t: number, n: number): void => {
    const tv = getValue(t)
    const nv = getValue(n)
    if (typeof tv === 'string' && typeof nv === 'string') {
      const value = `${tv}.${nv}`
      processMap.set(e, value === 'window.document.location' ? 'https://chatgpt.com/' : value)
    }
  }

  const func7 = (e: number, ...args: number[]): void => {
    const target = getValue(e)
    const values = args.map((arg) => getValue(arg))
    if (typeof target === 'string' && target === 'window.Reflect.set') {
      const [obj, keyName, val] = values
      if (obj instanceof OrderedMapLike) {
        obj.add(String(keyName), val)
      }
      return
    }
    if (typeof target === 'function') {
      target(...values)
    }
  }

  const func8 = (e: number, t: number): void => {
    processMap.set(e, getValue(t))
  }

  const func14 = (e: number, t: number): void => {
    processMap.set(e, JSON.parse(turnstileToStr(getValue(t))))
  }

  const func15 = (e: number, t: number): void => {
    processMap.set(e, JSON.stringify(getValue(t)))
  }

  const func17 = (e: number, t: number, ...args: number[]): void => {
    const callArgs = args.map((arg) => getValue(arg))
    const target = getValue(t)
    if (target === 'window.performance.now') {
      const elapsedNs = (Date.now() - startTime) * 1_000_000
      processMap.set(e, (elapsedNs + Math.random()) / 1e6)
    } else if (target === 'window.Object.create') {
      processMap.set(e, new OrderedMapLike())
    } else if (target === 'window.Object.keys') {
      const keyArg = callArgs[0]
      if (keyArg === 'window.localStorage') {
        processMap.set(e, [
          'STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4',
          'STATSIG_LOCAL_STORAGE_STABLE_ID',
          'client-correlated-secret',
          'oai/apps/capExpiresAt',
          'oai-did',
          'STATSIG_LOCAL_STORAGE_LOGGING_REQUEST',
          'UiState.isNavigationCollapsed.1',
        ])
      } else if (Array.isArray(keyArg)) {
        processMap.set(e, keyArg)
      } else if (keyArg instanceof OrderedMapLike) {
        processMap.set(e, keyArg.map.keys)
      } else {
        processMap.set(e, [])
      }
    } else if (target === 'window.Math.random') {
      processMap.set(e, Math.random())
    } else if (typeof target === 'function') {
      processMap.set(e, target(...callArgs))
    }
  }

  const func18 = (e: number): void => {
    processMap.set(e, Buffer.from(turnstileToStr(getValue(e)), 'base64').toString('utf8'))
  }

  const func19 = (e: number): void => {
    processMap.set(e, Buffer.from(turnstileToStr(getValue(e)), 'utf8').toString('base64'))
  }

  const func20 = (e: number, t: number, n: number, ...args: number[]): void => {
    if (getValue(e) === getValue(t)) {
      const target = getValue(n)
      if (typeof target === 'function') {
        target(...args.map((arg) => getValue(arg)))
      }
    }
  }

  const func21 = (): void => {
    // no-op
  }

  const func23 = (e: number, t: number, ...args: number[]): void => {
    const fn = getValue(t)
    if (getValue(e) !== undefined && getValue(e) !== null && typeof fn === 'function') {
      fn(...args.map((arg) => getValue(arg)))
    }
  }

  const func24 = (e: number, t: number, n: number): void => {
    const tv = getValue(t)
    const nv = getValue(n)
    if (typeof tv === 'string' && typeof nv === 'string') {
      processMap.set(e, `${tv}.${nv}`)
    }
  }

  processMap.set(1, func1)
  processMap.set(2, func2)
  processMap.set(3, func3)
  processMap.set(5, func5)
  processMap.set(6, func6)
  processMap.set(7, func7)
  processMap.set(8, func8)
  processMap.set(9, tokenList)
  processMap.set(10, 'window')
  processMap.set(14, func14)
  processMap.set(15, func15)
  processMap.set(16, p)
  processMap.set(17, func17)
  processMap.set(18, func18)
  processMap.set(19, func19)
  processMap.set(20, func20)
  processMap.set(21, func21)
  processMap.set(23, func23)
  processMap.set(24, func24)

  for (const token of tokenList) {
    try {
      const fn = processMap.get(token[0])
      if (typeof fn === 'function') {
        fn(...token.slice(1))
      }
    } catch {
      continue
    }
  }

  return result || null
}
