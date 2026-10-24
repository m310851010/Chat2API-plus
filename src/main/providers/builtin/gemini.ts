import type { BuiltinProviderConfig } from '../../store/types'

export const geminiConfig: BuiltinProviderConfig = {
  id: 'gemini',
  name: 'Gemini',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://gemini.google.com',
  chatPath: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://gemini.google.com',
    'Referer': 'https://gemini.google.com/',
    'X-Same-Domain': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  },
  enabled: true,
  description: 'Google Gemini web-based models (Flash / Thinking / Pro) via StreamGenerate protocol',
  supportedModels: [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-thinking',
    'gemini-3.5-flash-thinking-lite',
    'gemini-3.1-pro',
    'gemini-auto',
    'gemini-flash-lite',
  ],
  modelMappings: {
    'gemini-3.7-flash': 'gemini-3.7-flash',
    'gemini-3.6-flash': 'gemini-3.6-flash',
    'gemini-3.5-flash': 'gemini-3.5-flash',
    'gemini-3.5-flash-thinking': 'gemini-3.5-flash-thinking',
    'gemini-3.5-flash-thinking-lite': 'gemini-3.5-flash-thinking-lite',
    'gemini-3.1-pro': 'gemini-3.1-pro',
    'gemini-auto': 'gemini-auto',
    'gemini-flash-lite': 'gemini-flash-lite',
  },
  credentialFields: [
    {
      name: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      required: true,
      placeholder: 'SID=xxx; HSID=xxx; SSID=xxx; APISID=xxx; SAPISID=xxx; __Secure-1PSID=xxx',
      helpText: 'Full cookie string from gemini.google.com (DevTools > Application > Cookies). Required key cookies: SID, HSID, SSID, APISID, SAPISID, __Secure-1PSID',
    },
  ],
  tokenCheckEndpoint: undefined,
  tokenCheckMethod: undefined,
}

export default geminiConfig
