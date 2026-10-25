import chatgptConfig from './chatgpt.ts'
import deepseekConfig from './deepseek.ts'
import doubaoConfig from './doubao.ts'
import geminiConfig from './gemini.ts'
import glmConfig from './glm.ts'
import grokConfig from './grok.ts'
import kimiConfig from './kimi.ts'
import minimaxConfig from './minimax.ts'
import mimoConfig from './mimo.ts'
import perplexityConfig from './perplexity.ts'
import qwenConfig from './qwen.ts'
import qwenAiConfig from './qwen-ai.ts'
import zaiConfig from './zai.ts'
import type { BuiltinProviderConfig } from '../../store/types.ts'

export const builtinProviders: BuiltinProviderConfig[] = [
  chatgptConfig,
  deepseekConfig,
  doubaoConfig,
  geminiConfig,
  glmConfig,
  grokConfig,
  kimiConfig,
  minimaxConfig,
  mimoConfig,
  perplexityConfig,
  qwenConfig,
  qwenAiConfig,
  zaiConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = {
  chatgpt: chatgptConfig,
  deepseek: deepseekConfig,
  doubao: doubaoConfig,
  gemini: geminiConfig,
  glm: glmConfig,
  grok: grokConfig,
  kimi: kimiConfig,
  minimax: minimaxConfig,
  mimo: mimoConfig,
  perplexity: perplexityConfig,
  qwen: qwenConfig,
  'qwen-ai': qwenAiConfig,
  zai: zaiConfig,
}

export function getBuiltinProvider(id: string): BuiltinProviderConfig | undefined {
  return builtinProviderMap[id]
}

export function getBuiltinProviders(): BuiltinProviderConfig[] {
  return builtinProviders
}

export {
  chatgptConfig,
  deepseekConfig,
  doubaoConfig,
  geminiConfig,
  glmConfig,
  grokConfig,
  kimiConfig,
  minimaxConfig,
  mimoConfig,
  perplexityConfig,
  qwenConfig,
  qwenAiConfig,
  zaiConfig,
}

export default builtinProviders
