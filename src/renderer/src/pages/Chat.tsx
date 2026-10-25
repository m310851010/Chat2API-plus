import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessagesSquare, ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/stores/chatStore'
import { ConversationSidebar } from '@/components/chat/ConversationSidebar'
import { MessageItem } from '@/components/chat/MessageItem'
import { ChatInput } from '@/components/chat/ChatInput'
import { ModelSelector } from '@/components/chat/ModelSelector'

export function Chat() {
  const { t } = useTranslation()
  const {
    conversations,
    activeConversationId,
    models,
    selectedModel,
    streamingConversationIds,
    proxyRunning,
    init,
    refreshProxyStatus,
    loadProviders,
    setSelectedModel,
    setConversationModel,
    newConversation,
    selectConversation,
    deleteConversation,
    renameConversation,
    forkConversation,
    sendMessage,
    stopGeneration,
  } = useChatStore()

  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  const activeConversation = conversations.find((c) => c.id === activeConversationId) || null
  const messages = activeConversation?.messages || []
  // Streaming state is per conversation: only the active conversation shows its own spinner
  const isStreaming = !!activeConversationId && streamingConversationIds.includes(activeConversationId)

  useEffect(() => {
    // Always refresh on mount: the proxy may have been started/stopped
    // on other pages while this component was unmounted
    void init()
    void refreshProxyStatus()
    void loadProviders()
    // Also keep in sync when the proxy toggles while this page is open
    const unsubscribe = window.electronAPI.proxy.onStatusChanged(() => {
      const { refreshProxyStatus, loadProviders } = useChatStore.getState()
      void refreshProxyStatus().then(() => loadProviders())
    })
    return () => {
      unsubscribe()
    }
  }, [init, refreshProxyStatus, loadProviders])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    nearBottomRef.current = distance < 80
    setShowScrollToBottom(distance > 200)
  }

  useEffect(() => {
    if (nearBottomRef.current) {
      scrollToBottom(isStreaming ? 'auto' : 'smooth')
    }
    setShowScrollToBottom(false)
  }, [messages, isStreaming, scrollToBottom])

  const handleSend = (text: string) => {
    nearBottomRef.current = true
    if (!activeConversationId && selectedModel) {
      newConversation(selectedModel)
    }
    void sendMessage(text)
  }

  return (
    <div className="flex gap-4 h-full min-h-0">
      <ConversationSidebar
        conversations={conversations}
        activeId={activeConversationId}
        streamingIds={streamingConversationIds}
        onSelect={selectConversation}
        onNew={() => newConversation()}
        onDelete={deleteConversation}
        onRename={renameConversation}
        onFork={forkConversation}
      />

      <div className="glass-card flex-1 flex flex-col min-w-0 h-full overflow-hidden rounded-xl">
        {activeConversation ? (
          <>
            <div className="relative flex-1 min-h-0">
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="h-full overflow-y-auto overflow-x-hidden px-4 py-4 space-y-4"
              >
                {messages.map((message) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    isStreaming={
                      isStreaming && message.role === 'assistant' && message.id === messages[messages.length - 1]?.id
                    }
                  />
                ))}
              </div>
              {showScrollToBottom ? (
                <button
                  onClick={() => {
                    nearBottomRef.current = true
                    scrollToBottom()
                  }}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 h-8 w-8 rounded-full glass-card glass-card-hover flex items-center justify-center shadow-md"
                  title={t('chat.scrollToBottom')}
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
              ) : null}
            </div>

            <ChatInput
              models={models}
              selectedModel={selectedModel}
              onModelChange={setConversationModel}
              proxyRunning={proxyRunning}
              onRefreshProxy={() => void refreshProxyStatus()}
              onSend={handleSend}
              onStop={() => stopGeneration(activeConversationId ?? undefined)}
              isStreaming={isStreaming}
              disabled={!selectedModel}
              conversationKey={activeConversationId ?? undefined}
            />
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground px-6 py-10">
            <div className="h-16 w-16 rounded-2xl glass-card glass-card-hover flex items-center justify-center">
              <MessagesSquare className="h-8 w-8 opacity-60" />
            </div>
            <div className="text-center space-y-1">
              <p className="text-foreground font-medium">{t('chat.emptyChat')}</p>
              <p className="text-sm">{t('chat.emptyChatDesc')}</p>
            </div>
            <div className="flex flex-col items-center gap-2">
              <ModelSelector
                models={models}
                value={selectedModel}
                onChange={setSelectedModel}
                disabled={isStreaming}
              />
              <button
                onClick={() => newConversation()}
                className="px-4 py-2 rounded-lg text-sm bg-blue-500 text-white hover:bg-blue-600 transition-colors"
              >
                {t('chat.newChat')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default Chat
