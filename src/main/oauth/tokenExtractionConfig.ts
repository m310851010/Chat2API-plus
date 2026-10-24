/**
 * Token Extraction Configuration
 * Defines how to extract tokens from different providers
 */

import { ProviderType } from './types'

export type TokenSourceType = 'networkHeader' | 'localStorage' | 'cookie'

export interface TokenSource {
  type: TokenSourceType
  key: string
  urlPattern?: string
  extractPattern?: string
}

export interface TokenExtractionConfig {
  loginUrl: string
  tokenSources: TokenSource[]
  targetDomains: string[]
  successUrlPatterns?: RegExp[]
  windowTitle?: string
}

export const TOKEN_EXTRACTION_CONFIGS: Record<ProviderType, TokenExtractionConfig> = {
  chatgpt: {
    loginUrl: 'https://chatgpt.com/api/auth/session',
    tokenSources: [
      {
        type: 'networkHeader',
        key: 'authorization',
        urlPattern: '*://*.chatgpt.com/backend-api/*',
        extractPattern: '^Bearer\\s+(.+)$',
      },
    ],
    targetDomains: ['.chatgpt.com', 'chatgpt.com'],
    successUrlPatterns: [/chatgpt\.com/i],
    windowTitle: 'ChatGPT Login',
  },

  kimi: {
    loginUrl: 'https://www.kimi.com',
    tokenSources: [
      {
        type: 'networkHeader',
        key: 'token',
        urlPattern: '*://*.kimi.com/*',
        extractPattern: '^Bearer\\s+(.+)$',
      },
    ],
    targetDomains: ['.kimi.com', 'kimi.com'],
    successUrlPatterns: [/kimi\.com/i],
    windowTitle: 'Kimi Login',
  },

  deepseek: {
    loginUrl: 'https://chat.deepseek.com',
    tokenSources: [
      {
        type: 'localStorage',
        key: 'userToken',
      },
    ],
    targetDomains: ['.deepseek.com', 'deepseek.com'],
    successUrlPatterns: [/chat\.deepseek\.com/i],
    windowTitle: 'DeepSeek Login',
  },

  glm: {
    loginUrl: 'https://chatglm.cn',
    tokenSources: [
      {
        type: 'cookie',
        key: 'chatglm_refresh_token',
      },
    ],
    targetDomains: ['.chatglm.cn', 'chatglm.cn'],
    successUrlPatterns: [/chatglm\.cn/i],
    windowTitle: 'GLM Login',
  },

  qwen: {
    loginUrl: 'https://www.qianwen.com',
    tokenSources: [
      {
        type: 'cookie',
        key: 'tongyi_sso_ticket',
      },
    ],
    targetDomains: ['.qianwen.com', 'qianwen.com'],
    successUrlPatterns: [/qianwen\.com/i],
    windowTitle: 'Qwen Login',
  },

  minimax: {
    loginUrl: 'https://agent.minimaxi.com',
    tokenSources: [
      {
        type: 'localStorage',
        key: '_token',
      },
      {
        type: 'localStorage',
        key: 'user_detail_agent',
      },
    ],
    targetDomains: ['.minimaxi.com', 'minimaxi.com'],
    successUrlPatterns: [/agent\.minimaxi\.com/i],
    windowTitle: 'MiniMax Login',
  },

  zai: {
    loginUrl: 'https://chat.z.ai',
    tokenSources: [
      {
        type: 'localStorage',
        key: 'token',
      },
      {
        type: 'cookie',
        key: 'token',
      },
    ],
    targetDomains: ['.z.ai', 'z.ai', 'chat.z.ai'],
    successUrlPatterns: [/chat\.z\.ai/i, /z\.ai/i],
    windowTitle: 'Z.ai Login',
  },
  mimo: {
    loginUrl: 'https://aistudio.xiaomimimo.com',
    tokenSources: [
      {
        type: 'cookie',
        key: 'serviceToken',
      },
      {
        type: 'cookie',
        key: 'userId',
      },
      {
        type: 'cookie',
        key: 'xiaomichatbot_ph',
      },
    ],
    targetDomains: ['.xiaomimimo.com', 'xiaomimimo.com'],
    successUrlPatterns: [/aistudio\.xiaomimimo\.com/i],
    windowTitle: 'Mimo AI Studio Login',
  },
  'qwen-ai': {
    loginUrl: 'https://chat.qwen.ai',
    tokenSources: [
      {
        type: 'localStorage',
        key: 'token',
      },
      {
        type: 'cookie',
        key: 'token',
      },
    ],
    targetDomains: ['.qwen.ai', 'qwen.ai', 'chat.qwen.ai'],
    successUrlPatterns: [/chat\.qwen\.ai/i, /qwen\.ai/i],
    windowTitle: 'Qwen AI Login',
  },
  perplexity: {
    loginUrl: 'https://www.perplexity.ai',
    tokenSources: [
      {
        type: 'cookie',
        key: '__Secure-next-auth.session-token',
      },
      {
        type: 'cookie',
        key: 'next-auth.session-token',
      },
    ],
    targetDomains: ['.perplexity.ai', 'perplexity.ai'],
    successUrlPatterns: [/perplexity\.ai/i],
    windowTitle: 'Perplexity Login - Please click Sign In to login',
  },

  gemini: {
    loginUrl: 'https://gemini.google.com/app',
    tokenSources: [
      {
        type: 'cookie',
        key: '__Secure-1PSID',
      },
      {
        type: 'cookie',
        key: 'SAPISID',
      },
    ],
    targetDomains: ['.google.com', 'google.com', 'accounts.google.com'],
    successUrlPatterns: [/gemini\.google\.com\/app/i, /accounts\.google\.com/i],
    windowTitle: 'Gemini Login',
  },

  grok: {
    loginUrl: 'https://grok.com',
    tokenSources: [
      {
        type: 'cookie',
        key: 'sso',
      },
      {
        type: 'cookie',
        key: 'sso-rw',
      },
    ],
    targetDomains: ['.grok.com', 'grok.com'],
    successUrlPatterns: [/grok\.com/i],
    windowTitle: 'Grok Login',
  },
}

export function getTokenExtractionConfig(providerType: ProviderType): TokenExtractionConfig | null {
  return TOKEN_EXTRACTION_CONFIGS[providerType] || null
}
