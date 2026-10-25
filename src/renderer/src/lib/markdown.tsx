import type { ReactNode } from 'react'

/**
 * Minimal Markdown renderer (no dependencies, no dangerouslySetInnerHTML)
 * Supports: fenced code blocks, headings, blockquote, lists, hr,
 * inline code, bold, italic, links, strikethrough
 */

interface CodeBlockData {
  language: string
  code: string
}

function parseSpans(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let key = 0
  const pattern = /(`[^`]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(__[^_]+__)|(_[^_\s][^_]*_)|(~~[^~]+~~)|(!?\[[^\]]*\]\([^)]+\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(
        <code key={key++} className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 text-[0.85em] font-mono break-all">
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('~~~')) {
      nodes.push(<s key={key++}>{token.slice(3, -3)}</s>)
    } else if (token.startsWith('~~')) {
      nodes.push(<s key={key++}>{token.slice(2, -2)}</s>)
    } else if (token.startsWith('***')) {
      nodes.push(
        <strong key={key++} className="font-semibold italic">
          {token.slice(3, -3)}
        </strong>
      )
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(
        <strong key={key++} className="font-semibold">
          {token.slice(2, -2)}
        </strong>
      )
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(
        <em key={key++}>{token.slice(1, -1)}</em>
      )
    } else {
      const linkMatch = token.match(/^(!?)\[([^\]]*)\]\(([^)]+)\)$/)
      if (linkMatch) {
        const isImage = linkMatch[1] === '!'
        const label = linkMatch[2]
        const href = linkMatch[3]
        if (isImage) {
          nodes.push(<img key={key++} src={href} alt={label} className="max-w-full rounded-md my-1" />)
        } else {
          nodes.push(
            <a
              key={key++}
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-500 hover:text-blue-600 underline break-all"
            >
              {label || href}
            </a>
          )
        }
      } else {
        nodes.push(token)
      }
    }
    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}

function renderInline(text: string): ReactNode[] {
  return parseSpans(text)
}

function CodeBlock({ language, code }: CodeBlockData) {
  return (
    <div className="my-2 rounded-lg overflow-hidden border border-[var(--glass-border)] bg-[var(--bg-secondary)]">
      {language ? (
        <div className="px-3 py-1.5 text-xs font-mono text-muted-foreground border-b border-[var(--glass-border)]">
          {language}
        </div>
      ) : null}
      <pre className="p-3 text-sm font-mono leading-relaxed whitespace-pre-wrap break-all">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function splitFencedBlocks(text: string): Array<{ type: 'code'; data: CodeBlockData } | { type: 'text'; data: string }> {
  const parts: Array<{ type: 'code'; data: CodeBlockData } | { type: 'text'; data: string }> = []
  const fenceRegex = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = fenceRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', data: text.slice(lastIndex, match.index) })
    }
    const code = match[2].replace(/\n$/, '')
    parts.push({ type: 'code', data: { language: match[1].trim(), code } })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', data: text.slice(lastIndex) })
  }

  return parts
}

function renderTextBlock(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let key = 0
  const lines = text.split('\n')
  let paragraph: string[] = []
  let listItems: string[] | null = null
  let listOrdered = false
  let blockquote: string[] = []

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      nodes.push(
        <p key={key++} className="my-1 whitespace-pre-wrap break-words leading-relaxed">
          {renderInline(paragraph.join('\n'))}
        </p>
      )
      paragraph = []
    }
  }

  const flushList = () => {
    if (listItems !== null) {
      const items = listItems.map((item, i) => (
        <li key={i} className="ml-0.5 leading-relaxed">
          {renderInline(item)}
        </li>
      ))
      nodes.push(
        listOrdered
          ? <ol key={key++} className="my-1 pl-5 list-decimal space-y-0.5">{items}</ol>
          : <ul key={key++} className="my-1 pl-5 list-disc space-y-0.5">{items}</ul>
      )
      listItems = null
    }
  }

  const flushBlockquote = () => {
    if (blockquote.length > 0) {
      nodes.push(
        <blockquote key={key++} className="my-1 pl-3 border-l-2 border-[var(--glass-border)] text-muted-foreground">
          {renderInline(blockquote.join('\n'))}
        </blockquote>
      )
      blockquote = []
    }
  }

  const flushAll = () => {
    flushParagraph()
    flushList()
    flushBlockquote()
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    const bulletMatch = line.match(/^\s{0,3}[-*+]\s+(.*)$/)
    const orderedMatch = line.match(/^\s{0,3}(\d+)[.)]\s+(.*)$/)
    const blockquoteMatch = line.match(/^\s{0,3}>\s?(.*)$/)

    if (blockquoteMatch) {
      flushParagraph()
      flushList()
      blockquote.push(blockquoteMatch[1])
      continue
    }

    flushBlockquote()

    if (/^\s{0,3}(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph()
      flushList()
      nodes.push(<hr key={key++} className="my-3 border-[var(--glass-border)]" />)
      continue
    }

    if (headingMatch) {
      flushParagraph()
      flushList()
      const level = headingMatch[1].length
      const sizes: Record<number, string> = {
        1: 'text-xl font-semibold mt-3 mb-1.5',
        2: 'text-lg font-semibold mt-3 mb-1.5',
        3: 'text-base font-semibold mt-2.5 mb-1',
        4: 'text-sm font-semibold mt-2 mb-1',
        5: 'text-sm mt-2 mb-1 font-semibold',
        6: 'text-sm mt-2 mb-1 font-semibold text-muted-foreground',
      }
      nodes.push(
        <div key={key++} className={sizes[level]}>
          {renderInline(headingMatch[2])}
        </div>
      )
      continue
    }

    if (bulletMatch) {
      flushParagraph()
      if (listItems === null || listOrdered) {
        flushList()
        listItems = []
        listOrdered = false
      }
      listItems.push(bulletMatch[1])
      continue
    }

    if (orderedMatch) {
      flushParagraph()
      if (listItems === null || !listOrdered) {
        flushList()
        listItems = []
        listOrdered = true
      }
      listItems.push(orderedMatch[2])
      continue
    }

    flushList()

    if (line.trim() === '') {
      flushParagraph()
    } else {
      paragraph.push(line)
    }
  }

  flushAll()
  return nodes
}

export function renderMarkdown(text: string): ReactNode {
  const parts = splitFencedBlocks(text)
  return parts.map((part, index) =>
    part.type === 'code' ? (
      <CodeBlock key={`code-${index}`} {...part.data} />
    ) : (
      <span key={`text-${index}`}>{renderTextBlock(part.data)}</span>
    )
  )
}
