import type { BuiltinProviderConfig } from '../../store/types'

export const chatgptConfig: BuiltinProviderConfig = {
  id: 'chatgpt',
  name: 'ChatGPT',
  type: 'builtin',
  authType: 'token',
  apiEndpoint: 'https://chatgpt.com',
  chatPath: '/backend-api/conversation',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Origin': 'https://chatgpt.com',
    'Referer': 'https://chatgpt.com/',
  },
  enabled: true,
  description: 'ChatGPT (OpenAI web version), import Access Token to directly converse with GPT series models',
  supportedModels: [
    'auto',
    'gpt-5',
    'gpt-5-1',
    'gpt-5-2',
    'gpt-5-3',
    'gpt-5-3-mini',
    'gpt-5-mini',
  ],
  modelMappings: {
    'auto': 'auto',
    'gpt-5': 'gpt-5',
    'gpt-5-1': 'gpt-5-1',
    'gpt-5-2': 'gpt-5-2',
    'gpt-5-3': 'gpt-5-3',
    'gpt-5-3-mini': 'gpt-5-3-mini',
    'gpt-5-mini': 'gpt-5-mini',
  },
  credentialFields: [
    {
      name: 'token',
      label: 'Access Token',
      type: 'password',
      required: true,
      placeholder: 'Enter ChatGPT Access Token',
      helpText: "Open https://chatgpt.com/api/auth/session in your browser, log in and copy the value of the 'accessToken' field",
    },
  ],
  modelsApiEndpoint: 'https://chatgpt.com/backend-api/models?history_and_training_disabled=false',
  tokenCheckEndpoint: '/backend-api/me',
  tokenCheckMethod: 'GET',
}

export default chatgptConfig
