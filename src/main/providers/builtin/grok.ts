import type { BuiltinProviderConfig } from '../../store/types'

export const grokConfig: BuiltinProviderConfig = {
  id: 'grok',
  name: 'Grok',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://grok.com',
  chatPath: '/rest/app-chat/conversations/new',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Origin': 'https://grok.com',
    'Referer': 'https://grok.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  enabled: true,
  description: 'xAI Grok models (grok-4 / grok-4-fast / grok-3) via app-chat NDJSON protocol',
  supportedModels: [
    'grok-4',
    'grok-4-fast',
    'grok-4-mini',
    'grok-4-thinking',
    'grok-3',
    'grok-3-mini',
    'grok-3-thinking',
    'grok-auto',
  ],
  modelMappings: {
    'grok-4': 'grok-4',
    'grok-4-fast': 'grok-4-fast',
    'grok-4-mini': 'grok-4-mini',
    'grok-4-thinking': 'grok-4-thinking',
    'grok-3': 'grok-3',
    'grok-3-mini': 'grok-3-mini',
    'grok-3-thinking': 'grok-3-thinking',
    'grok-auto': 'grok-auto',
  },
  credentialFields: [
    {
      name: 'cookie',
      label: 'Cookie',
      type: 'password',
      required: true,
      placeholder: 'Paste the full grok.com cookie string (DevTools > Application > Cookies > grok.com)',
      helpText: 'Open grok.com, sign in, and copy the full Cookie string from DevTools (Application > Cookies > grok.com)',
    },
  ],
  tokenCheckEndpoint: undefined,
  tokenCheckMethod: undefined,
}

export default grokConfig
