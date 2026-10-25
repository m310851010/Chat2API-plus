import test from 'node:test'
import assert from 'node:assert/strict'

import { createProviderFromData } from '../../src/main/providers/providerFactory.ts'
import { mimoConfig } from '../../src/main/providers/builtin/mimo.ts'
import { glmConfig } from '../../src/main/providers/builtin/glm.ts'

test('creating a built-in provider falls back to the built-in modelMappings even when the caller omits them', () => {
  // Mirrors the renderer's handleSelectBuiltinProvider payload, which passes
  // supportedModels but not modelMappings/chatPath/credentialFields.
  const provider = createProviderFromData(
    {
      id: 'mimo',
      name: mimoConfig.name,
      type: 'builtin',
      authType: mimoConfig.authType,
      apiEndpoint: mimoConfig.apiEndpoint,
      headers: mimoConfig.headers,
      description: mimoConfig.description,
      supportedModels: mimoConfig.supportedModels,
      credentialFields: mimoConfig.credentialFields,
    },
    'mimo',
    1792933379798
  )

  assert.equal(provider.type, 'builtin')
  assert.equal(provider.chatPath, mimoConfig.chatPath)
  assert.deepEqual(provider.modelMappings, mimoConfig.modelMappings)
  // The regression: display names must map to upstream model ids or Xiaomi
  // rejects the request with "模型名称错误"
  assert.equal(provider.modelMappings?.['MiMo-V2.6-Flash'], 'mimo-v2.6-flash')
  assert.equal(provider.modelMappings?.['MiMo-V2.6-Pro'], 'mimo-v2.6-pro')
  assert.equal(provider.modelMappings?.['MiMo-V2.6-Pro-UltraSpeed'], 'mimo-v2.6-pro-ultraspeed-studio')
})

test('explicit creation data wins over the built-in configuration', () => {
  const provider = createProviderFromData(
    {
      id: 'glm',
      name: glmConfig.name,
      type: 'builtin',
      authType: glmConfig.authType,
      apiEndpoint: glmConfig.apiEndpoint,
      supportedModels: ['custom-model'],
      modelMappings: { 'custom-model': 'custom-model' },
    },
    'glm',
    1792933379798
  )

  assert.deepEqual(provider.supportedModels, ['custom-model'])
  assert.deepEqual(provider.modelMappings, { 'custom-model': 'custom-model' })
  // Unspecified fields still come from the built-in config
  assert.equal(provider.chatPath, glmConfig.chatPath)
})

test('custom providers keep identity mappings absent and default type to custom', () => {
  const provider = createProviderFromData(
    {
      name: 'My Relay',
      authType: 'userToken',
      apiEndpoint: 'https://relay.example.com',
    },
    'gen-1',
    1792933379798
  )

  assert.equal(provider.type, 'custom')
  assert.equal(provider.id, 'gen-1')
  assert.equal(provider.modelMappings, undefined)
  assert.equal(provider.chatPath, undefined)
  assert.deepEqual(provider.headers, {})
})
