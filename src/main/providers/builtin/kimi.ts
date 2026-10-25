import type { BuiltinProviderConfig } from '../../store/types'

export const kimiConfig: BuiltinProviderConfig = {
  id: 'kimi',
  name: 'Kimi',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://www.kimi.com',
  chatPath: '/apiv2/kimi.gateway.chat.v1.ChatService/Chat',
  headers: {
    'Content-Type': 'application/connect+json',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Origin': 'https://www.kimi.com',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Priority': 'u=1, i',
  },
  enabled: true,
  description: 'Kimi AI assistant by Moonshot (K3 / K2.8 Preview / K2.6), supports thinking mode and web search',
  supportedModels: [
    'Kimi-K3',
    'Kimi-K2.8-Preview',
    'Kimi-K2.6',
  ],
  modelMappings: {
    'Kimi-K3': 'kimi-k3',
    'Kimi-K2.8-Preview': 'kimi-k28-preview',
    'Kimi-K2.6': 'kimi-k2.6',
  },
  credentialFields: [
    {
      name: 'token',
      label: '访问令牌',
      type: 'password',
      required: true,
      placeholder: '请输入 Kimi 访问令牌或刷新令牌',
      helpText: '网页版实时 Access Token（推荐从 DevTools -> Network 中 /apiv2/ 请求的 Authorization: Bearer 值获取），或 Cookie 中的 kimi-auth',
    },
    {
      name: 'refresh_token',
      label: '刷新令牌（可选）',
      type: 'password',
      required: false,
      placeholder: '请输入 Kimi Refresh Token（可选）',
      helpText: '可选。填写后 Access Token 过期时会自动续期。从网页版 DevTools -> Application -> Local Storage -> www.kimi.com -> refresh_token 获取',
    },
  ],
  tokenCheckEndpoint: '/api/auth/token/refresh',
  tokenCheckMethod: 'GET',
}

export default kimiConfig
