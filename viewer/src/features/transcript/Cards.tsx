import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'

import { Ansi } from '../../lib/ansi.js'
import { HardenedMarkdown } from '../../lib/markdown.js'
import { Icon } from '../../ui/Icon.js'
import { ScrollFadeDiv, ScrollFadePre } from '../../ui/ScrollFade.js'
import type {
  FileChange,
  MailItem,
  OrphanResultItem,
  PromptItem,
  RawItem,
  ReasoningItem,
  StatusItem,
  ToolItem,
  UnknownItem,
} from './types.js'

export interface ToggleProps {
  expanded: boolean
  onExpanded(next: boolean): void
}

const DISCLOSURE_MS = 160

/**
 * Collapsed content is not mounted. Opening mounts at 0fr/opacity 0, then flips open on
 * the next frame; closing retains the body through the inverse §3.4 transition.
 */
export function DisclosureBody(
  { expanded, className = '', children }: {
    expanded: boolean
    className?: string
    children: ReactNode
  },
) {
  const [render, setRender] = useState(expanded)
  const [opened, setOpened] = useState(expanded)
  const previous = useRef(expanded)
  useEffect(() => {
    const wasExpanded = previous.current
    previous.current = expanded
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (expanded) {
      setRender(true)
      if (wasExpanded || reduced) {
        setOpened(true)
        return
      }
      setOpened(false)
      const frame = window.requestAnimationFrame(() => setOpened(true))
      return () => window.cancelAnimationFrame(frame)
    }
    setOpened(false)
    if (!render) return
    if (reduced) {
      setRender(false)
      return
    }
    const timer = window.setTimeout(() => setRender(false), DISCLOSURE_MS)
    return () => window.clearTimeout(timer)
  }, [expanded])

  if (!render) return null
  return (
    <div
      className={`collapse-body${className ? ` ${className}` : ''}${opened ? ' open' : ''}`}
      onTransitionEnd={(event) => {
        if (!expanded && event.target === event.currentTarget) setRender(false)
      }}
    >
      {children}
    </div>
  )
}

const copy = (value: string) => { void navigator.clipboard?.writeText(value) }

export function PromptCard(
  { item, oldMayBeTruncated, expanded, onExpanded }: {
    item: PromptItem
    oldMayBeTruncated: boolean
  } & ToggleProps,
) {
  return (
    <section className="prompt-block">
      <div className="ph">
        <Icon name="tool" size={14} className="dim" />
        <span className="lbl">prompt</span>
        <span className="dim micro mono">{item.text.length.toLocaleString()} chars</span>
        <span className="right">
          <button className="btn sm ghost" type="button" onClick={() => copy(item.text)}>
            <Icon name="copy" size={12} />Copy
          </button>
          <button className="btn sm" type="button" onClick={() => onExpanded(!expanded)}>
            <Icon name="chevdown" size={12} />{expanded ? 'Collapse' : 'Expand'}
          </button>
        </span>
      </div>
      <pre className={`pb${expanded ? ' open' : ''}`}>{item.text}</pre>
      <div className="pf">
        <Icon name={item.truncated || oldMayBeTruncated ? 'unknown' : 'check'} size={12} />
        {item.truncated
          ? 'prompt capped at 32 KiB; the omitted character count is recorded above'
          : oldMayBeTruncated
            ? 'recorded by an older engine — may be truncated at 4,000 characters'
            : 'full prompt recorded'}
      </div>
    </section>
  )
}

export function ReasoningCard({ item, expanded, onExpanded }: { item: ReasoningItem } & ToggleProps) {
  const lines = lineCount(item.text)
  const preview = item.text.replaceAll('\n', ' ').trim()
  if (!preview) {
    // The model DID reason here — the row stays for the honest record (and it still
    // drives the Thinking… indicator) — but there is nothing to expand, so no
    // disclosure. The wording tracks what the transcript actually attests: an
    // engine-marked {redacted:true} record is an observed CLI redaction (Claude Code
    // ≥2.1 headless withholds thinking as signature-only blocks); an unmarked empty
    // record (pre-marker journals) has no recorded cause, so no cause is claimed.
    return (
      <section className="reason redacted">
        <div className="reason-h">
          <Icon name="reasoning" size={14} className="dim" />
          <span className="lbl">reasoning</span>
          <span className="prev trunc">
            {item.redacted ? 'text withheld by the CLI' : 'no reasoning text recorded'}
          </span>
        </div>
      </section>
    )
  }
  return (
    <section className="reason">
      <button
        className="reason-h"
        type="button"
        aria-expanded={expanded}
        onClick={() => onExpanded(!expanded)}
      >
        <Icon name="reasoning" size={14} className="dim" />
        <span className="lbl">reasoning</span>
        <span className="prev trunc">{preview}</span>
        <span className="dim micro mono">{lines} {lines === 1 ? 'line' : 'lines'}</span>
        <Icon name="chevron" className="chev" />
      </button>
      <DisclosureBody expanded={expanded}>
        <div><HardenedMarkdown source={item.text} /></div>
      </DisclosureBody>
    </section>
  )
}

