/**
 * Proxy Service Module - Anthropic Protocol Conversion Helpers
 * Pure functions converting between the Anthropic Messages schema and the
 * internal OpenAI ChatCompletion shape. Free of runtime dependencies (koa,
 * electron) so they can be unit-tested in isolation.
 */

import type { ChatMessage } from '../types'

export interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, any>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
}

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, any>
}

export interface AnthropicToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none'
  name?: string
}

export interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string | AnthropicContentBlock[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice | string
  metadata?: Record<string, any>
}

export function generateRequestId(): string {
  return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** 取最后一条用户消息作为日志里的「用户输入」摘要 */
export function extractUserInputText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user') {
      return typeof message.content === 'string' ? message.content : ''
    }
  }
  return ''
}

export function blockToText(block: AnthropicContentBlock): string {
  if (typeof block.text === 'string') return block.text
  if (Array.isArray(block.content)) return blocksToText(block.content)
  if (typeof block.content === 'string') return block.content
  return ''
}

export function blocksToText(blocks: AnthropicContentBlock[]): string {
  return blocks.map(blockToText).filter(Boolean).join('\n')
}

export function contentToText(content: string | AnthropicContentBlock[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return blocksToText(content)
}

/**
 * Convert Anthropic messages (including tool_use / tool_result blocks) into
 * OpenAI chat messages.
 */
export function convertMessages(messages: AnthropicMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []

  for (const message of messages) {
    const blocks: AnthropicContentBlock[] = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text', text: message.content } as AnthropicContentBlock]

    if (message.role === 'user') {
      const toolResults = blocks.filter((block) => block.type === 'tool_result')
      const textBlocks = blocks.filter((block) => block.type !== 'tool_result')

      for (const block of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || 'call_unknown',
          content: contentToText(block.content as string | AnthropicContentBlock[]),
        })
      }

      const text = textBlocks.map(blockToText).filter(Boolean).join('\n')
      if (text || toolResults.length === 0) {
        result.push({ role: 'user', content: text })
      }
      continue
    }

    // assistant
    const toolUses = blocks.filter((block) => block.type === 'tool_use')
    const text = blocks
      .filter((block) => block.type === 'text')
      .map(blockToText)
      .filter(Boolean)
      .join('\n')

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: text || null,
    }

    if (toolUses.length > 0) {
      assistantMessage.tool_calls = toolUses.map((block) => ({
        id: block.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function' as const,
        function: {
          name: block.name || '',
          arguments: JSON.stringify(block.input ?? {}),
        },
      }))
    }

    result.push(assistantMessage)
  }

  return result
}

export function convertTools(tools?: AnthropicTool[]) {
  if (!tools || tools.length === 0) return undefined

  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

export function convertToolChoice(toolChoice?: AnthropicRequest['tool_choice']) {
  if (!toolChoice) return undefined
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto') return 'auto' as const
    if (toolChoice === 'any' || toolChoice === 'tool') return 'required' as const
    if (toolChoice === 'none') return 'none' as const
    return 'auto' as const
  }

  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function' as const, function: { name: toolChoice.name } }
  }
  if (toolChoice.type === 'any') return 'required' as const
  if (toolChoice.type === 'none') return 'none' as const
  return 'auto' as const
}

export function mapStopReason(finishReason?: string, hasToolUse?: boolean): string {
  if (hasToolUse || finishReason === 'tool_calls') return 'tool_use'
  if (finishReason === 'length') return 'max_tokens'
  return 'end_turn'
}

export function buildAnthropicResponse(openaiBody: any, model: string, messageId: string) {
  const message = openaiBody?.choices?.[0]?.message || {}
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []

  const content: any[] = []
  if (message.content) {
    content.push({ type: 'text', text: message.content })
  }

  for (const call of toolCalls) {
    let input: Record<string, any> = {}
    try {
      input = JSON.parse(call.function?.arguments || '{}')
    } catch {
      input = {}
    }
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function?.name,
      input,
    })
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  const usage = openaiBody?.usage || {}
  const finishReason = openaiBody?.choices?.[0]?.finish_reason

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(finishReason, toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  }
}
