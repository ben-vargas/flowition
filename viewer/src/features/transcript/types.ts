import type { TranscriptItem as StoredTranscriptItem } from '../../state/transcriptStore.js'

export type TranscriptRecord = Record<string, unknown>
export type SourceRecord = StoredTranscriptItem

export interface TimelineBase {
  id: string
  t: number | null
  o: number
  attempt: number
}

export interface PromptItem extends TimelineBase {
  kind: 'prompt'
  text: string
  truncated: boolean
}

export interface TextItem extends TimelineBase {
  kind: 'text'
  text: string
}

export interface ReasoningItem extends TimelineBase {
  kind: 'reasoning'
  text: string
}

export interface ToolResult {
  text: string
  isError: boolean
  t: number | null
  exitCode: number | null
}

export type FileAction = 'created' | 'deleted' | 'renamed' | 'edited'

export interface FileChange {
  action: FileAction
  path: string
  movePath: string | null
  diff: string | null
  additions: number
  deletions: number
}

export interface ToolItem extends TimelineBase {
  kind: 'tool'
  card: 'terminal' | 'file' | 'generic'
  name: string
  input: unknown
  inputText: string
  toolId: string | null
  result: ToolResult | null
  approximate: boolean
  command: string | null
  files: FileChange[]
}

export interface OrphanResultItem extends TimelineBase {
  kind: 'orphan-result'
  name: string
  result: ToolResult
  toolUseId: string | null
}

export interface MailItem extends TimelineBase {
  kind: 'mail'
  direction: 'in' | 'out'
  text: string
  origin: string | null
  delivery: string | null
}

export interface StatusItem extends TimelineBase {
  kind: 'status'
  text: string
}

export interface RawItem extends TimelineBase {
  kind: 'raw'
  lines: string[]
}

export interface UnknownItem extends TimelineBase {
  kind: 'unknown'
  value: TranscriptRecord
}

export interface AttemptItem extends TimelineBase {
  kind: 'attempt'
  approximate: boolean
}

export type TimelineItem =
  | PromptItem
  | TextItem
  | ReasoningItem
  | ToolItem
  | OrphanResultItem
  | MailItem
  | StatusItem
  | RawItem
  | UnknownItem
  | AttemptItem

export interface AttemptSegment {
  n: number
  approximate: boolean
  firstOffset: number
  lastOffset: number
}

export interface TranscriptProjection {
  items: TimelineItem[]
  attempts: AttemptSegment[]
}

export interface StepUnit {
  kind: 'step'
  id: string
  items: (ToolItem | OrphanResultItem)[]
  t: number | null
  attempt: number
  pending: boolean
}

export interface RowUnit {
  kind: 'row'
  id: string
  item: Exclude<TimelineItem, ToolItem | OrphanResultItem>
  t: number | null
  attempt: number
}

export type TimelineUnit = StepUnit | RowUnit
