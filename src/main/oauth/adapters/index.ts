/**
 * OAuth Adapter Index
 * Export all provider authentication adapters
 */

export { BaseOAuthAdapter } from './base'
export { ChatGPTAuthAdapter } from './chatgpt'
export { DeepSeekAdapter } from './deepseek'
export { GeminiAdapter } from './gemini'
export { GLMAdapter } from './glm'
export { GrokAdapter } from './grok'
export { KimiAdapter } from './kimi'
export { MimoAdapter } from './mimo'
export { MiniMaxAdapter } from './minimax'
export { PerplexityAdapter } from './perplexity'
export { QwenAdapter } from './qwen'
export { QwenAiAdapter } from './qwen-ai'
export { ZaiAdapter } from './zai'
import { BaseOAuthAdapter } from './base'
import { ChatGPTAuthAdapter } from './chatgpt'
import { DeepSeekAdapter } from './deepseek'
import { GeminiAdapter } from './gemini'
import { GLMAdapter } from './glm'
import { GrokAdapter } from './grok'
import { KimiAdapter } from './kimi'
import { MimoAdapter } from './mimo'
import { MiniMaxAdapter } from './minimax'
import { PerplexityAdapter } from './perplexity'
import { QwenAdapter } from './qwen'
import { QwenAiAdapter } from './qwen-ai'
import { ZaiAdapter } from './zai'
import { ProviderType, AdapterConfig } from '../types'

/**
 * Adapter factory function
 */
export function createAdapter(
  providerType: ProviderType,
  config: AdapterConfig
): BaseOAuthAdapter {
  switch (providerType) {
    case 'chatgpt':
      return new ChatGPTAuthAdapter(config)
    case 'deepseek':
      return new DeepSeekAdapter(config)
    case 'gemini':
      return new GeminiAdapter(config)
    case 'glm':
      return new GLMAdapter(config)
    case 'grok':
      return new GrokAdapter(config)
    case 'kimi':
      return new KimiAdapter(config)
    case 'mimo':
      return new MimoAdapter(config)
    case 'minimax':
      return new MiniMaxAdapter(config)
    case 'perplexity':
      return new PerplexityAdapter(config)
    case 'qwen':
      return new QwenAdapter(config)
    case 'qwen-ai':
      return new QwenAiAdapter(config)
    case 'zai':
      return new ZaiAdapter(config)
    default:
      throw new Error(`Unsupported provider type: ${providerType}`)
  }
}

/**
 * Get supported authentication methods for provider
 */
export function getSupportedAuthMethods(providerType: ProviderType): string[] {
  switch (providerType) {
    case 'chatgpt':
      return ['manual']
    case 'deepseek':
      return ['manual']
    case 'gemini':
      return ['manual', 'cookie']
    case 'glm':
      return ['manual']
    case 'grok':
      return ['manual', 'cookie']
    case 'kimi':
      return ['manual']
    case 'mimo':
      return ['manual', 'cookie']
    case 'minimax':
      return ['manual']
    case 'perplexity':
      return ['manual', 'cookie']
    case 'qwen':
      return ['manual', 'cookie']
    case 'qwen-ai':
      return ['manual']
    case 'zai':
      return ['manual']
    default:
      return ['manual']
  }
}
