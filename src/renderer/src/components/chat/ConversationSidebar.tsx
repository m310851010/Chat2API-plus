import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Download, GitFork, Loader2, MessageSquare, Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { Conversation } from '@/stores/chatStore'

interface ConversationSidebarProps {
  conversations: Conversation[]
  activeId: string | null
  streamingIds?: string[]
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onFork: (id: string) => void
}

function groupConversations(conversations: Conversation[]): { label: string; items: Conversation[] }[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000
  const startOf7Days = startOfToday - 6 * 24 * 60 * 60 * 1000
  const startOf30Days = startOfToday - 29 * 24 * 60 * 60 * 1000

  const groups: Record<string, Conversation[]> = {
    today: [],
    yesterday: [],
    last7: [],
    last30: [],
    earlier: [],
  }

  for (const conversation of conversations) {
    const time = conversation.updatedAt
    if (time >= startOfToday) {
      groups.today.push(conversation)
    } else if (time >= startOfYesterday) {
      groups.yesterday.push(conversation)
    } else if (time >= startOf7Days) {
      groups.last7.push(conversation)
    } else if (time >= startOf30Days) {
      groups.last30.push(conversation)
    } else {
      groups.earlier.push(conversation)
    }
  }

  return [
    { label: 'today', items: groups.today },
    { label: 'yesterday', items: groups.yesterday },
    { label: 'last7', items: groups.last7 },
    { label: 'last30', items: groups.last30 },
    { label: 'earlier', items: groups.earlier },
  ].filter((g) => g.items.length > 0)
}

function conversationToMarkdown(conversation: Conversation, assistantLabel: string, userLabel: string, thinkingLabel: string): string {
  const lines: string[] = []
  lines.push(`# ${conversation.title || assistantLabel}`)
  lines.push('')
  lines.push(`> ${new Date(conversation.createdAt).toLocaleString()}${conversation.model ? ` · ${conversation.model}` : ''}`)
  lines.push('')

  for (const message of conversation.messages) {
    const speaker = message.role === 'user'
      ? userLabel
      : message.model || assistantLabel
    lines.push(`## ${speaker}`)
    lines.push('')
    if (message.reasoning) {
      lines.push(`> **${thinkingLabel}:**`)
      for (const line of message.reasoning.split('\n')) {
        lines.push(`> ${line}`)
      }
      lines.push('')
    }
    lines.push(message.content)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

async function exportMarkdownFile(filename: string, content: string): Promise<void> {
  const api = window.electronAPI?.app
  if (api?.saveTextFile) {
    await api.saveTextFile(filename, content)
    return
  }
  downloadMarkdown(filename, content)
}

function sanitizeFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\n\r]/g, '_').trim()
  return (cleaned || 'chat').slice(0, 50)
}

export function ConversationSidebar({
  conversations,
  activeId,
  streamingIds = [],
  onSelect,
  onNew,
  onDelete,
  onRename,
  onFork,
}: ConversationSidebarProps) {
  const { t } = useTranslation()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  const groups = groupConversations(sorted)

  useEffect(() => {
    if (renamingId) {
      requestAnimationFrame(() => renameInputRef.current?.focus())
    }
  }, [renamingId])

  const startRename = (conversation: Conversation) => {
    setDraftTitle(conversation.title || '')
    setRenamingId(conversation.id)
  }

  const commitRename = () => {
    if (renamingId) {
      const title = draftTitle.trim()
      if (title) {
        onRename(renamingId, title)
      }
    }
    setRenamingId(null)
  }

  const copyTitle = async (conversation: Conversation) => {
    try {
      await navigator.clipboard.writeText(conversation.title || t('chat.untitled'))
    } catch (error) {
      console.error('Failed to copy title:', error)
    }
  }

  const exportMarkdown = async (conversation: Conversation) => {
    const md = conversationToMarkdown(
      conversation,
      t('chat.assistant'),
      t('chat.you'),
      t('chat.thinking')
    )
    try {
      await exportMarkdownFile(`${sanitizeFilename(conversation.title || t('chat.untitled'))}.md`, md)
    } catch (error) {
      console.error('Failed to export conversation:', error)
    }
  }

  const confirmDelete = () => {
    if (deleteTarget) {
      onDelete(deleteTarget.id)
    }
    setDeleteTarget(null)
  }

  const groupKeyByLabel: Record<string, string> = {
    today: 'chat.groupToday',
    yesterday: 'chat.groupYesterday',
    last7: 'chat.groupLast7',
    last30: 'chat.groupLast30',
    earlier: 'chat.groupEarlier',
  }

  const renderMenuItem = (conversation: Conversation) => (
    <ContextMenu key={conversation.id} onOpenChange={(open) => { if (open) onSelect(conversation.id) }}>
      <ContextMenuTrigger asChild>
        <div
          onClick={() => onSelect(conversation.id)}
          className={cn(
            'group flex items-center gap-1 px-2 py-2 rounded-lg cursor-pointer text-sm transition-colors',
            conversation.id === activeId
              ? 'bg-[var(--glass-bg-hover)] border border-[var(--glass-border-hover)]'
              : 'border border-transparent hover:bg-[var(--glass-bg-hover)]'
          )}
        >
          {streamingIds.includes(conversation.id) ? (
            <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-emerald-500" />
          ) : (
            <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          )}
          {renamingId === conversation.id ? (
            <input
              ref={renameInputRef}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setRenamingId(null)
                }
              }}
              className="flex-1 min-w-0 bg-transparent outline-none text-sm underline underline-offset-2"
            />
          ) : (
            <span className="flex-1 truncate" title={conversation.title || t('chat.untitled')}>
              {conversation.title || t('chat.untitled')}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-max min-w-40">
        <ContextMenuItem onSelect={() => startRename(conversation)}>
          <Pencil className="opacity-70" />
          {t('chat.renameConversation')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyTitle(conversation)}>
          <Copy className="opacity-70" />
          {t('chat.copyTitle')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onFork(conversation.id)}>
          <GitFork className="opacity-70" />
          {t('chat.forkConversation')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void exportMarkdown(conversation)}>
          <Download className="opacity-70" />
          {t('chat.exportMarkdown')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-red-500 focus:text-red-500"
          onSelect={() => setDeleteTarget(conversation)}
        >
          <Trash2 className="opacity-70" />
          {t('chat.deleteConversation')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )

  return (
    <div className="glass-card flex flex-col h-full w-64 flex-shrink-0 overflow-hidden rounded-xl">
      <div className="p-3">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-[var(--glass-bg-hover)] border border-[var(--glass-border)] hover:border-[var(--glass-border-hover)] transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t('chat.newChat')}
        </button>
      </div>

      <div className="px-3 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {t('chat.history')}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground px-4">
            <MessageSquare className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-xs">{t('chat.noHistory')}</p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <div className="px-2 py-1 text-xs text-muted-foreground">
                {t(groupKeyByLabel[group.label])}
              </div>
              {group.items.map(renderMenuItem)}
            </div>
          ))
        )}
      </div>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('chat.deleteConversation')}</DialogTitle>
            <DialogDescription>{t('chat.deleteConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
