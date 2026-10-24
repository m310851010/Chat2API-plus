/**
 * ChatGPT Stream Response Handler
 * Converts ChatGPT SSE stream (v1 full messages + v2 patches) to OpenAI compatible format
 */

import { PassThrough } from 'stream'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../toolCalling/types.ts'

interface ChatMessageNode {
  id?: string
  author?: { role?: string }
  recipient?: string
  content?: {
    content_type?: string
    parts?: any[]
    text?: string
  }
  metadata?: {
    is_visually_hidden_from_conversation?: boolean
    channel?: string
  }
}

interface StreamEvent {
  message?: ChatMessageNode
  conversation_id?: string
  error?: any
  p?: string
  o?: string
  v?: any
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isPrivateAnnotation(value: string): boolean {
  const lower = value.trim().toLowerCase()
  if (!lower) return true
  return /^turn\d+[a-z]*\d*$/.test(lower) || /^turn\d+\w*$/.test(lower)
    || lower.startsWith('turn') || lower.startsWith('source') || lower.startsWith('sources')
}

function readableAnnotationPart(parts: string[]): string {
  for (const part of parts) {
    const value = part.trim()
    if (value && !isPrivateAnnotation(value)) return value
  }
  return ''
}

function annotationText(payload: string): string {
  const parts = payload.split('\uE202').map(p => p.trim())
  const kind = parts[0]?.toLowerCase() || ''
  const data = parts.slice(1)
  if (kind === 'url') {
    const label = data[0] || ''
    const url = data[1] || ''
    if (label && /^https?:\/\//i.test(url)) return `${label} (${url})`
    return label || url
  }
  if (kind === 'cite') return readableAnnotationPart(data)
  return readableAnnotationPart(data)
}

/** Convert private-use citation markers into readable text (best effort). */
export function sanitizeOutputText(text: string): string {
  return text
    .replace(/(\s*)\uE200([^\uE201]*)\uE201(?=[.,;:!?])/g, (_m, leading: string, payload: string) => {
      const replacement = annotationText(payload)
      return replacement ? `${leading}${replacement}` : ''
    })
    .replace(/\uE200([^\uE201]*)\uE201/g, (_m, payload: string) => annotationText(payload))
    .replace(/\uE200[^\uE201]*$/g, '')
}

function isVisibleAssistantMessage(message: ChatMessageNode): boolean {
  const role = String(message.author?.role || '').trim().toLowerCase()
  if (role !== 'assistant') return false
  if (message.metadata?.is_visually_hidden_from_conversation === true) return false
  const recipient = String(message.recipient || '').trim().toLowerCase()
  if (recipient && recipient !== 'all') return false
  const channel = String(message.metadata?.channel || '').trim().toLowerCase()
  if (channel && channel !== 'final') return false
  return true
}

function assistantMessageText(message: ChatMessageNode): string {
  const content = message.content || {}
  const parts = content.parts || []
  if (Array.isArray(parts) && parts.length > 0) {
    const text = parts.filter((p: any) => typeof p === 'string').join('')
    if (text) return text
  }
  const textField = String(content.text || '')
  if (textField) return textField
  return ''
}

function applyPatchOp(operation: any, currentText: string): string {
  const op = operation?.o
  const value = String(operation?.v ?? '')
  if (op === 'append') return currentText + value
  if (op === 'replace') return value
  return currentText
}

function applyTextPatch(event: StreamEvent, currentText: string): string {
  if (event.p === '/message/content/parts/0') {
    return applyPatchOp(event, currentText)
  }

  const v = event.v
  if (typeof v === 'string' && currentText && !event.p && !event.o) {
    return currentText + v
  }

  let text = currentText
  if (event.o === 'patch' && Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === 'object') {
        text = applyTextPatch(item as StreamEvent, text)
      }
    }
    return text
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === 'object') {
        text = applyTextPatch(item as StreamEvent, text)
      }
    }
  }
  return text
}

function createBaseChunk(id: string, model: string, created: number) {
  return {
    id,
    model,
    object: 'chat.completion.chunk',
    created,
  }
}

export class ChatGPTStreamHandler {
  private model: string
  private sessionId: string
  private isFirstChunk: boolean = true
  private messageId: string = ''
  private conversationId: string = ''
  private created: number
  private onEnd?: () => void
  private toolCallingPlan?: ToolCallingPlan
  private toolStreamParser?: ToolStreamParser
  private isDone: boolean = false
  private currentText: string = ''

  constructor(
    model: string,
    sessionId: string,
    onEnd?: () => void,
    toolCallingPlan?: ToolCallingPlan
  ) {
    this.model = model
    this.sessionId = sessionId
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse
      ? new ToolStreamParser(toolCallingPlan)
      : undefined
  }

  getLastMessageId(): string {
    return this.messageId
  }

  getLastConversationId(): string {
    return this.conversationId
  }

