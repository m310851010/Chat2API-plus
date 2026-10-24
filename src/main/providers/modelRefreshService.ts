/**
 * Dynamic Model Refresh Service
 * Periodically fetches model lists from upstream providers that support
 * dynamic model APIs (modelsApiEndpoint), keeping supportedModels in sync
 * so the proxy /v1/models route serves live data instead of hard-coded lists.
 */

import { ProviderManager } from '../store/providers'
import { AccountManager } from '../store/accounts'
import { getBuiltinProviders } from '../providers/builtin'
import { ProviderChecker } from '../providers/checker'
import { ChatGPTAdapter } from '../proxy/adapters/chatgpt'
import type { Provider } from '../../shared/types'

/** Refresh interval: 30 minutes */
const REFRESH_INTERVAL_MS = 30 * 60 * 1000
/** Delay after app start before the first background refresh */
const INITIAL_DELAY_MS = 10 * 1000

let refreshTimer: NodeJS.Timeout | null = null
let refreshing = false

async function fetchModelsForProvider(provider: Provider): Promise<string[]> {
  // ChatGPT web API requires full browser impersonation via its dedicated adapter
  if (provider.type === 'builtin' && (provider.id === 'chatgpt' || ChatGPTAdapter.isChatGPTProvider(provider))) {
    const accounts = AccountManager.getByProviderId(provider.id, true)
    const activeAccount = accounts.find(a => a.status === 'active')
    if (!activeAccount) {
      throw new Error('No active ChatGPT account')
    }

    const adapter = new ChatGPTAdapter(provider, activeAccount)
    return adapter.listModels()
  }

  const result = await ProviderChecker.fetchProviderModels(provider.id)
  return result.supportedModels
}

function persistModels(providerId: string, models: string[]): void {
  const modelMappings: Record<string, string> = {}
  models.forEach(model => {
    modelMappings[model] = model
  })

  ProviderManager.update(providerId, {
    supportedModels: models,
    modelMappings,
    modelsFetchedAt: Date.now(),
  })
}

/**
 * Refresh models for a single provider. Returns the fetched model list,
 * or null when the refresh failed or the provider does not support it.
 */
export async function refreshProviderModels(providerId: string): Promise<string[] | null> {
  const provider = ProviderManager.getById(providerId)
  if (!provider) {
    return null
  }

  if (provider.type !== 'builtin') {
    return null
  }

  const builtinConfig = getBuiltinProviders().find(p => p.id === providerId)
  if (!builtinConfig?.modelsApiEndpoint) {
    return null
  }

  try {
    const models = await fetchModelsForProvider(provider)
    if (models.length === 0) {
      return null
    }
    persistModels(provider.id, models)
    console.log(`[ModelRefresh] Refreshed ${models.length} models for ${provider.name}`)
    return models
  } catch (error) {
    console.warn(
      `[ModelRefresh] Failed to refresh models for ${provider.name}:`,
      error instanceof Error ? error.message : error
    )
    return null
  }
}

/** Refresh models for all enabled providers that support dynamic fetching */
export async function refreshAllProviderModels(): Promise<Record<string, number>> {
  if (refreshing) {
    return {}
  }
  refreshing = true

  const results: Record<string, number> = {}
  try {
    const providers = ProviderManager.getAll().filter(p => p.enabled && p.type === 'builtin')

    await Promise.all(
      providers.map(async provider => {
        const models = await refreshProviderModels(provider.id)
        if (models) {
          results[provider.id] = models.length
        }
      })
    )
  } finally {
    refreshing = false
  }

  return results
}

/** Start the background periodic refresh */
export function startModelRefreshService(): void {
  if (refreshTimer) {
    return
  }

  console.log('[ModelRefresh] Background model refresh service started')

  refreshTimer = setInterval(() => {
    refreshAllProviderModels().catch(error => {
      console.warn('[ModelRefresh] Background refresh failed:', error)
    })
  }, REFRESH_INTERVAL_MS)

  // Do not keep the app alive just for refreshing
  refreshTimer.unref()
}

export function stopModelRefreshService(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
    console.log('[ModelRefresh] Background model refresh service stopped')
  }
}

/** Kick off an initial delayed refresh after app start */
export function scheduleInitialModelRefresh(): void {
  const timer = setTimeout(() => {
    refreshAllProviderModels().catch(error => {
      console.warn('[ModelRefresh] Initial refresh failed:', error)
    })
  }, INITIAL_DELAY_MS)
  timer.unref()
}
