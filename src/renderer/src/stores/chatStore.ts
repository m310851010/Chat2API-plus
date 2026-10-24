import { create } from 'zustand'
import type { AppConfig, EffectiveModel, Provider } from '@/types/electron'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  model?: string
  createdAt: number
  error?: boolean
}

export interface Conversation {
  id: string
  title: string
  model?: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

export interface ChatModelOption {
  key: string
  label: string
  value: string
  providerId: string
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  models: ChatModelOption[]
  selectedModel: string | null
  streamingConversationIds: string[]
  isInitialized: boolean
  proxyRunning: boolean
  proxyPort: number
  proxyHost: string

  init: () => Promise<void>
  refreshProxyStatus: () => Promise<void>
  loadProviders: () => Promise<void>
  newConversation: (model?: string) => void
  selectConversation: (id: string) => void
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  forkConversation: (id: string) => void
  clearAllConversations: () => Promise<void>
  sendMessage: (text: string) => Promise<void>
  stopGeneration: (conversationId?: string) => void
  setSelectedModel: (model: string) => void
  setConversationModel: (model: string) => void
}

const CHATS_STORAGE_KEY = 'chats'
const MAX_HISTORY_MESSAGES = 30

const abortControllers = new Map<string, AbortController>()

function generateId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function persistConversations(conversations: Conversation[]): Promise<void> {
  try {
    await window.electronAPI.store.set(CHATS_STORAGE_KEY, conversations)
  } catch (error) {
    console.error('[ChatStore] Failed to persist conversations:', error)
  }
}

async function getAuthProviderHeader(): Promise<string | null> {
  try {
    const config = await window.electronAPI.store.get<AppConfig>('config')
    if (config?.enableApiKey && Array.isArray(config.apiKeys)) {
      const enabled = config.apiKeys.find((k) => k.enabled && k.key)
      if (enabled) {
        return `Bearer ${enabled.key}`
      }
    }
  } catch {
    // ignore, allow unauthenticated call
  }
  return null
}

interface StreamOptions {
  port: number
  host: string
  model: string
  messages: Array<{ role: string; content: string }>
  onContent: (delta: string) => void
  onReasoning: (delta: string) => void
  signal: AbortSignal
}

/**
 * Stream a chat completion through the local proxy (OpenAI-compatible SSE)
 */
export async function streamChatCompletion(options: StreamOptions): Promise<void> {
  const { port, host, model, messages, onContent, onReasoning, signal } = options
  const authHeader = await getAuthProviderHeader()

  const response = await fetch(`http://${host}:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
    signal,
  })

  if (!response.ok || !response.body) {
    let message = `HTTP ${response.status}`
    try {
      const data = await response.json()
      if (data?.error?.message) {
        message = data.error.message
      }
    } catch (err) {
      console.log('[ChatStore] Failed to parse error response:', err)
    }
    throw new Error(message)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue

      try {
        const chunk = JSON.parse(payload)
        const delta = chunk?.choices?.[0]?.delta
        if (!delta) continue
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          onReasoning(delta.reasoning_content)
        }
        const content = typeof delta.content === 'string'
          ? delta.content
          : Array.isArray(delta.content)
            ? delta.content
                .map((part: { text?: string }) => (typeof part?.text === 'string' ? part.text : ''))
                .join('')
            : ''
        if (content) {
          onContent(content)
        }
      } catch (err) {
        console.log('[ChatStore] Failed to parse SSE chunk:', err)
      }
    }
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  models: [],
  selectedModel: null,
  streamingConversationIds: [],
  isInitialized: false,
  proxyRunning: false,
  proxyPort: 8080,
  proxyHost: '127.0.0.1',

  init: async () => {
    if (get().isInitialized) return
    set({ isInitialized: true })

    try {
      const chats = await window.electronAPI.store.get<Conversation[]>(CHATS_STORAGE_KEY)
      const active = Array.isArray(chats) && chats.length > 0 ? chats[0] : null
      set({
        conversations: Array.isArray(chats) ? chats : [],
        activeConversationId: active?.id ?? null,
        selectedModel: active?.model || get().selectedModel,
      })
    } catch (error) {
      console.error('[ChatStore] Failed to load conversations:', error)
    }

    // Load config/proxy status first so the model API host/port are correct
    try {
      const config = await window.electronAPI.store.get<AppConfig>('config')
      if (config) {
        set({
          proxyPort: config.proxyPort || 8080,
          proxyHost: config.proxyHost || '127.0.0.1',
        })
      }
    } catch (error) {
      console.error('[ChatStore] Failed to load config:', error)
    }

    await get().refreshProxyStatus()
    await get().loadProviders()
  },

  refreshProxyStatus: async () => {
    try {
      const status = await window.electronAPI.proxy.getStatus()
      const config = await window.electronAPI.store.get<AppConfig>('config')
      set({
        proxyRunning: Boolean(status?.isRunning),
        proxyPort: config?.proxyPort || status?.port || 8080,
        proxyHost: config?.proxyHost || status?.host || '127.0.0.1',
      })
    } catch (error) {
      console.error('[ChatStore] Failed to load proxy status:', error)
    }
  },

  loadProviders: async () => {
    let options: ChatModelOption[] | null = null

    // Preferred: load model list from the local proxy /v1/models API
    try {
      const { proxyPort, proxyHost } = get()
      const authHeader = await getAuthProviderHeader()
      const response = await fetch(`http://${proxyHost}:${proxyPort}/v1/models`, {
        headers: authHeader ? { Authorization: authHeader } : {},
      })
      if (response.ok) {
        const json = await response.json()
        const data = Array.isArray(json?.data)
          ? (json.data as Array<{ id?: string; owned_by?: string }>)
          : []
        const seen = new Set<string>()
        options = []
        for (const model of data) {
          const id = typeof model?.id === 'string' ? model.id : ''
          const owner = typeof model?.owned_by === 'string' && model.owned_by ? model.owned_by : 'unknown'
          if (!id || seen.has(id)) continue
          seen.add(id)
          options.push({
            key: `proxy:${owner}:${id}`,
            label: `${id} (${owner})`,
            value: id,
            providerId: owner,
          })
        }
      }
    } catch (error) {
      console.error('[ChatStore] Failed to load models from proxy API:', error)
    }

    // Fallback: load effective models of enabled providers via IPC
    if (!options || options.length === 0) {
      try {
        const providers = await window.electronAPI.providers.getAll()
        const enabledProviders = providers.filter((p: Provider) => p.enabled)
        options = []
        for (const provider of enabledProviders) {
          try {
            const effectiveModels: EffectiveModel[] = await window.electronAPI.providers.getEffectiveModels(provider.id)
            for (const model of effectiveModels) {
              options.push({
                key: `${provider.id}:${model.displayName}`,
                label: `${model.displayName} (${provider.name})`,
                value: model.displayName,
                providerId: provider.id,
              })
            }
          } catch (error) {
            console.error(`[ChatStore] Failed to load models for provider ${provider.id}:`, error)
          }
        }
      } catch (error) {
        console.error('[ChatStore] Failed to load providers:', error)
        options = []
      }
    }

    const resolved = options || []
    const activeConversation = get().conversations.find((c) => c.id === get().activeConversationId)
    // Prefer the active conversation's own model when it is still available
    if (activeConversation?.model && resolved.some((opt) => opt.value === activeConversation.model)) {
      set({ models: resolved, selectedModel: activeConversation.model })
      return
    }
    const previous = get().selectedModel
    set({ models: resolved })
    if (!previous && resolved.length > 0) {
      set({ selectedModel: resolved[0].value })
    } else if (previous && resolved.length > 0 && !resolved.some((opt) => opt.value === previous)) {
      set({ selectedModel: resolved[0].value })
    }
  },

  newConversation: (model) => {
    const now = Date.now()
    const conversation: Conversation = {
      id: generateId(),
      title: '',
      model: model || get().selectedModel || undefined,
      createdAt: now,
      updatedAt: now,
      messages: [],
    }
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      activeConversationId: conversation.id,
    }))
    void persistConversations(get().conversations)
  },

  selectConversation: (id) => {
    const conversation = get().conversations.find((c) => c.id === id)
    set({ activeConversationId: id, selectedModel: conversation?.model || get().selectedModel })
  },

  deleteConversation: (id) => {
    // stop this conversation's stream in the background, if any
    abortControllers.get(id)?.abort()
    abortControllers.delete(id)
    set({
      streamingConversationIds: get().streamingConversationIds.filter((sid) => sid !== id),
    })
    const remaining = get().conversations.filter((c) => c.id !== id)
    const activeId = get().activeConversationId
    const nextActiveId = activeId === id ? (remaining[0]?.id ?? null) : activeId
    const fallbackModel =
      nextActiveId && activeId === id
        ? remaining.find((c) => c.id === nextActiveId)?.model
        : undefined
    set({
      conversations: remaining,
      activeConversationId: nextActiveId,
      ...(fallbackModel ? { selectedModel: fallbackModel } : {}),
    })
    void persistConversations(remaining)
  },

  renameConversation: (id, title) => {
    const conversations = get().conversations.map((c) =>
      c.id === id ? { ...c, title } : c
    )
    set({ conversations })
    void persistConversations(conversations)
  },

  forkConversation: (id) => {
    const source = get().conversations.find((c) => c.id === id)
    if (!source) return
    const now = Date.now()
    const fork: Conversation = {
      ...source,
      id: generateId(),
      title: source.title ? `${source.title} (fork)` : `(fork)`,
      createdAt: now,
      updatedAt: now,
      // only fork completed messages (drop streaming placeholder if any)
      messages: source.messages
        .map((msg) => ({ ...msg }))
        .filter((msg) => msg.role !== 'assistant' || msg.content || msg.reasoning),
    }
    const conversations = [fork, ...get().conversations]
    set({ conversations, activeConversationId: fork.id })
    void persistConversations(conversations)
  },

  clearAllConversations: async () => {
    set({ conversations: [], activeConversationId: null })
    await persistConversations([])
  },

  setSelectedModel: (model) => set({ selectedModel: model }),

  setConversationModel: (model) => {
    const activeId = get().activeConversationId
    if (!activeId) {
      set({ selectedModel: model })
      return
    }
    const conversations = get().conversations.map((c) =>
      c.id === activeId ? { ...c, model } : c
    )
    set({ conversations, selectedModel: model })
    void persistConversations(conversations)
  },

  stopGeneration: (conversationId) => {
    const ids = conversationId
      ? [conversationId]
      : Array.from(abortControllers.keys())
    for (const id of ids) {
      abortControllers.get(id)?.abort()
      abortControllers.delete(id)
    }
  },

  sendMessage: async (text) => {
    const trimmed = text.trim()
    const { selectedModel, proxyPort, proxyHost } = get()
    if (!trimmed) return

    // Per-conversation model: fall back to the global selection for legacy conversations
    const existing = get().conversations.find((c) => c.id === get().activeConversationId)
    const model = existing?.model || selectedModel
    if (!model) return
    // Block only if THIS conversation is already generating; other conversations
    // may keep streaming in the background (parallel, independent)
    if (get().streamingConversationIds.includes(existing?.id ?? '')) return

    let conversation = existing
    if (!conversation) {
      get().newConversation(model)
      conversation = get().conversations.find((c) => c.id === get().activeConversationId)
    }
    if (!conversation) return

    const now = Date.now()
    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: trimmed,
      createdAt: now,
    }
    const assistantMessage: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      model: model,
      createdAt: now + 1,
    }

    const updatedMessages = [...conversation.messages, userMessage, assistantMessage]
    const updatedConversation: Conversation = {
      ...conversation,
      title: conversation.title || trimmed.slice(0, 40),
      model: model,
      updatedAt: now,
      messages: updatedMessages,
    }

    const conversations = get().conversations.map((c) =>
      c.id === updatedConversation.id ? updatedConversation : c
    )
    set({
      conversations,
      streamingConversationIds: [...get().streamingConversationIds, conversation.id],
    })
    void persistConversations(conversations)

    const messageKey = `${conversation.id}:${assistantMessage.id}`
    const updateAssistant = (patch: Partial<ChatMessage>) => {
      const nextState = get()
      const target = nextState.conversations.find((c) => c.id === conversation!.id)
      if (!target) return
      const nextMessages = target.messages.map((msg) =>
        msg.id === assistantMessage.id ? { ...msg, ...patch } : msg
      )
      set({
        conversations: nextState.conversations.map((c) =>
          c.id === conversation!.id ? { ...c, messages: nextMessages } : c
        ),
      })
    }

    const controller = new AbortController()
    abortControllers.set(conversation.id, controller)

    try {
      // Send recent history excluding the placeholder assistant message
      const history = updatedMessages
        .filter((msg) => msg.id !== assistantMessage.id && !msg.error)
        .slice(-MAX_HISTORY_MESSAGES)
        .map((msg) => ({ role: msg.role, content: msg.content }))

      await streamChatCompletion({
        port: proxyPort,
        host: proxyHost,
        model: model,
        messages: history,
        signal: controller.signal,
        onContent: (delta) => {
          const current = get()
            .conversations.find((c) => c.id === conversation!.id)
            ?.messages.find((m) => m.id === assistantMessage.id)
          updateAssistant({ content: (current?.content || '') + delta })
        },
        onReasoning: (delta) => {
          const current = get()
            .conversations.find((c) => c.id === conversation!.id)
            ?.messages.find((m) => m.id === assistantMessage.id)
          updateAssistant({ reasoning: (current?.reasoning || '') + delta })
        },
      })

      const finalConversation = get().conversations.find((c) => c.id === conversation!.id)
      const finalMessage = finalConversation?.messages.find((m) => m.id === assistantMessage.id)
      if (finalMessage && !finalMessage.content && !finalMessage.reasoning) {
        updateAssistant({
          error: true,
        })
      }
      void persistConversations(get().conversations)
    } catch (error) {
      const aborted = controller.signal.aborted === true
      const message = aborted
        ? ''
        : error instanceof Error
          ? error.message
          : String(error)
      const current = get()
        .conversations.find((c) => c.id === conversation!.id)
        ?.messages.find((m) => m.id === assistantMessage.id)
      if (aborted) {
        // If nothing was generated before stopping, drop the empty placeholder
        const state = get().conversations.find((c) => c.id === conversation!.id)
        if (state && !current?.content && !current?.reasoning) {
          const cleaned = get().conversations.map((c) =>
            c.id === conversation!.id
              ? { ...c, messages: c.messages.filter((msg) => msg.id !== assistantMessage.id) }
              : c
          )
          set({ conversations: cleaned })
        }
      } else {
        updateAssistant({
          content: (current?.content || '') + (current?.content ? '\n\n' : '') + message,
          error: true,
        })
      }
      if (error instanceof Error && error.name !== 'AbortError') {
        console.error('[ChatStore] Stream failed:', error, messageKey)
      }
      void persistConversations(get().conversations)
    } finally {
      abortControllers.delete(conversation.id)
      set({
        streamingConversationIds: get().streamingConversationIds.filter(
          (id) => id !== conversation!.id
        ),
      })
    }
  },
}))

export default useChatStore