  private createChunk(delta: { role?: string; content?: string; reasoning_content?: string }, finishReason?: string): string {
    return `data: ${JSON.stringify({
      ...createBaseChunk(`${this.sessionId}@${this.messageId}`, this.model, this.created),
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason || null,
      }],
    })}\n\n`
  }

  private nextDelta(nextRaw: string): string {
    const next = sanitizeOutputText(nextRaw)
    const prev = sanitizeOutputText(this.currentText)
    const delta = next.startsWith(prev) ? next.slice(prev.length) : next
    this.currentText = nextRaw
    return delta
  }

  private emitDelta(transStream: PassThrough, delta: string): void {
    if (!delta) return
    const outDelta: { role?: string; content?: string } = {}
    if (this.isFirstChunk) {
      outDelta.role = 'assistant'
    }
    outDelta.content = delta
    transStream.write(this.createChunk(outDelta))
    this.isFirstChunk = false
  }

  async handleStream(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    const transStream = new PassThrough()
    let buffer = ''

    stream.on('data', (chunk: Buffer) => {
      if (this.isDone) return
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue

        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          this.handleDone(transStream)
          return
        }

        let parsed: StreamEvent | null = null
        try {
          parsed = JSON.parse(data) as StreamEvent
        } catch {
          continue
        }
        if (!parsed) continue

        this.processChunk(parsed, transStream)
      }
    })

    stream.on('end', () => {
      this.handleDone(transStream)
    })

    stream.on('error', (err) => {
      transStream.emit('error', err)
    })

    return transStream
  }

  private processChunk(chunk: StreamEvent, transStream: PassThrough): void {
    if (chunk.error) {
      const message = typeof chunk.error === 'string'
        ? chunk.error
        : JSON.stringify(chunk.error)
      console.error('[ChatGPT] Stream error event:', message)
    }

    if (chunk.conversation_id) {
      this.conversationId = chunk.conversation_id
    }

    // v1 full message event
    const messageNode = chunk.message
    if (messageNode && isString(messageNode.id) && !this.messageId) {
      this.messageId = messageNode.id
    }

    if (messageNode) {
      if (!isVisibleAssistantMessage(messageNode)) return

      const rawText = assistantMessageText(messageNode)
      if (!rawText) return

      const delta = this.nextDelta(rawText)
      this.emitToolParsedDelta(transStream, delta)
      return
    }

    // v2 patch event
    const patchText = applyTextPatch(chunk, this.currentText)
    if (patchText === this.currentText) return
    const delta = this.nextDelta(patchText)
    this.emitToolParsedDelta(transStream, delta)
  }

  private emitToolParsedDelta(transStream: PassThrough, delta: string): void {
    if (!delta) return

    if (this.toolStreamParser) {
      const baseChunk = createBaseChunk(`${this.sessionId}@${this.messageId}`, this.model, this.created)
      const chunks = this.toolStreamParser.push(delta, baseChunk, this.isFirstChunk)
      for (const outChunk of chunks) {
        transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
        this.isFirstChunk = false
      }
      return
    }

    this.emitDelta(transStream, delta)
  }

  private handleDone(transStream: PassThrough): void {
    if (this.isDone) return
    this.isDone = true

    // Flush tool call buffer before finishing
    const baseChunk = createBaseChunk(`${this.sessionId}@${this.messageId}`, this.model, this.created)
    const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
    for (const outChunk of flushChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    // Determine finish_reason based on whether we had tool calls
    const finishReason = this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop'

    transStream.write(this.createChunk({}, finishReason))
    transStream.write('data: [DONE]\n\n')
    transStream.end()

    this.onEnd?.()
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<any> {
    let accumulatedContent = ''
    let messageId = ''

    return new Promise((resolve, reject) => {
      let buffer = ''

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue

          const data = line.slice(6).trim()
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data) as StreamEvent
            if (!parsed) continue

            if (parsed.conversation_id) {
              this.conversationId = parsed.conversation_id
            }

            const messageNode = parsed.message
            if (messageNode) {
              if (isString(messageNode.id)) {
                messageId = messageNode.id
                this.messageId = messageNode.id
              }
              if (!isVisibleAssistantMessage(messageNode)) continue
              const rawText = assistantMessageText(messageNode)
              if (rawText) {
                accumulatedContent = rawText
              }
              continue
            }

            if (parsed.p || parsed.o || typeof parsed.v !== 'undefined') {
              accumulatedContent = applyTextPatch(parsed, accumulatedContent)
            }
          } catch {
            // Ignore parse errors
          }
        }
      })

      stream.on('end', () => {
        const cleanContent = sanitizeOutputText(accumulatedContent).trim()
        const message: any = {
          role: 'assistant',
          content: cleanContent,
        }

        if (messageId) {
          this.messageId = messageId
        }

        resolve({
          id: `${this.sessionId}@${messageId}`,
          model: this.model,
          object: 'chat.completion',
          choices: [{
            index: 0,
            message,
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })
      })

      stream.on('error', reject)
    })
  }
}

export default ChatGPTStreamHandler
