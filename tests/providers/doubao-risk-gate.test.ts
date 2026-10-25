import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  extractDoubaoVerifyData,
  hasNormalDoubaoEvent,
  RISK_SCAN_BUFFER_LIMIT,
} from '../../src/main/proxy/adapters/doubao-protocol.ts'

test('doubao verify-data extractor recovers the slide decision from a STREAM_ERROR payload', () => {
  const decision = JSON.stringify({
    code: '10000',
    from: 'shark_admin',
    version: '',
    type: 'verify',
    region: 'cn',
    subtype: 'slide',
    detail: 'g4*kM83NXUa*ioNOs4VYJqnZuCdyTohkoOjwmdg',
  })

  const errEvent = {
    event_type: 2005,
    event_data: JSON.stringify({
      code: 710022004,
      message: 'rate limited',
      error_detail: {
        code: 710022004,
        locale: 'zh',
        message: '系统错误',
        ext: { decision },
      },
    }),
  }

  const wire = `data: ${JSON.stringify(errEvent)}\n\n`
  const extracted = extractDoubaoVerifyData(wire)
  assert.ok(extracted, 'decision should be extracted')
  assert.deepEqual(JSON.parse(extracted!), JSON.parse(decision))

  // A challenge split across stream chunks is still detected once the
  // second half arrives
  const splitPoint = Math.floor(wire.length / 2)
  assert.equal(extractDoubaoVerifyData(wire.slice(0, splitPoint)), null)
  assert.ok(extractDoubaoVerifyData(wire), 'full buffer yields the decision')
})

test('doubao normal traffic is never misread as a challenge', () => {
  const normalEvent = {
    event_type: 2001,
    event_data: JSON.stringify({ message: { content: JSON.stringify({ text: '你好' }) } }),
  }
  const wire = `data: ${JSON.stringify(normalEvent)}\n\n`

  assert.equal(extractDoubaoVerifyData(wire), null)
  assert.equal(hasNormalDoubaoEvent(wire), true)
})

test('doubao adapter wires the risk gate with captcha retry', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/main/proxy/adapters/doubao.ts'),
    'utf8',
  )

  assert.match(source, /class DoubaoRiskGate/)
  assert.match(source, /solveDoubaoCaptcha\(\{[\s\S]*?verifyData: outcome\.verifyData[\s\S]*?\}\)/)
  assert.match(source, /const maxAttempts = 3/)
  assert.equal(RISK_SCAN_BUFFER_LIMIT, 65536)
})
