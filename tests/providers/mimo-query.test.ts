import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  buildMimoQuery,
  getMimoServiceToken,
  MimoStreamHandler,
  parseCookieValue,
  resolveMimoThinkingOptions,
} from '../../src/main/proxy/adapters/mimo.ts'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'

test('Mimo parses cookie values from the full cookie string', () => {
  const cookie =
    'a=1; xiaomichatbot_serviceToken="v2:ST=="; userId=u_123; xiaomichatbot_ph="ph%2Ftoken"; trailing'

  assert.equal(parseCookieValue(cookie, 'xiaomichatbot_serviceToken'), 'v2:ST==')
  assert.equal(parseCookieValue(cookie, 'userId'), 'u_123')
  assert.equal(parseCookieValue(cookie, 'xiaomichatbot_ph'), 'ph%2Ftoken')
  assert.equal(parseCookieValue(cookie, 'missing'), '')
  assert.equal(getMimoServiceToken(cookie), 'v2:ST==')
  assert.equal(getMimoServiceToken('serviceToken=plain; xiaomichatbot_ph=x'), 'plain')
})

test('Mimo parses react/chat (v3) reasoningContent field and top-level usage', async () => {
  const upstreamLines = [
    'event: dialogId\n',
    'data: {"content":"32266954"}\n\n',
    'event: message\n',
    'data: {"messageType":"assistant","reasoningContent":"thinking hard"}\n\n',
    'event: message\n',
    'data: {"messageType":"assistant","content":"答案是 42"}\n\n',
    'event: usage\n',
    'data: {"promptTokens":10,"completionTokens":5,"totalTokens":15,"nativeUsage":{"completion_tokens_details":{"reasoning_tokens":3}}}\n\n',
    'event: finish\n',
    'data: {"content":"[DONE]"}\n\n',
  ]

  const streamHandler = new MimoStreamHandler('mimo-v2.6-pro', 'conv_v3_stream', 'separate')
  const chunks: string[] = []
  for await (const chunk of streamHandler.handleStream(Readable.from(upstreamLines))) {
    chunks.push(chunk)
  }
  const output = chunks.join('')
  assert.match(output, /"reasoning_content":"thinking hard"/)
  assert.match(output, /答案是 42/)
  assert.match(output, /"prompt_tokens":10/)
  assert.match(output, /"total_tokens":15/)
  assert.match(output, /"finish_reason":"stop"/)

  const nonStreamHandler = new MimoStreamHandler('mimo-v2.6-pro', 'conv_v3_nonstream', 'separate')
  const parsed = JSON.parse(await nonStreamHandler.handleNonStream(Readable.from(upstreamLines)))
  assert.equal(parsed.choices[0].message.content, '答案是 42')
  assert.equal(parsed.choices[0].message.reasoning_content, 'thinking hard')
  assert.deepEqual(parsed.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

test('Mimo surfaces upstream error events as content and skips the empty-answer retry', async () => {
  let retries = 0
  const retryStream = async (): Promise<NodeJS.ReadableStream | null> => {
    retries += 1
    return null
  }

  const upstream = Readable.from([
    'event: error\n',
    'data: {"type":"text","content":"平台升级啦，请「刷新页面」畅享更好的体验！"}\n\n',
  ])
  const handler = new MimoStreamHandler('mimo-v2.6-pro', 'conv_err', 'separate', undefined, retryStream)
  const parsed = JSON.parse(await handler.handleNonStream(upstream))

  assert.match(parsed.choices[0].message.content, /平台升级/)
  assert.equal(retries, 0)
})

test('Mimo query includes injected tool prompt and the user request', () => {
  const query = buildMimoQuery([
    {
      role: 'system',
      content: '## Available Tools\nTool `weather-test:get_weather`: Get weather.',
    },
    {
      role: 'user',
      content: '请调用 get_weather 工具查询 Hangzhou 的天气，然后根据工具结果回答',
    },
  ] as any)

  assert.match(query, /System: ## Available Tools/)
  assert.match(query, /weather-test:get_weather/)
  assert.match(query, /User: 请调用 get_weather 工具查询 Hangzhou 的天气/)
})

test('Mimo query preserves managed tool call history for follow-up requests', () => {
  const query = buildMimoQuery([
    {
      role: 'user',
      content: '查询 Hangzhou 天气',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'weather-test:get_weather',
            arguments: '{"city":"Hangzhou"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"city":"Hangzhou","condition":"sunny","temperature":25}',
    },
    {
      role: 'user',
      content: '根据工具结果回答',
    },
  ] as any)

  assert.match(query, /<\|CHAT2API\|tool_calls>/)
  assert.match(query, /<\|CHAT2API\|invoke name="weather-test:get_weather">/)
  assert.match(query, /<\|CHAT2API\|tool_result tool_call_id="call_1">/)
  assert.match(query, /Hangzhou/)
  assert.match(query, /User: 根据工具结果回答/)
})

test('Mimo stream converts managed XML into OpenAI tool calls', async () => {
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'weather-test:get_weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
        },
      },
    },
  ]
  const transformed = new ToolCallingEngine().transformRequest({
    request: {
      model: 'MiMo-V2-Flash',
      messages: [{ role: 'user', content: '查询 Hangzhou 天气' }],
      tools,
      stream: true,
    },
    provider: {
      id: 'mimo',
      name: 'Mimo',
      type: 'builtin',
      authType: 'cookie',
      apiEndpoint: 'https://aistudio.xiaomimimo.com',
      headers: {},
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    } as any,
    actualModel: 'mimo-v2-flash',
  })
  const stream = Readable.from([
    'event: message\n',
    'data: {"content":"<|CHAT2API|tool_calls><|CHAT2API|invoke name=\\"weather-test:get_weather\\"><|CHAT2API|parameter name=\\"city\\"><![CDATA[Hangzhou]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>"}\n\n',
  ])
  const handler = new MimoStreamHandler('mimo-v2-flash', 'conv_1', 'separate', transformed.plan)
  const chunks: string[] = []

  for await (const chunk of handler.handleStream(stream)) {
    chunks.push(chunk)
  }

  const output = chunks.join('')
  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"weather-test:get_weather"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(output, /CHAT2API/)
})

