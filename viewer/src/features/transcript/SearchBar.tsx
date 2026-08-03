import { useEffect, useRef, useState } from 'react'

import type { SearchResults } from '../../api/types.js'
import { Icon } from '../../ui/Icon.js'

export interface SearchBarProps {
  runId: string
  agent: number
  open: boolean
  search(
    runId: string,
    q: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<SearchResults>
  onClose(): void
  onMatch(offset: number): SearchNavigation
}

export type SearchNavigation = 'loaded' | 'before-window' | 'after-window' | 'other-attempt' | 'empty'

const SEARCH_LIMIT = 200

const navigationMessage = (result: SearchNavigation, offset: number): string | null => {
  if (result === 'loaded') return null
  if (result === 'before-window') return `match at byte ${offset} is before the loaded window — load older transcript data to show it`
  if (result === 'after-window') return `match at byte ${offset} is after the loaded window — jump to latest to show it`
  if (result === 'other-attempt') return `match at byte ${offset} is in another attempt — select that attempt to show it`
  return `match at byte ${offset} cannot be shown because no transcript window is loaded`
}

export function SearchBar({ runId, agent, open, search, onClose, onMatch }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [at, setAt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [navigation, setNavigation] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) input.current?.focus()
    else request.current?.abort()
    return () => request.current?.abort()
  }, [open])

  const matches = results?.matches.filter((match) => match.agent === agent) ?? []
  const noMatchesCopy = results?.truncated
    ? `no matches for agent ${agent} in the first ${SEARCH_LIMIT} results — the scan stopped early; narrow the query`
    : results && results.matches.length >= SEARCH_LIMIT
      ? `no matches for agent ${agent} in the first ${SEARCH_LIMIT} results — the result limit was reached; narrow the query`
      : `no matches in agent ${agent}`
  const select = (index: number) => {
    if (!matches.length) return
    const next = (index + matches.length) % matches.length
    setAt(next)
    const offset = matches[next]!.o
    setNavigation(navigationMessage(onMatch(offset), offset))
  }

  if (!open) return null
  return (
    <form
      className="transcript-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        const q = query.trim()
        if (q.length < 2 || q.length > 256) return
        request.current?.abort()
        const controller = new AbortController()
        request.current = controller
        setLoading(true)
        setError(null)
        setNavigation(null)
        void search(runId, q, { limit: SEARCH_LIMIT, signal: controller.signal }).then((next) => {
          if (controller.signal.aborted) return
          setResults(next)
          setAt(0)
          const first = next.matches.find((match) => match.agent === agent)
          if (first) setNavigation(navigationMessage(onMatch(first.o), first.o))
        }).catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(String((cause as Error)?.message ?? cause))
        }).finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
      }}
    >
      <Icon name="search" size={14} />
      <label className="vh" htmlFor={`transcript-search-${agent}`}>Search agent {agent} transcript</label>
      <input
        ref={input}
        id={`transcript-search-${agent}`}
        className="inp"
        value={query}
        maxLength={256}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="substring search in this transcript"
      />
      <button className="btn sm" type="submit" disabled={loading || query.trim().length < 2}>
        {loading ? 'Searching…' : 'Find'}
      </button>
      {matches.length ? (
        <>
          <span className="search-count">{at + 1}/{matches.length}{results?.truncated ? '+' : ''}</span>
          <button className="icb sm" type="button" aria-label="Previous match" onClick={() => select(at - 1)}>
            <Icon name="chevron" size={12} />
          </button>
          <button className="icb sm next" type="button" aria-label="Next match" onClick={() => select(at + 1)}>
            <Icon name="chevron" size={12} />
          </button>
          <span className="search-snippet">{matches[at]?.snippet}</span>
        </>
      ) : results && !loading ? <span className="search-count">{noMatchesCopy}</span> : null}
      {error ? <span className="search-error" role="alert">{error}</span> : null}
      {navigation ? <span className="search-error" role="status">{navigation}</span> : null}
      <button className="icb sm" type="button" aria-label="Close transcript search" onClick={onClose}>
        <Icon name="close" size={12} />
      </button>
    </form>
  )
}
