/**
 * Shared outbound proxy agent helper for ChatGPT adapter.
 * Reads `apiProxyUrl` from app config and builds matching agents.
 *
 * Supported formats:
 *  - http://host[:port]
 *  - https://host[:port]
 *  - socks5://[user:pass@]host[:port]  (also socks4)
 *  - "system"  – Electron/Chromium system proxy not applied; falls back to direct
 */

import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { ConfigManager } from '../../store/config'
import type { Agent } from 'http'

export interface ProxyAgents {
  httpAgent: Agent
  httpsAgent: Agent
}

let cachedProxyUrl: string | null = null
let cachedAgents: ProxyAgents | null = null

export function buildProxyAgents(proxyUrl: string): ProxyAgents | null {
  const trimmed = (proxyUrl || '').trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    console.warn('[Proxy] Invalid apiProxyUrl, ignoring:', trimmed)
    return null
  }

  const protocol = parsed.protocol.replace(':', '').toLowerCase()
  const auth = parsed.username || parsed.password
    ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
    : undefined

  try {
    if (protocol === 'http' || protocol === 'https') {
      const agent = new HttpsProxyAgent(trimmed)
      return { httpAgent: agent, httpsAgent: agent }
    }
    if (protocol === 'socks' || protocol === 'socks5' || protocol === 'socks4') {
      const agent = new SocksProxyAgent({
        host: parsed.hostname,
        port: parsed.port || '1080',
        type: protocol === 'socks4' ? 4 : 5,
        userId: auth ? auth.split(':')[0] : undefined,
        password: auth ? auth.split(':')[1] : undefined,
      })
      return { httpAgent: agent, httpsAgent: agent }
    }
  } catch (error) {
    console.warn('[Proxy] Failed to create proxy agent:', error instanceof Error ? error.message : error)
    return null
  }

  console.warn('[Proxy] Unsupported proxy protocol:', protocol)
  return null
}

/** Returns cached agents for the configured apiProxyUrl (rebuilds when config changes). */
export function getProxyAgents(): ProxyAgents | null {
  let proxyUrl = ''
  try {
    proxyUrl = ConfigManager.get().apiProxyUrl || ''
  } catch {
    proxyUrl = ''
  }
  if (proxyUrl && cachedAgents && cachedProxyUrl === proxyUrl) {
    return cachedAgents
  }
  if (!proxyUrl && cachedAgents === null && cachedProxyUrl === '') {
    return null
  }
  const agents = buildProxyAgents(proxyUrl)
  // Cache only when a proxy is configured; remember the value either way to avoid rebuild loops
  cachedProxyUrl = proxyUrl
  cachedAgents = agents
  return agents
}
