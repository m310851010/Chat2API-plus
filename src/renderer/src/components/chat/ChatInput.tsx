import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ModelSelector } from './ModelSelector'
import type { ChatModelOption } from '@/stores/chatStore'

interface ChatInputProps {
  models: ChatModelOption[]
  selectedModel: string | null
  onModelChange: (model: string) => void
  proxyRunning: boolean
  onRefreshProxy: () => void
  onSend: (text: string) => void
  onStop: () => void
  isStreaming: boolean
  disabled?: boolean
  conversationKey?: string
}

export function ChatInput({
  models,
  selectedModel,
  onModelChange,
  proxyRunning,
  onRefreshProxy,
  onSend,
  onStop,
  isStreaming,
  disabled,
  conversationKey,
}: ChatInputProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Draft text belongs to its conversation: reset when switching conversations
  useEffect(() => {
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    // Focus the input so typing starts immediately in the new conversation
    const raf = requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
    const timer = setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 50)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [conversationKey])

  const autoResize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const handleSend = () => {
    if (disabled || isStreaming || !value.trim()) return
    onSend(value)
    setValue('')
    requestAnimationFrame(autoResize)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="p-3">
      <div className="glass-card rounded-2xl p-2 pt-1.5">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            autoResize()
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
          placeholder={t('chat.inputPlaceholder')}
          className={cn(
            'w-full bg-transparent resize-none outline-none text-sm px-2 py-1.5 placeholder:text-muted-foreground/60',
            'max-h-[200px] min-h-[32px]',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
        />

        <div className="flex items-center justify-between gap-2 px-1 pt-1.5">
          {/* Left: proxy status & generating indicator */}
          <button
            onClick={onRefreshProxy}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded-full text-xs border transition-colors flex-shrink-0 cursor-default outline-none focus:outline-none',
              proxyRunning
                ? 'border-emerald-500/30 text-emerald-500 bg-emerald-500/10'
                : 'border-red-500/30 text-red-500 bg-red-500/10'
            )}
            title={proxyRunning ? t('chat.proxyRunning') : t('chat.proxyNotRunning')}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                proxyRunning ? 'bg-emerald-500' : 'bg-red-500'
              )}
            />
            {proxyRunning ? t('chat.proxyRunning') : t('chat.proxyNotRunning')}
          </button>

          {/* Right: model selector + send/stop */}
          <div className="flex items-center gap-2 min-w-0">
            {isStreaming ? (
              <span className="text-xs text-muted-foreground animate-pulse flex-shrink-0">
                {t('chat.generating')}
              </span>
            ) : null}
            <ModelSelector
              models={models}
              value={selectedModel}
              onChange={onModelChange}
              disabled={isStreaming}
              compact
            />
            {isStreaming ? (
              <button
                onClick={onStop}
                className="flex-shrink-0 h-9 w-9 rounded-full bg-destructive/15 border border-destructive/30 flex items-center justify-center hover:bg-destructive/25 transition-colors"
                title={t('chat.stop')}
              >
                <Square className="h-4 w-4 text-destructive fill-destructive" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={disabled || !value.trim()}
                className={cn(
                  'flex-shrink-0 h-9 w-9 rounded-full flex items-center justify-center transition-colors',
                  disabled || !value.trim()
                    ? 'bg-white/5 text-muted-foreground/50 cursor-not-allowed'
                    : 'bg-blue-500 text-white hover:bg-blue-600'
                )}
                title={t('chat.send')}
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