test('Mimo thinking options follow the mimo2api reference (-think suffix / reasoning_effort)', () => {
  const modelMappings = {
    'MiMo-V2.5-Pro': 'mimo-v2.5-pro',
    'MiMo-V2.5': 'mimo-v2.5',
    'MiMo-V2-Flash': 'mimo-v2-flash',
  }

  const suffix = resolveMimoThinkingOptions('MiMo-V2.5-Pro-Think', undefined, modelMappings)
  assert.equal(suffix.enableThinking, true)
  assert.equal(suffix.upstreamModel, 'mimo-v2.5-pro')

  const effort = resolveMimoThinkingOptions('mimo-v2.5', 'high', modelMappings)
  assert.equal(effort.enableThinking, true)
  assert.equal(effort.upstreamModel, 'mimo-v2.5')

  const plain = resolveMimoThinkingOptions('mimo-v2-flash', undefined, modelMappings)
  assert.equal(plain.enableThinking, false)
  assert.equal(plain.upstreamModel, 'mimo-v2-flash')
})

test('Mimo parses native <tool_call> JSON blocks including string arguments', async () => {
  const upstream = Readable.from([
    'event: message\n',
    'data: {"type":"text","content":"<think>need weather</think><tool_call>{\\"name\\":\\"weather-test:get_weather\\",\\"arguments\\":\\"{\\\\\\"city\\\\\\":\\\\\\"Hangzhou\\\\\\"}\\"}</tool_call>"}\n\n',
  ])

  const handler = new MimoStreamHandler('mimo-v2.5-pro', 'conv_native', 'separate')
  const result = JSON.parse(await handler.handleNonStream(upstream))

  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  const toolCall = result.choices[0].message.tool_calls[0]
  assert.equal(toolCall.function.name, 'weather-test:get_weather')
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { city: 'Hangzhou' })
  assert.equal(result.choices[0].message.reasoning_content, 'need weather')
  assert.equal(result.choices[0].message.content, '')
})

test('Mimo retries once via retryStream when upstream answers nothing', async () => {
  const thinkingOnly = Readable.from([
    'event: message\n',
    'data: {"type":"text","content":"<think>hmm</think>"}\n\n',
  ])
  const answeredData = [
    'event: message\n',
    'data: {"type":"text","content":"今天杭州晴。"}\n\n',
  ]
  let calls = 0
  const retryStream = async (): Promise<NodeJS.ReadableStream | null> => {
    calls += 1
    return Readable.from(answeredData)
  }

  const streamHandler = new MimoStreamHandler('mimo-v2.5', 'conv_retry_stream', 'separate', undefined, retryStream)
  const chunks: string[] = []
  for await (const chunk of streamHandler.handleStream(thinkingOnly)) {
    chunks.push(chunk)
  }
  const streamed = chunks.join('')
  assert.equal(calls, 1)
  assert.match(streamed, /今天杭州晴。/)
  assert.match(streamed, /"finish_reason":"stop"/)

  const nonStreamHandler = new MimoStreamHandler('mimo-v2.5', 'conv_retry_nonstream', 'separate', undefined, retryStream)
  const parsed = JSON.parse(await nonStreamHandler.handleNonStream(Readable.from([])))
  assert.equal(calls, 2)
  assert.equal(parsed.choices[0].message.content, '今天杭州晴。')
})

test('Mimo empty-answer retry fires at most once even when the retry is still empty', async () => {
  let calls = 0
  const alwaysEmpty = async (): Promise<NodeJS.ReadableStream | null> => {
    calls += 1
    return Readable.from([])
  }

  const handler = new MimoStreamHandler('mimo-v2.5', 'conv_retry_cap', 'separate', undefined, alwaysEmpty)
  const parsed = JSON.parse(await handler.handleNonStream(Readable.from([])))

  assert.equal(calls, 1)
  assert.equal(parsed.choices[0].message.content, '')
})
