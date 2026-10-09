/** One row of `flowition runs --json`. */
export type FlowitionCockpitRun = {
  runId: string
  state: string
  file: string
  createdAt: number
}

/** One agent or step of a run, trimmed from `flowition status --json`. */
export type FlowitionCockpitWorker = {
  id: string
  kind: 'agent' | 'step'
  index: number | null
  label: string
  adapter: string | null
  model: string | null
  effort: string | null
  state: string
  durationMs: number | null
  lastAt: number | null
  tool: string | null
  outputTokens: number | null
  cost: number | null
  error: string | null
  phase: string | null
  phaseIndex: number | null
}

export type FlowitionCockpitQuestion = { qid: string; question: string }

/** A run's detail, trimmed from `flowition status --json`. */
export type FlowitionCockpitDetail = {
  runId: string
  state: string
  phases: string[]
  workers: FlowitionCockpitWorker[]
  questions: FlowitionCockpitQuestion[]
  spentOutputTokens: number | null
  cost: number | null
  /** The completed result, rendered as Markdown (capped). */
  resultMarkdown: string | null
  error: string | null
  fetchedAt: number
}

/** One record of an agent's transcript (`agents/<n>.jsonl`), trimmed for drawing. */
export type FlowitionCockpitEvent = {
  seq: number
  t: number
  /** meta, text, reasoning, tool, tool-result, mail-in, mail-out, status, attempt, raw */
  kind: string
  text: string | null
  name: string | null
  /** A tool call's input in one line: its command, query, path or URL. */
  summary: string | null
  input: string | null
  output: string | null
  isError: boolean
  toolId: string | null
  toolUseId: string | null
  redacted: boolean
  attempt: number | null
}

/** The tail of one agent's transcript, read incrementally by byte offset. */
export type FlowitionCockpitThread = {
  runId: string
  index: number
  /** Bytes of the file read through its last complete line. */
  consumed: number
  /** Older records exist than `events` holds. */
  isPartial: boolean
  events: FlowitionCockpitEvent[]
  fetchedAt: number
}

/** One step of where an agent or step sits in the run's fan-outs, as its events say. */
export type FlowitionCockpitPathSeg = {
  /** `parallel` or `pipeline` (a fan-out), `item` (one of its items), `stage` (a pipeline stage). */
  kind: string
  ordinal: number | null
  count: number | null
  stages: number | null
  i: number | null
  s: number | null
}

/** One line of the run's narrative: a log() line, a message, a question, an agent's start or end. */
export type FlowitionCockpitLogEntry = {
  t: number
  kind: 'log' | 'mail-in' | 'mail-out' | 'question' | 'answer' | 'phase' | 'run' | 'agent'
  text: string
  agent: number | null
  tone: 'error' | 'warning' | 'success' | 'suggestion' | 'inactive' | null
}

/** A workflow file under ~/.flowition/workflows, for starting a run from the pane. */
export type FlowitionCockpitWorkflowFile = { path: string; project: string; name: string; mtimeMs: number }

/** One agent or step on the timeline: the times the run's events recorded for it. */
export type FlowitionCockpitLane = {
  id: string
  kind: 'agent' | 'step'
  index: number | null
  label: string
  adapter: string | null
  state: string
  phaseIndex: number | null
  queuedAt: number | null
  startedAt: number | null
  endedAt: number | null
  /** The last time any of its (non-progress) events was recorded. */
  lastSeenAt: number
  path: FlowitionCockpitPathSeg[]
  /** Spend over every attempt: each attempt's final event carries that attempt's usage. */
  cost: number
  outputTokens: number
}

/** A run's timeline and phases, folded from `events.jsonl` (its progress lines skipped). */
export type FlowitionCockpitTimeline = {
  runId: string
  /** Bytes of `events.jsonl` folded in so far, through its last complete line. */
  consumed: number
  /** The file's size at the last read: while `consumed` is behind it, more is to come. */
  total: number
  startedAt: number | null
  endedAt: number | null
  /** `meta.phases`, as the run declared them. */
  declaredPhases: string[]
  /** The `phase()` calls the run made: their index, title and time. */
  phases: { index: number; title: string; t: number }[]
  lanes: FlowitionCockpitLane[]
  /** The workflow file the run executes (what a resume re-runs). */
  workflowFile: string | null
  /** The run's narrative, oldest first: the newest MAX_ENTRIES of it. */
  entries: FlowitionCockpitLogEntry[]
  isEntriesCut: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'flowition-cockpit': {
      runs: FlowitionCockpitRun[]
      details: Record<string, FlowitionCockpitDetail>
      selected: string | null
      attached: string[]
      error: string | null
      /** Runs whose end submits a prompt so Claude reads the result. */
      wake: string[]
      /** The agent whose steer field is open: `<runId>:<index>`. */
      steering: string | null
      /** The destructive action awaiting a second press: `cancel:<runId>[:<index>]`. */
      confirm: string | null
      recentLimit: number
      /** The agent whose thread is open, by index, within the selected run. */
      agentView: number | null
      thread: FlowitionCockpitThread | null
      /** Thread rows opened to show their full input and output, by key. */
      expanded: string[]
      /** Keep the thread scrolled to its newest event. */
      follow: boolean
      /** Which view of a run shows below its header. */
      runTab: 'agents' | 'timeline' | 'phases' | 'log' | 'structure'
      timeline: FlowitionCockpitTimeline | null
      /** The run list's filter and search. */
      listFilter: 'all' | 'live' | 'attention' | 'completed'
      listQuery: string
      /** Recent's folded groups of repeated runs that are open, by group key. */
      openGroups: string[]
      /** The new-run form, while it shows: the chosen workflow and its args. */
      launch: { file: string | null; args: string; error: string | null; query: string; limit: number } | null
      workflows: FlowitionCockpitWorkflowFile[]
    }
  }
}