function lineCount(value: string): number {
  let lines = 1
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) lines++
  return lines
}

function selectedText(): boolean {
  const selection = window.getSelection?.()
  return Boolean(selection && !selection.isCollapsed && String(selection))
}

export function TerminalCard({ item, expanded, onExpanded }: { item: ToolItem } & ToggleProps) {
  const command = item.command ?? item.inputText
  const output = item.result?.text ?? ''
  const suppressClick = useRef(false)
  const onHeaderMouseUp = (_event: MouseEvent<HTMLButtonElement>) => {
    suppressClick.current = selectedText()
  }
  return (
    <section className="well" data-pending={item.result == null || undefined}>
      <button
        type="button"
        className="well-h"
        aria-expanded={expanded}
        onMouseUp={onHeaderMouseUp}
        onClick={() => {
          if (suppressClick.current || selectedText()) {
            suppressClick.current = false
            return
          }
          onExpanded(!expanded)
        }}
      >
        <Icon name="terminal" size={14} />
        <span className={`cmd${expanded ? ' open' : ''}`}>{command}</span>
        <span className="right">
          {item.approximate ? <span className="badge warn">approximate pair</span> : null}
          {item.toolId ? <span className="pairid">id {shortId(item.toolId)}</span> : null}
        </span>
      </button>
      <DisclosureBody expanded={expanded}>
        <ScrollFadePre className="well-b" surface="well"><Ansi text={output} /></ScrollFadePre>
      </DisclosureBody>
      {item.result ? (
        <div className="well-f">
          {item.result.isError ? <Icon name="close" size={12} /> : <Icon name="check" size={12} />}
          {item.result.exitCode != null
            ? <span className="ec">exit code {item.result.exitCode}</span>
            : <span>{item.result.isError ? 'command reported an error' : 'completed'}</span>}
        </div>
      ) : <div className="well-f"><span>running…</span></div>}
    </section>
  )
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 7)}…${value.slice(-4)}`
}

function displayValue(value: unknown): ReactNode {
  if (value == null) return <span className="v">null</span>
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span className="v">{String(value)}</span>
  }
  let text: string
  try { text = JSON.stringify(value, null, 2) } catch { text = String(value) }
  return <pre>{text}</pre>
}

function inputRows(item: ToolItem): ReactNode {
  if (!item.input || typeof item.input !== 'object' || Array.isArray(item.input)) {
    return <pre>{item.inputText}</pre>
  }
  return Object.entries(item.input as Record<string, unknown>).map(([key, value]) => (
    <div className="a" key={key}><span className="k">{key}</span>{displayValue(value)}</div>
  ))
}

export function GenericToolCard({ item, expanded, onExpanded }: { item: ToolItem } & ToggleProps) {
  const long = item.inputText.length > 240 || lineCount(item.inputText) > 3
  return (
    <section className={`tcard${item.result?.isError ? ' err' : ''}`}>
      <div className="tcard-h">
        <Icon name="tool" size={14} className="dim" />
        <span className="tn">{item.name}</span>
        <span className="right">
          {item.approximate ? <span className="badge warn">approximate pair</span> : null}
          {item.toolId ? <span className="pairid">id {shortId(item.toolId)}</span> : null}
        </span>
      </div>
      <div className={`args${long && !expanded ? ' clamp3' : ''}`}>{inputRows(item)}</div>
      {long ? (
        <button type="button" className="showmore" onClick={() => onExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
      {item.result ? (
        <div className="tres">
          <div className="tres-h">
            <Icon name={item.result.isError ? 'close' : 'check'} size={12} />
            {item.result.isError ? 'error' : 'result'}
          </div>
          <ScrollFadePre className="tres-b">{item.result.text}</ScrollFadePre>
        </div>
      ) : <div className="tres"><div className="tres-h">pending</div></div>}
    </section>
  )
}

function actionIcon(action: FileChange['action']) {
  if (action === 'created') return 'filenew' as const
  if (action === 'deleted') return 'filedel' as const
  if (action === 'renamed') return 'filemove' as const
  return 'fileedit' as const
}

function diffLines(diff: string) {
  return diff.split('\n').map((line, index) => {
    const kind = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')
      || line.startsWith('diff ') || line.startsWith('index ')
      ? 'hunk'
      : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''
    return (
      <div className={`dl ${kind}`} key={index}>
        <span className="ln">{index + 1}</span>
        <span className="tx">{line}</span>
      </div>
    )
  })
}

export function FileChangeCard(
  { item, expanded, onExpanded, manual, onManual }: {
    item: ToolItem
    manual?: Record<string, boolean>
    onManual?(id: string, expanded: boolean): void
  } & ToggleProps,
) {
  const files = item.files.length ? item.files : [{
    action: 'edited' as const,
    path: '(unknown path)',
    movePath: null,
    diff: null,
    additions: 0,
    deletions: 0,
  }]
  return (
    <section className="fcard">
      {files.map((file, index) => {
        const rowId = `${item.id}:file:${index}`
        const rowExpanded = manual?.[rowId] ?? expanded
        return (
          <div className="fentry" key={`${file.path}:${index}`}>
            <button
              type="button"
              className="frow"
              aria-expanded={rowExpanded}
              onClick={() => {
                if (onManual) onManual(rowId, !rowExpanded)
                else onExpanded(!rowExpanded)
              }}
            >
              <Icon name={actionIcon(file.action)} size={14} />
              <span className="path">
                <span className="verb">{file.action}</span>{' '}
                <b>{file.path}</b>{file.movePath ? <> → <b>{file.movePath}</b></> : null}
              </span>
              <span className="stat"><span className="add">+{file.additions}</span><span className="del">−{file.deletions}</span></span>
              <Icon name="chevron" className="chev" />
            </button>
            <DisclosureBody expanded={rowExpanded}>
              <div>
                {file.diff
                  ? <ScrollFadeDiv className="fdiff">{diffLines(file.diff)}</ScrollFadeDiv>
                  : <div className="nodiff">no diff available</div>}
              </div>
            </DisclosureBody>
          </div>
        )
      })}
      {item.result?.isError ? <div className="nodiff err">tool error: {item.result.text}</div> : null}
    </section>
  )
}

export function ToolCard(
  props: {
    item: ToolItem
    manual?: Record<string, boolean>
    onManual?(id: string, expanded: boolean): void
  } & ToggleProps,
) {
  if (props.item.card === 'terminal') return <TerminalCard item={props.item} expanded={props.expanded} onExpanded={props.onExpanded} />
  if (props.item.card === 'file') return <FileChangeCard {...props} />
  return <GenericToolCard item={props.item} expanded={props.expanded} onExpanded={props.onExpanded} />
}

export function OrphanResultCard({ item }: { item: OrphanResultItem }) {
  return (
    <section className={`tcard${item.result.isError ? ' err' : ''}`}>
      <div className="tcard-h">
        <Icon name="tool" size={14} />
        <span className="tn">{item.name}</span>
        <span className="right"><span className="badge warn">orphan result</span></span>
      </div>
      <div className="tres"><ScrollFadePre className="tres-b">{item.result.text}</ScrollFadePre></div>
    </section>
  )
}

export function MailMarker({ item }: { item: MailItem }) {
  return (
    <div className="marker">
      <Icon name={item.direction === 'in' ? 'mail' : 'send'} size={14} />
      <span><b>{item.direction === 'in' ? 'steer received' : 'posted to workflow'}</b> {item.text}</span>
      <span className="right">
        {item.origin ? <span className="badge">{item.origin}</span> : null}
        {item.delivery ? <span className={`verdict ${item.delivery}`}>{item.delivery}</span> : null}
      </span>
    </div>
  )
}

export function StatusLine({ item }: { item: StatusItem }) {
  return <div className="sysline">{item.text}</div>
}

export function RawGroup({ item, expanded, onExpanded }: { item: RawItem } & ToggleProps) {
  return (
    <section className="rawgrp-wrap">
      <button type="button" className="rawtoggle" aria-expanded={expanded} onClick={() => onExpanded(!expanded)}>
        <Icon name="unknown" size={12} />
        {item.lines.length} unparsed provider {item.lines.length === 1 ? 'line' : 'lines'}
      </button>
      <DisclosureBody expanded={expanded}>
        <ScrollFadePre>{item.lines.join('\n')}</ScrollFadePre>
      </DisclosureBody>
    </section>
  )
}

export function UnknownRow({ item, expanded, onExpanded }: { item: UnknownItem } & ToggleProps) {
  const json = useMemo(() => {
    try { return JSON.stringify(item.value, null, 2) } catch { return String(item.value) }
  }, [item.value])
  return (
    <section className="rawgrp-wrap">
      <button type="button" className="rawtoggle" aria-expanded={expanded} onClick={() => onExpanded(!expanded)}>
        <Icon name="unknown" size={12} />unknown transcript kind — newer engine?
      </button>
      <DisclosureBody expanded={expanded}><ScrollFadePre>{json}</ScrollFadePre></DisclosureBody>
    </section>
  )
}
