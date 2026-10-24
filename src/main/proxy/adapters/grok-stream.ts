/**
 * Grok Web Stream Response Handler
 * Parses grok.com NDJSON stream into OpenAI-compatible SSE chunks.
 *
 * Each NDJSON line looks like:
 * {"result":{"response":{"token":"...", "isThinking":false, "messageTag":"final", "isFinished":false}}}
 * Thinking tokens carry isThinking=true and are emitted as reasoning_content.
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

export class GrokStreamHandler {
  private model: string
  private sessionId: string
  private isFirstChunk: boolean = true
  private created: number
  private onEnd?: () => void
  private toolStreamParser?: ToolStreamParser
  private plan?: ToolCallingPlan

  private buffer: string = ''
  private accumulatedContent: string = ''
  private accumulatedReasoning: string = ''

  constructor(
    model: string,
    sessionId: string,
    onEnd?: () => void,
    plan?: ToolCallingPlan
  ) {
    this.model = model
    this.sessionId = sessionId
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.plan = plan
    this.toolStreamParser = plan?.shouldParseResponse ? new ToolStreamParser(plan) : undefined
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
        const line = this.buffer.slice(0, newlineIdx).trim()
        this.buffer = this.buffer.slice(newlineIdx + 1)
        if (!line) continue
        this.processNdjsonLine(line, transStream)
      }
    })

    stream.on('end', () => {
      if (this.buffer.trim()) {
        this.processNdjsonLine(this.buffer.trim(), transStream)
        this.buffer = ''
      }
      if (!doneCalled) {
        doneCalled = true
        this.handleDone(transStream)
      }
    })

    stream.on('error', (err) => {
      console.error('[Grok Stream] Stream error:', err)
      transStream.emit('error', err instanceof Error ? err : new Error(String(err)))
    })

    return transStream
  }

  private processNdjsonLine(line: string, transStream: PassThrough): void {
    if (!line.startsWith('{')) return

    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      return
    }

    // Top-level error payload
    if (obj.error) {
      const err = obj.error
      const msg = typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err)
      transStream.emit('error', new Error(`Grok upstream error: ${msg}`))
      return
    }

    const response = obj?.result?.response
    if (!response) return

    if (response.error) {
      const err = response.error
      const msg = typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err)
      transStream.emit('error', new Error(`Grok upstream error: ${msg}`))
      return
    }

    const token: string = response.token || ''
    const isThinking: boolean = Boolean(response.isThinking)
    const messageTag: string = response.messageTag || ''

    if (!token) return

    // Only emit "final" (or untagged) tokens; ignore alternative candidates
    if (!isThinking && messageTag !== 'final' && messageTag !== '') return

    if (isThinking) {
      this.accumulatedReasoning += token
      const delta: { role?: string; reasoning_content?: string } = {}
      if (this.isFirstChunk) {
        delta.role = 'assistant'
        this.isFirstChunk = false
      }
      delta.reasoning_content = token
      transStream.write(this.createChunk(delta))
      return
    }

    this.accumulatedContent += token

    const baseChunk = createBaseChunk(this.sessionId, this.model, this.created)
    const includeRole = this.isFirstChunk
    this.isFirstChunk = false

    if (this.toolStreamParser) {
      const chunks = this.toolStreamParser.push(token, baseChunk, includeRole)
      for (const chunk of chunks) {
        transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
    } else {
      transStream.write(this.createChunk({ ...(includeRole ? { role: 'assistant' } : {}), content: token }))
    }
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
          const line = this.buffer.slice(0, newlineIdx).trim()
          this.buffer = this.buffer.slice(newlineIdx + 1)
          if (!line) continue
          this.processNdjsonLineNonStream(line)
        }
      })

      stream.on('end', () => {
        if (this.buffer.trim()) {
          this.processNdjsonLineNonStream(this.buffer.trim())
          this.buffer = ''
        }

        const message: any = {
          role: 'assistant',
          content: this.accumulatedContent.trim() || null,
        }

        if (this.accumulatedReasoning.trim()) {
          message.reasoning_content = this.accumulatedReasoning.trim()
        }

        resolve({
          id: this.sessionId,
          model: this.model,
          object: 'chat.completion',
          choices: [{
            index: 0,
            message,
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: Math.max(1, Math.floor(this.accumulatedContent.length / 4)),
            total_tokens: Math.max(2, Math.floor(this.accumulatedContent.length / 4) + 1),
          },
          created: this.created,
        })
      })

      stream.on('error', (err) => {
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  private processNdjsonLineNonStream(line: string): void {
    if (!line.startsWith('{')) return

    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      return
    }

    if (obj.error || obj?.result?.response?.error) return

    const response = obj?.result?.response
    if (!response) return

    const token: string = response.token || ''
    const isThinking: boolean = Boolean(response.isThinking)
    const messageTag: string = response.messageTag || ''

    if (!token) return

    if (isThinking) {
      this.accumulatedReasoning += token
      return
    }

    if (messageTag !== 'final' && messageTag !== '') return

    this.accumulatedContent += token
  }
}
