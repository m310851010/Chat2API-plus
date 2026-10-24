/**
 * Gemini Web Stream Response Handler
 * Parses gemini.google.com StreamGenerate reply into OpenAI-compatible chunks.
 *
 * The upstream sends cumulative text snapshots (each newer string extends the
 * previous one), so deltas are computed by diffing against the accumulated text.
 * Internal "code reference" artifacts emitted by Gemini's code-execution tools
 * are filtered out.
 */

import { PassThrough } from 'stream'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../toolCalling/types.ts'

const ARTIFACT_PATTERN = /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g

function cleanGeminiText(text: string): string {
  return text.replace(ARTIFACT_PATTERN, '')
}

function createBaseChunk(id: string, model: string, created: number) {
  return {
    id,
    model,
    object: 'chat.completion.chunk',
    created,
  }
}

export class GeminiStreamHandler {
  private model: string
  private sessionId: string
  private isFirstChunk: boolean = true
  private created: number
  private onEnd?: () => void
  private toolStreamParser?: ToolStreamParser
  private plan?: ToolCallingPlan

  // Normalized state for text processing
  private buffer: string = ''
  private rawAccumulated: string = ''
  private lastEmittedLength: number = 0

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
    delta: { role?: string; content?: string; tool_calls?: any[] },
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
      console.error('[Gemini Stream] Stream error:', err)
      transStream.emit('error', err instanceof Error ? err : new Error(String(err)))
    })

    return transStream
  }

  private processLine(line: string, transStream: PassThrough): void {
    if (!line || !line.includes('"wrb.fr"') || line.length < 200) return

    // Upstream rejections surface as inline error markers
    const errMatch = line.match(/BardErrorInfo\s*\[(\d+)\]/)
    if (errMatch) {
      transStream.emit(
        'error',
        new Error(`Gemini upstream rejected the request: BardErrorInfo [${errMatch[1]}]`),
      )
      return
    }

    let arr: any
    try {
      arr = JSON.parse(line)
    } catch {
      return
    }

    try {
      const innerStr = arr?.[0]?.[2]
      if (typeof innerStr !== 'string' || innerStr.length < 50) return
      const inner = JSON.parse(innerStr)
      if (!Array.isArray(inner) || !inner[4]) return

      for (const part of inner[4]) {
        if (!Array.isArray(part) || !Array.isArray(part[1])) continue

        for (const text of part[1]) {
          if (typeof text !== 'string' || !text) continue
          // Keep the longest snapshot seen so far
          if (text.length > this.rawAccumulated.length) {
            this.rawAccumulated = text
          }
        }
      }

      this.emitNewContent(transStream)
    } catch (error) {
      console.debug('[Gemini Stream] Failed to parse line:', error)
    }
  }

  /**
   * Diff the cleaned accumulated text against what has been emitted so far
   * and forward any new content through the tool-call stream parser.
   */
  private emitNewContent(transStream: PassThrough): void {
    const cleaned = cleanGeminiText(this.rawAccumulated)
    const pending = cleaned.slice(this.lastEmittedLength)
    if (!pending) return

    const baseChunk = createBaseChunk(this.sessionId, this.model, this.created)
    let includeRole = this.isFirstChunk
    this.isFirstChunk = false

    if (this.toolStreamParser) {
      const chunks = this.toolStreamParser.push(pending, baseChunk, includeRole)
      includeRole = false
      for (const chunk of chunks) {
        transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
    } else {
      transStream.write(this.createChunk({ ...(includeRole ? { role: 'assistant' } : {}), content: pending }))
    }

    this.lastEmittedLength = cleaned.length
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
          this.processLineNonStream(line)
        }
      })

      stream.on('end', () => {
        if (this.buffer.trim()) {
          this.processLineNonStream(this.buffer.trimEnd())
          this.buffer = ''
        }

        const text = cleanGeminiText(this.rawAccumulated).trim()

        const message: any = {
          role: 'assistant',
          content: text || null,
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
            completion_tokens: Math.max(1, Math.floor(text.length / 4)),
            total_tokens: Math.max(2, Math.floor(text.length / 4) + 1),
          },
          created: this.created,
        })
      })

      stream.on('error', (err) => {
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  private processLineNonStream(line: string): void {
    if (!line || !line.includes('"wrb.fr"') || line.length < 200) return

    let arr: any
    try {
      arr = JSON.parse(line)
    } catch {
      return
    }

    try {
      const innerStr = arr?.[0]?.[2]
      if (typeof innerStr !== 'string' || innerStr.length < 50) return
      const inner = JSON.parse(innerStr)
      if (!Array.isArray(inner) || !inner[4]) return

      for (const part of inner[4]) {
        if (!Array.isArray(part) || !Array.isArray(part[1])) continue
        for (const text of part[1]) {
          if (typeof text === 'string' && text.length > this.rawAccumulated.length) {
            this.rawAccumulated = text
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }
}
