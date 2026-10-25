/**
 * Doubao SSE wire-protocol helpers (pure, no Electron dependencies —
 * shared by the proxy adapter and unit tests).
 */

/** Doubao risk-control codes that require a slide-captcha verification */
export const DOUBAO_RISK_CODES = ['710022002', '710022004']

/** Buffer cap for pre-flight risk detection before falling back to passthrough */
export const RISK_SCAN_BUFFER_LIMIT = 65536

/**
 * Scan a raw SSE buffer for a Doubao verify challenge (STREAM_ERROR 2005
 * event carrying error_detail.ext.decision). Returns the decision JSON
 * string for the captcha SDK, or null when no complete challenge line is
 * present yet (callers keep buffering).
 */
export function extractDoubaoVerifyData(buffer: string): string | null {
  if (!buffer.includes('"decision"') && !DOUBAO_RISK_CODES.some((code) => buffer.includes(code))) {
    return null
  }

  const parseJsonSafe = (value: any): any => {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }

  for (const rawLine of buffer.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue

    const data = parseJsonSafe(payload)
    if (!data || typeof data !== 'object') continue

    // The 2005 event nests the decision twice: data.event_data is itself a
    // JSON string containing error_detail.ext.decision
    for (const obj of [data, parseJsonSafe(data.event_data)]) {
      if (!obj || typeof obj !== 'object') continue
      const decision = obj.error_detail?.ext?.decision ?? obj.ext?.decision ?? obj.decision
      if (typeof decision === 'string' && decision.includes('"type"')) {
        return decision
      }
    }
  }

  return null
}

/** True when a normal content/conversation event appeared before any error */
export function hasNormalDoubaoEvent(buffer: string): boolean {
  return buffer.includes('"event_type":2001') || buffer.includes('"event_type":2002')
}
