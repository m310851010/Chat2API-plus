import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

test('header proxy badge renders the configured bind address instead of a hard-coded loopback host', () => {
  const headerSource = readFileSync(join(root, 'src/renderer/src/components/layout/Header.tsx'), 'utf8')
  const handlersSource = readFileSync(join(root, 'src/main/ipc/handlers.ts'), 'utf8')
  const sharedTypesSource = readFileSync(join(root, 'src/shared/types.ts'), 'utf8')

  assert.match(sharedTypesSource, /export interface ProxyStatus \{[\s\S]*?\n\s+host: string/)
  assert.match(handlersSource, /host: proxyHost/)
  assert.match(handlersSource, /proxyStatusManager\.getHost\(\)/)
  assert.match(handlersSource, /key === 'config'[\s\S]*?IpcChannels\.CONFIG_CHANGED/)
  assert.match(headerSource, /const \[host, setHost\] = useState\('127\.0\.0\.1'\)/)
  assert.match(headerSource, /setHost\(status\.host \|\| '127\.0\.0\.1'\)/)
  assert.match(headerSource, /setHost\(config\.proxyHost \|\| '127\.0\.0\.1'\)/)
  assert.match(headerSource, /\{host\}:\{port\}/)
  assert.doesNotMatch(headerSource, /127\.0\.0\.1:\{port\}/)
})
