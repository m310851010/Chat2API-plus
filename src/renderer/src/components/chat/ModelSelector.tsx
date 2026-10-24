import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatModelOption } from '@/stores/chatStore'

interface ModelSelectorProps {
  models: ChatModelOption[]
  value: string | null
  onChange: (model: string) => void
  disabled?: boolean
  compact?: boolean
}

function groupModelsByProvider(models: ChatModelOption[]): { providerId: string; label: string; models: ChatModelOption[] }[] {
  const groups = new Map<string, ChatModelOption[]>()
  for (const model of models) {
    if (!groups.has(model.providerId)) {
      groups.set(model.providerId, [])
    }
    groups.get(model.providerId)!.push(model)
  }
  return Array.from(groups.entries()).map(([providerId, items]) => ({
    providerId,
    label: items[0]?.label.slice(items[0].label.indexOf(' (') + 2, -1) || providerId,
    models: items,
  }))
}

export function ModelSelector({ models, value, onChange, disabled, compact }: ModelSelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(() => models.find((m) => m.value === value) || null, [models, value])

  const groups = useMemo(() => {
    const all = groupModelsByProvider(models)
    if (!query.trim()) return all
    const q = query.trim().toLowerCase()
    return all
      .map((g) => ({
        ...g,
        models: g.models.filter(
          (m) => m.value.toLowerCase().includes(q) || m.providerId.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.models.length > 0)
  }, [models, query])

  const flatFiltered = useMemo(() => groups.flatMap((g) => g.models), [groups])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlight(0)
      // Focus robustly: rAF first, then a short retry in case the button click
      // or Electron re-grabs focus after mount
      requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }))
      const timer = setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 50)
      return () => clearTimeout(timer)
    }
  }, [open])

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const select = (model: ChatModelOption) => {
    onChange(model.value)
    setOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, Math.max(flatFiltered.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (flatFiltered[highlight]) select(flatFiltered[highlight])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={containerRef} className={cn('relative', compact ? 'min-w-0' : '')} onKeyDown={handleKeyDown}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        disabled={disabled || models.length === 0}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1 bg-transparent rounded-lg text-sm text-foreground',
          'hover:bg-white/5 dark:hover:bg-white/5 transition-colors min-w-0',
          compact ? 'h-7 px-2 max-w-[220px]' : 'h-8 px-2.5 w-[220px] sm:w-[280px]',
          (disabled || models.length === 0) && 'opacity-50 cursor-not-allowed'
        )}
        title={selected?.label || value || t('chat.selectModel')}
      >
        <span className="truncate flex-1 text-left">
          {selected ? selected.value : <span className="text-muted-foreground">{t('chat.selectModel')}</span>}
        </span>
      </button>

      {open ? (
        <div
          className="absolute bottom-full mb-2 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-hover)] backdrop-blur-xl shadow-lg overflow-hidden"
          style={{ right: 0 }}
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--glass-border)]">
            <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <input
              ref={searchRef}
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHighlight(0)
              }}
              placeholder={t('chat.searchModels')}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 min-w-0"
            />
          </div>

          <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
            {flatFiltered.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center whitespace-pre-wrap">
                {t('chat.noModels')}
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.providerId}>
                  <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </div>
                  {group.models.map((model) => {
                    const index = flatFiltered.indexOf(model)
                    const active = index === highlight
                    const isSelected = model.value === value
                    return (
                      <div
                        key={model.key}
                        data-active={active}
                        onMouseEnter={() => setHighlight(index)}
                        onClick={() => select(model)}
                        className={cn(
                          'mx-1 flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors',
                          active ? 'bg-white/10 dark:bg-white/5' : ''
                        )}
                      >
                        <Check
                          className={cn(
                            'h-3.5 w-3.5 flex-shrink-0 text-emerald-500',
                            isSelected ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className="truncate flex-1">{model.value}</span>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
