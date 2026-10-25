/**
 * Provider Factory
 * Builds a persisted Provider object from creation data. When the data targets
 * a built-in provider (matching id), the built-in configuration fills any
 * fields the caller did not pass — notably modelMappings, chatPath and
 * credentialFields — so providers created through the UI or management API
 * behave the same as startup-synced ones. Kept free of electron imports so it
 * can be unit-tested with plain node.
 */

import type { Provider, AuthType } from '../../shared/types'
import type { CredentialField } from '../store/types'
import { builtinProviderMap } from './builtin/index.ts'

/** Persisted providers may carry credentialFields even though the shared
 *  Provider interface does not declare it yet (startup sync re-applies it). */
export type PersistedProvider = Provider & { credentialFields?: CredentialField[] }

export interface ProviderCreationData {
  id?: string
  name: string
  type?: 'builtin' | 'custom'
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers?: Record<string, string>
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
  credentialFields?: CredentialField[]
}

/**
 * Build a Provider object. Explicit data wins; built-in configuration fills
 * the gaps for built-in provider ids.
 */
export function createProviderFromData(data: ProviderCreationData, id: string, now: number): PersistedProvider {
  const builtinConfig = data.id ? builtinProviderMap[data.id] : undefined

  return {
    id,
    name: data.name,
    type: data.type || (builtinConfig ? 'builtin' : 'custom'),
    authType: data.authType,
    apiEndpoint: data.apiEndpoint,
    chatPath: data.chatPath ?? builtinConfig?.chatPath,
    headers: data.headers ?? builtinConfig?.headers ?? {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
    description: data.description ?? builtinConfig?.description,
    icon: data.icon ?? builtinConfig?.icon,
    supportedModels: data.supportedModels ?? builtinConfig?.supportedModels,
    modelMappings: data.modelMappings ?? builtinConfig?.modelMappings,
    credentialFields: data.credentialFields ?? builtinConfig?.credentialFields,
  }
}
