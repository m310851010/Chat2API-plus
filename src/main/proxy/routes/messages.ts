import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import { ChatCompletionRequest, ChatMessage, ProxyContext } from '../types'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'
import {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  buildAnthropicResponse,
  convertMessages,
  convertToolChoice,
  convertTools,
  contentToText,
  extractUserInputText,
  generateMessageId,
  generateRequestId,
  mapStopReason,
} from './anthropicConvert'

const router = new Router({ prefix: '/v1' })

/**
 * Translate an OpenAI SSE stream into Anthropic messages SSE events.
 */
function createAnthropicStreamTransformer(source: any, model: string, messageId: string): PassThrough {
  const out = new PassThrough()
  let buffer = ''

  let blockIndex = -1
  let currentBlock: 'text' | 'tool' | null = null
  let stopReason = 'end_turn'
  let sawToolUse = false

  const writeEvent = (event: string, data: any) => {
    out.write(`event: ${event}\n`)
    out.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  const closeBlock = () => {
    if (currentBlock) {
      writeEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
      currentBlock = null
    }
  }

  const openTextBlock = () => {
    blockIndex += 1
    currentBlock = 'text'
    writeEvent('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    })
  }

  const start = () => {
    writeEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  const finish = () => {
    closeBlock()
    writeEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    })
    writeEvent('message_stop', { type: 'message_stop' })
  }

  start()

  source.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue

      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') {
        if (payload === '[DONE]') {
          finish()
          out.end()
        }
        continue
      }

      let parsed: any
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }

      const choice = parsed?.choices?.[0]
      if (!choice) continue

      const delta = choice.delta || {}

      if (delta.content) {
        if (currentBlock !== 'text') {
          closeBlock()
          openTextBlock()
        }
        writeEvent('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: delta.content },
        })
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const isNew = currentBlock !== 'tool'
          if (isNew) {
            closeBlock()
            blockIndex += 1
            currentBlock = 'tool'
            sawToolUse = true
            writeEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: call.id,
                name: call.function?.name || '',
                input: {},
              },
            })
          }

          if (call.function?.arguments) {
            writeEvent('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: call.function.arguments },
            })
          }
        }
      }

      if (choice.finish_reason) {
        stopReason = mapStopReason(choice.finish_reason, sawToolUse)
      }
    }
  })

  source.once('error', (err: Error) => {
    console.error('[Messages] Upstream stream error:', err.message)
    if (currentBlock === 'text') {
      writeEvent('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: `\n\n[Error: ${err.message}]` },
      })
    }
    stopReason = stopReason || 'end_turn'
    finish()
    out.end()
  })

  source.once('end', () => {
    finish()
    out.end()
  })

  return out
}

/**
 * Handle Anthropic Messages Request
 */
router.post('/messages', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const messageId = generateMessageId()
  const body = ctx.request.body as AnthropicRequest

  if (!body?.model) {
    ctx.status = 400
    ctx.body = {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Missing required field: model' },
    }
    return
  }

  if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    ctx.status = 400
    ctx.body = {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Missing required field: messages' },
    }
    return
  }

  const systemText = contentToText(body.system)
  const messages: ChatMessage[] = []

  if (systemText) {
    messages.push({ role: 'system', content: systemText })
  }

  messages.push(...convertMessages(body.messages))

  const request: ChatCompletionRequest = {
    model: body.model,
    messages,
    tools: convertTools(body.tools) as any,
    tool_choice: convertToolChoice(body.tool_choice) as any,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    stream: body.stream === true,
  }

  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(request.model)
  const preferredAccountId = modelMapper.getPreferredAccount(request.model)

  const selection = loadBalancer.selectAccount(
    request.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    ctx.status = 503
    ctx.body = {
      type: 'error',
      error: {
        type: 'api_error',
        message: `No available account for model: ${request.model}`,
      },
    }
    return
  }

  const { account, provider, actualModel } = selection

  const context: ProxyContext = {
    requestId,
    providerId: provider.id,
    accountId: account.id,
    model: request.model,
    actualModel,
    startTime,
    isStream: request.stream || false,
    clientIP: ctx.ip || 'unknown',
  }

  proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)

  const userInput = extractUserInputText(messages)
  const requestBodyForLog = JSON.stringify(request)

  const baseLogFields = {
    timestamp: startTime,
    method: 'POST',
    url: '/v1/messages',
    model: request.model,
    actualModel,
    providerId: provider.id,
    providerName: provider.name,
    accountId: account.id,
    accountName: account.name,
    requestBody: requestBodyForLog,
    userInput,
    isStream: request.stream || false,
  }

  try {
    const result = await requestForwarder.forwardChatCompletion(
      request,
      account,
      provider,
      actualModel,
      context
    )

    const latency = Date.now() - startTime

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)
      if (result.status && result.status >= 400 && result.status !== 429) {
        loadBalancer.markAccountFailed(account.id)
      }

      ctx.status = result.status || 500
      ctx.body = {
        type: 'error',
        error: { type: 'api_error', message: result.error || 'Request failed' },
      }

      storeManager.addRequestLog({
        ...baseLogFields,
        status: 'error',
        statusCode: result.status || 500,
        responseStatus: result.status || 500,
        responseBody: JSON.stringify(ctx.body),
        errorMessage: result.error,
        latency,
      })

      storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)
      return
    }

    loadBalancer.clearAccountFailure(account.id)
    proxyStatusManager.recordRequestSuccess(latency)

    storeManager.updateAccount(account.id, {
      lastUsed: Date.now(),
      requestCount: (account.requestCount || 0) + 1,
      todayUsed: (account.todayUsed || 0) + 1,
    })

    storeManager.recordRequestInStats(true, latency, request.model, provider.id, account.id)

    if (request.stream === true && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      const upstream = createAnthropicStreamTransformer(result.stream, request.model, messageId)

      // 流结束前先建一条日志，结束后回填收集到的 SSE 原文
      const logEntry = storeManager.addRequestLog({
        ...baseLogFields,
        status: 'success',
        statusCode: 200,
        responseStatus: 200,
        latency,
      })

      let collected = ''
      upstream.on('data', (chunk: Buffer) => {
        collected += chunk.toString()
      })
      upstream.once('end', () => {
        storeManager.updateRequestLog(logEntry.id, {
          responseBody: collected || undefined,
        })
      })

      ctx.body = upstream
      return
    }

    const responseBody = buildAnthropicResponse(result.body, request.model, messageId)

    ctx.set('Content-Type', 'application/json')
    ctx.body = responseBody

    storeManager.addRequestLog({
      ...baseLogFields,
      status: 'success',
      statusCode: 200,
      responseStatus: 200,
      responseBody: JSON.stringify(responseBody),
      latency,
    })
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    ctx.status = 500
    ctx.body = {
      type: 'error',
      error: { type: 'api_error', message: errorMessage },
    }

    storeManager.addRequestLog({
      ...baseLogFields,
      status: 'error',
      statusCode: 500,
      responseStatus: 500,
      responseBody: JSON.stringify(ctx.body),
      errorMessage,
      latency,
    })
  }
})

export default router
