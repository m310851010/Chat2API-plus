import { useState, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, Copy, Bot, User, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { renderMarkdown } from '@/lib/markdown'
import type { ChatMessage } from '@/stores/chatStore'

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

export const MessageItem = memo(function MessageItem({
  message,
  isStreaming,
}: {
  message: ChatMessage
  isStreaming: boolean
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const isUser = message.role === 'user'
  const isThinking = !isUser && isStreaming && !message.content && !message.reasoning
  const isThinkingActive = !isUser && isStreaming && !message.content && !!message.reasoning

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }

  return (
    <div className={cn('flex gap-3', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div
        className={cn(
          'flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center border border-[var(--glass-border)]',
          isUser ? 'bg-blue-500/20' : 'bg-emerald-500/20'
        )}
      >
        {isUser ? <User className="h-4 w-4 text-blue-500" /> : <Bot className="h-4 w-4 text-emerald-500" />}
      </div>

      <div className={cn('max-w-[80%] min-w-0 flex flex-col gap-0.5', isUser ? 'items-end' : 'items-start')}>
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs text-muted-foreground">
            {isUser ? t('chat.you') : message.model || t('chat.assistant')}
          </span>
          <span className="text-xs text-muted-foreground/60">{formatTime(message.createdAt)}</span>
        </div>

        <div
          className={cn(
            'rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap break-words min-w-[2rem] overflow-hidden',
            'border border-[var(--glass-border)]',
            isUser
              ? 'glass-card rounded-tr-sm'
              : message.error
                ? 'bg-destructive/10 border-destructive/30 rounded-tl-sm text-destructive'
                : 'glass-card rounded-tl-sm'
          )}
        >
          {message.error && <TriangleAlert className="h-4 w-4 mb-1.5 inline-block mr-1 -mt-0.5" />}

          {isThinkingActive ? (
            <div className="mb-2">
              <button
                onClick={() => setReasoningOpen((open) => !open)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {reasoningOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <span className="inline-flex items-center gap-1.5">
                  {t('chat.thinkingActive')}
                  <span className="inline-flex gap-0.5 items-center">
                    <span className="w-1 h-1 rounded-full bg-current opacity-60 animate-bounce [animation-delay:0ms]" />
                    <span className="w-1 h-1 rounded-full bg-current opacity-60 animate-bounce [animation-delay:150ms]" />
                    <span className="w-1 h-1 rounded-full bg-current opacity-60 animate-bounce [animation-delay:300ms]" />
                  </span>
                </span>
              </button>
              {reasoningOpen && (
                <div className="mt-1.5 pl-3 border-l-2 border-[var(--glass-border)] text-muted-foreground text-xs whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                  {message.reasoning}
                </div>
              )}
            </div>
          ) : !isUser && message.reasoning && !isStreaming && !message.content ? (
            <div className="mb-2">
              <button
                onClick={() => setReasoningOpen((open) => !open)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {reasoningOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {t('chat.thinking')}
              </button>
              {reasoningOpen && (
                <div className="mt-1.5 pl-3 border-l-2 border-[var(--glass-border)] text-muted-foreground text-xs whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                  {message.reasoning}
                </div>
              )}
            </div>
          ) : null}

          {isThinking ? (
            <span className="inline-flex gap-1 items-center h-4">
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce [animation-delay:300ms]" />
            </span>
          ) : isUser ? (
            message.content
          ) : message.error && !message.content ? (
            <span className="text-destructive">{t('chat.emptyResponse')}</span>
          ) : (
            <div className="markdown-body">{renderMarkdown(message.content)}</div>
          )}
        </div>

        {!isUser && message.content ? (
          <button
            onClick={handleCopy}
            className="opacity-60 hover:opacity-100 p-1 rounded transition-opacity"
            title={t('chat.copy')}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        ) : null}
      </div>
    </div>
  )
})
