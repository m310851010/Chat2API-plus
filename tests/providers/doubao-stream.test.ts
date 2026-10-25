import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { DoubaoStreamHandler } from '../../src/main/proxy/adapters/doubao-stream.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const doubaoAdapterSource = readFileSync(
  join(process.cwd(), 'src/main/proxy/adapters/doubao.ts'),
  'utf8',
)

function sse(events: unknown[]): Readable {
  return Readable.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`))
}

async function collect(stream: NodeJS.ReadableStream): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(String(chunk))
  }
  return chunks
}

test('Doubao stream forwards 2001 text chunks and captures the 2002 conversation id', async () => {
  const captured: string[] = []
  const handler = new DoubaoStreamHandler('doubao-pro-chat', 'session-1', undefined, undefined, (id) => captured.push(id))

  const source = sse([
    { event_type: 2002, event_data: JSON.stringify({ conversation_id: '735111' }) },
    { event_type: 2001, event_data: JSON.stringify({ message: { reply_id: '0', content: JSON.stringify({ text: 'hi' }) } }) },
    { event_type: 2001, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '你好' }) } }) },
    { event_type: 2003, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '你好，世界' }) } }) },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.deepEqual(captured, ['735111'])
  assert.match(joined, /"content":"你好"/)
  assert.match(joined, /"finish_reason":"stop"/)
  assert.match(joined, /data: \[DONE\]/)
  // user echo and the FIN full-text snapshot must not be re-emitted
  assert.doesNotMatch(joined, /"content":"hi"/)
  assert.doesNotMatch(joined, /"content":"你好，世界"/)
})

test('Doubao stream emits deep-think chunks as reasoning_content', async () => {
  const handler = new DoubaoStreamHandler('doubao-deep-think', 'session-think')

  const source = sse([
    { event_type: 2008, event_data: JSON.stringify({ message: { content: JSON.stringify({ think: '思考中' }) } }) },
    { event_type: 2001, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '答案是42' }) } }) },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.match(joined, /"reasoning_content":"思考中"/)
  assert.match(joined, /"content":"答案是42"/)
})

test('Doubao stream drops loading status cards and thinking status labels from text', async () => {
  const handler = new DoubaoStreamHandler('doubao-pro-chat', 'session-status')

  const source = sse([
    { event_type: 2001, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '深度思考中' }), content_type: 2003 } }) },
    { event_type: 2001, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '已完成思考' }), content_type: 2003 } }) },
    { event_type: 2001, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '已完成思考' }) } }) },
    { event_type: 2001, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: 'Hi～你好呀😊' }) } }) },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.match(joined, /"content":"Hi～你好呀😊"/)
  assert.doesNotMatch(joined, /"content":"深度思考中"/)
  assert.doesNotMatch(joined, /"content":"已完成思考"/)
})

test('Doubao non-stream drops loading status cards and thinking status labels from text', async () => {
  const handler = new DoubaoStreamHandler('doubao-pro-chat', 'session-status-nonstream')

  const source = sse([
    { event_type: 2001, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '深度思考中' }), content_type: 2003 } }) },
    { event_type: 2001, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '已完成思考' }) } }) },
    { event_type: 2001, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '回答' }) } }) },
  ])

  const result = await handler.handleNonStream(source)

  assert.equal(result.choices[0].message.content, '回答')
})

test('Doubao non-stream accumulates text and thinking from all events', async () => {
  const handler = new DoubaoStreamHandler('doubao-deep-think', 'session-nonstream')

  const source = sse([
    { event_type: 2008, event_data: JSON.stringify({ message: { content: JSON.stringify({ think: '思考A' }) } }) },
    { event_type: 2001, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '回答' }) } }) },
    { event_type: 2001, event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '完整' }) } }) },
  ])

  const result = await handler.handleNonStream(source)

  assert.equal(result.choices[0].message.content, '回答完整')
  assert.equal((result.choices[0].message as any).reasoning_content, '思考A')
})

test('Doubao stream surfaces upstream JSON error bodies as stream errors', async () => {
  const handler = new DoubaoStreamHandler('doubao-pro-chat', 'session-error')

  const source = sse([
    { code: 710022002, message: 'rate limited' },
  ])

  const stream = await handler.handleStream(source)
  await assert.rejects(async () => {
    for await (const _ of stream) {
      // drain
    }
  }, /710022002/)
})

test('Doubao model resolution maps pro and deep-think configs with distinct bot ids', () => {
  assert.match(doubaoAdapterSource, /'doubao-pro-chat': \{ botId: PRO_BOT_ID, deepThink: false \}/)
  assert.match(doubaoAdapterSource, /'doubao-deep-think': \{ botId: DEFAULT_BOT_ID, deepThink: true \}/)
  assert.match(doubaoAdapterSource, /lower\.includes\('think'\) \|\| lower\.includes\('deep'\)/)
})
