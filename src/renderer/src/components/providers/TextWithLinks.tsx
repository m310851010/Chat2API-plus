import React from 'react'

const URL_PATTERN = /https?:\/\/[^\s，。、)）\]】"'<]+/g

interface TextWithLinksProps {
  text: string
  className?: string
}

export function TextWithLinks({ text, className }: TextWithLinksProps) {
  const parts: Array<{ type: 'text' | 'url'; value: string }> = []
  let lastIndex = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, index) })
    }
    parts.push({ type: 'url', value: match[0] })
    lastIndex = index + match[0].length
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) })
  }

  const openExternal = (url: string) => {
    if (window.electronAPI?.app?.openExternal) {
      window.electronAPI.app.openExternal(url)
    } else {
      window.open(url, '_blank')
    }
  }

  return (
    <p className={className}>
      {parts.map((part, index) =>
        part.type === 'text' ? (
          <React.Fragment key={index}>{part.value}</React.Fragment>
        ) : (
          <a
            key={index}
            href={part.value}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-primary"
            onClick={(e) => {
              e.preventDefault()
              openExternal(part.value)
            }}
          >
            {part.value}
          </a>
        )
      )}
    </p>
  )
}

export default TextWithLinks
