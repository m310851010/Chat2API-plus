import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contentToText,
  convertMessages,
  convertTools,
  convertToolChoice,
  mapStopReason,
  buildAnthropicResponse,
} from 'file:///H:/aiWork/Chat2API/src/main/proxy/routes/anthropicConvert.ts'

test('contentToText flattens blocks and strings', () => {
  assert.equal(contentToText('hello'), 'hello')
  assert.equal(contentToText(undefined), '')
  assert.equal(
    contentToText([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]),
    'a\nb'
  )
})

test('convertMessages maps tool_result and tool_use blocks to OpenAI shape', () => {
  const messages = convertMessages([
    { role: 'user', content: [{ type: 'text', text: 'what is 1+1' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me compute' },
        { type: 'tool_use', id: 'call_1', name: 'calc', input: { expr: '1+1' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '2' },
      ],
    },
  ])

  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0], { role: 'user', content: 'what is 1+1' })
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].content, 'let me compute')
  assert.deepEqual(messages[1].tool_calls, [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'calc', arguments: JSON.stringify({ expr: '1+1' }) },
    },
  ])
  assert.equal(messages[2].role, 'tool')
  assert.equal(messages[2].tool_call_id, 'call_1')
  assert.equal(messages[2].content, '2')
})

test('convertTools converts Anthropic tools to OpenAI functions', () => {
  const tools = convertTools([
    { name: 'search', description: 'Search the web', input_schema: { type: 'object', properties: {} } },
  ])
  assert.deepEqual(tools, [
    {
      type: 'function',
      function: {
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: {} },
      },
    },
  ])
  assert.equal(convertTools([]), undefined)
})

test('convertToolChoice maps all Anthropic variants', () => {
  assert.equal(convertToolChoice('auto'), 'auto')
  assert.equal(convertToolChoice('any'), 'required')
  assert.equal(convertToolChoice('none'), 'none')
  assert.equal(convertToolChoice({ type: 'any' }), 'required')
  assert.deepEqual(convertToolChoice({ type: 'tool', name: 'calc' }), {
    type: 'function',
    function: { name: 'calc' },
  })
  assert.equal(convertToolChoice({ type: 'none' }), 'none')
  assert.equal(convertToolChoice(undefined), undefined)
})

test('mapStopReason covers finish reasons', () => {
  assert.equal(mapStopReason('tool_calls'), 'tool_use')
  assert.equal(mapStopReason('stop', true), 'tool_use')
  assert.equal(mapStopReason('length'), 'max_tokens')
  assert.equal(mapStopReason('stop', false), 'end_turn')
  assert.equal(mapStopReason(undefined), 'end_turn')
})

test('buildAnthropicResponse converts OpenAI response to Anthropic message', () => {
  const response = buildAnthropicResponse(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'calling tool',
            tool_calls: [
              {
                id: 'call_9',
                function: { name: 'calc', arguments: '{"a":1}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    'my-model',
    'msg_1'
  )

  assert.equal(response.type, 'message')
  assert.equal(response.role, 'assistant')
  assert.equal(response.model, 'my-model')
  assert.equal(response.stop_reason, 'tool_use')
  assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 5 })
  assert.deepEqual(response.content, [
    { type: 'text', text: 'calling tool' },
    { type: 'tool_use', id: 'call_9', name: 'calc', input: { a: 1 } },
  ])
})

test('buildAnthropicResponse handles plain text and empty content', () => {
  const plain = buildAnthropicResponse(
    {
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    'm',
    'msg_2'
  )
  assert.equal(plain.stop_reason, 'end_turn')
  assert.deepEqual(plain.content, [{ type: 'text', text: 'hi' }])

  const empty = buildAnthropicResponse(
    { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] },
    'm',
    'msg_3'
  )
  assert.deepEqual(empty.content, [{ type: 'text', text: '' }])
})
