import type { BuiltinProviderConfig } from '../../store/types'

export const doubaoConfig: BuiltinProviderConfig = {
  id: 'doubao',
  name: 'Doubao',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://www.doubao.com',
  chatPath: '/samantha/chat/completion',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'agw-js-conv': 'str',
    'Origin': 'https://www.doubao.com',
    'Referer': 'https://www.doubao.com/chat/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  },
  enabled: true,
  description: 'ByteDance Doubao web-based models (pro chat / deep think) via samantha chat completion protocol',
  supportedModels: [
    'doubao-pro-chat',
    'doubao-deep-think',
  ],
  modelMappings: {
    'doubao-pro-chat': 'doubao-pro-chat',
    'doubao-deep-think': 'doubao-deep-think',
  },
  credentialFields: [
    {
      name: 'cookie',
      label: 'Cookie',
      type: 'password',
      required: true,
      placeholder: 'Paste the full doubao.com cookie string (DevTools > Application > Cookies > www.doubao.com)',
      helpText: 'Open https://www.doubao.com and sign in, then copy the full Cookie string from DevTools (Application > Cookies > www.doubao.com). Required key cookie: sessionid',
    },
  ],
  tokenCheckEndpoint: undefined,
  tokenCheckMethod: undefined,
}

export default doubaoConfig
