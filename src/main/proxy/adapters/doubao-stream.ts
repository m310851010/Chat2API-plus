/**
 * Doubao Web Stream Response Handler
 * Parses www.doubao.com /samantha/chat/completion SSE events into
 * OpenAI-compatible chunks.
 *
 * Event types observed on the wire (inside `data:` lines):
 * - 2001 (CMPL): message chunks; event_data.message.content is a JSON string
 *   with { text } — the answer text
 * - 2002 (conversation created / suggestions): event_data.conversation_id
 *   identifies the new thread
 * - 2003 (FIN): end of stream (full-text snapshot; not emitted to avoid dupes)
 * - 2005: upstream ERR event
 * - 2008: deep-think chunks carry { think } and/or { text }
 * - 10040: block thinking markers carrying { think }
 */

import { PassThrough } from 'stream'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../toolCalling/types.ts'

function createBaseChunk(id: string, model: string, created: number) {
  return {
    id,
    model,
    object: 'chat.completion.chunk',
    created,
  }
}

function parseJsonSafe(value: any): any {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

/**
 * Doubao pushes UI loading/status cards (content_type 2003 SamanthaLoading
 * "深度思考中", thinking-block finish titles "已完成思考") as plain text.
 * These are status labels, not answer content — they must never reach the
 * client stream as text.
 */
const THINKING_STATUS_LABELS = new Set(['深度思考中', '已完成思考', '思考中', '正在深度思考中'])

function isThinkingStatusLabel(text: string): boolean {
  return THINKING_STATUS_LABELS.has(text.trim())
}

export class DoubaoStreamHandler {
  private model: string
  private sessionId: string
  private isFirstChunk: boolean = true
  private created: number
  private onEnd?: () => void
  private onConversationId?: (conversationId: string) => void
  private toolStreamParser?: ToolStreamParser
  private plan?: ToolCallingPlan

  private buffer: string = ''

  constructor(
    model: string,
    sessionId: string,
    onEnd?: () => void,
    plan?: ToolCallingPlan,
    onConversationId?: (conversationId: string) => void
  ) {
    this.model = model
    this.sessionId = sessionId
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.plan = plan
    this.toolStreamParser = plan?.shouldParseResponse ? new ToolStreamParser(plan) : undefined
    this.onConversationId = onConversationId
  }

  private createChunk(
    delta: { role?: string; content?: string; reasoning_content?: string; tool_calls?: any[] },
    finishReason?: string
  ): string {
    return `data: ${JSON.stringify({
      id: this.sessionId,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason || null,
      }],
      created: this.created,
    })}\n\n`
  }

  async handleStream(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    const transStream = new PassThrough()
    let doneCalled = false

    stream.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      let newlineIdx: number

      while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trimEnd()
        this.buffer = this.buffer.slice(newlineIdx + 1)
        this.processLine(line, transStream)
      }
    })

    stream.on('end', () => {
      if (this.buffer.trim()) {
        this.processLine(this.buffer.trimEnd(), transStream)
        this.buffer = ''
      }
      if (!doneCalled) {
        doneCalled = true
        this.handleDone(transStream)
      }
    })

    stream.on('error', (err) => {
      console.error('[Doubao Stream] Stream error:', err)
      transStream.emit('error', err instanceof Error ? err : new Error(String(err)))
    })

    return transStream
  }

  private processLine(line: string, transStream: PassThrough): void {
    if (!line) return
    if (!line.startsWith('data:')) return

    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return

    let data: any
    try {
      data = JSON.parse(payload)
    } catch {
      return
    }

    // A JSON error body instead of SSE events means the session is
    // expired or risk control intercepted the request
    if (data && typeof data.code !== 'undefined' && typeof data.message !== 'undefined' && !data.event_type) {
      transStream.emit(
        'error',
        new Error(`Doubao upstream error ${data.code}: ${data.message}`),
      )
      return
    }

    // /chat/completion compact format: data lines carry {"text": "..."}
    // deltas directly (risk errors carry error_code and are skipped)
    if (typeof data.text === 'string' && data.error_code === undefined) {
      this.emitText(data.text, transStream)
      return
    }

    const eventType = Number(data.event_type || 0)
    const eventData = parseJsonSafe(data.event_data)

    if (eventType === 2002) {
      const conversationId = eventData?.conversation_id
      if (conversationId && this.onConversationId) {
        this.onConversationId(String(conversationId))
      }
      return
    }

    // 2005 is an upstream ERR event; 2003 (FIN) terminates the stream and
    // carries a full-text snapshot that must NOT be emitted again
    if (eventType === 2005) {
      const errData = parseJsonSafe(data.event_data)
      const errCode = errData?.code || errData?.error_detail?.code
      const RISK_CODES = [710022002, 710022004, '710022002', '710022004']
      if (errCode !== undefined && RISK_CODES.includes(errCode as any)) {
        transStream.emit(
          'error',
          new Error(
            `Doubao risk control blocked the request (code ${errCode}). 豆包风控拦截，请完成滑块验证后重新发送。`,
          ),
        )
        return
      }
      transStream.emit(
        'error',
        new Error(`Doubao upstream ERR event: ${String(data.event_data || '').slice(0, 300)}`),
      )
      return
    }

    if (eventType !== 2001 && eventType !== 2008 && eventType !== 10040) {
      return
    }

    const message = parseJsonSafe(eventData?.message)
    if (!message || typeof message !== 'object') return

    // Skip the user echo (reply_id "0" marks the mirrored user message)
    if (message.reply_id === '0' || message.reply_id === 0) return

    const contentType = Number(message.content_type || 0)
    const content = parseJsonSafe(message.content)
    const text = typeof content?.text === 'string' ? content.text : ''
    const think = typeof content?.think === 'string' ? content.think : ''

    // content_type 2003 (SamanthaLoading) is a UI loading card ("深度思考中")
    if (eventType === 2001 && contentType === 2003) return

    if (eventType === 2008 || contentType === 2008) {
      if (think) this.emitReasoning(think, transStream)
      if (text) this.emitText(text, transStream)
      return
    }

    if (eventType === 10040 || contentType === 10040) {
      const finishTitle = typeof content?.finish_title === 'string' ? content.finish_title : ''
      const thinkText = think || (isThinkingStatusLabel(finishTitle) ? '' : finishTitle)
      if (thinkText) this.emitReasoning(thinkText, transStream)
      return
    }

    // 2001 / 2003: answer text; 2003 (FIN) also carries the final full text
    if (text) this.emitText(text, transStream)
  }

  private emitText(text: string, transStream: PassThrough): void {
    if (isThinkingStatusLabel(text)) return
    const baseChunk = createBaseChunk(this.sessionId, this.model, this.created)
    let includeRole = this.isFirstChunk
    this.isFirstChunk = false

    if (this.toolStreamParser) {
      const chunks = this.toolStreamParser.push(text, baseChunk, includeRole)
      for (const chunk of chunks) {
        transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
    } else {
      transStream.write(this.createChunk({ ...(includeRole ? { role: 'assistant' } : {}), content: text }))
    }
  }

  private emitReasoning(text: string, transStream: PassThrough): void {
    if (this.isFirstChunk) {
      transStream.write(this.createChunk({ role: 'assistant' }))
      this.isFirstChunk = false
    }
    transStream.write(this.createChunk({ reasoning_content: text }))
  }

  private handleDone(transStream: PassThrough): void {
    const baseChunk = createBaseChunk(this.sessionId, this.model, this.created)

    if (this.toolStreamParser) {
      const flushChunks = this.toolStreamParser.flush(baseChunk)
      for (const chunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
    }

    if (this.isFirstChunk) {
      transStream.write(this.createChunk({ role: 'assistant' }))
      this.isFirstChunk = false
    }

    const finishReason = this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop'
    transStream.write(this.createChunk({}, finishReason))
    transStream.write('data: [DONE]\n\n')
    transStream.end()

    this.onEnd?.()
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<any> {
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString()
        let newlineIdx: number

        while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, newlineIdx).trimEnd()
          this.buffer = this.buffer.slice(newlineIdx + 1)
          try {
            this.processLineNonStream(line)
          } catch {
            // ignore parse errors in non-stream mode
          }
        }
      })

      stream.on('end', () => {
        if (this.buffer.trim()) {
          this.processLineNonStream(this.buffer.trimEnd())
          this.buffer = ''
        }

        const result = {
          id: this.sessionId,
          model: this.model,
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: this.answerText || null,
              ...(this.thinkingText ? { reasoning_content: this.thinkingText } : {}),
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: Math.max(1, Math.floor(this.answerText.length / 4)),
            total_tokens: Math.max(2, Math.floor(this.answerText.length / 4) + 1),
          },
          created: this.created,
        }
        resolve(result)
      })

      stream.on('error', (err) => {
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  private answerText: string = ''
  private thinkingText: string = ''

  private processLineNonStream(line: string): void {
    if (!line) return
    if (!line.startsWith('data:')) return

    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return

    let data: any
    try {
      data = JSON.parse(payload)
    } catch {
      return
    }

    const eventType = Number(data.event_type || 0)
    const eventData = parseJsonSafe(data.event_data)

    if (eventType !== 2001 && eventType !== 2008 && eventType !== 10040) {
      return
    }

    const message = parseJsonSafe(eventData?.message)
    if (!message || typeof message !== 'object') return
    if (message.reply_id === '0' || message.reply_id === 0) return

    const contentType = Number(message.content_type || 0)
    const content = parseJsonSafe(message.content)

    if (eventType === 2001 && contentType === 2003) return

    if (eventType === 2008 || contentType === 2008) {
      if (content?.think) this.thinkingText += content.think
      if (content?.text && !isThinkingStatusLabel(content.text)) this.answerText += content.text
      return
    }
    if (eventType === 10040 || contentType === 10040) {
      const finishTitle = typeof content?.finish_title === 'string' ? content.finish_title : ''
      const thinkText = content?.think || (isThinkingStatusLabel(finishTitle) ? '' : finishTitle)
      if (thinkText) this.thinkingText += thinkText
      return
    }
    if (content?.text && !isThinkingStatusLabel(content.text)) this.answerText += content.text
  }
}
