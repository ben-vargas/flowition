/**
 * §3.6's screen-reader clause, as pure logic.
 *
 * > "the transcript's live frontier is wrapped in an `aria-live=polite` region **throttled
 * > to one announcement per 5s** summarizing activity ("agent 3: running Bash") — never the
 * > raw stream"
 *
 * Three things follow from that sentence, and each is a function here:
 *
 *  1. **A summary, never the stream.** `frontierAnnouncement` reads the newest item and the
 *     agent's state and produces ONE short sentence drawn from a closed vocabulary. NO
 *     record's text is ever interpolated into it — not a `text` or `reasoning` item's
 *     body, not a `mail` item's, and not a `status` line's, which embeds the provider's
 *     error message or 200 characters of a steer (src/engine.js:1073,
 *     src/agent-proc.js:143, 528). Reading the stream aloud is the failure mode the clause
 *     names: a screen-reader user would be read a 5,000-record transcript — and, worse,
 *     whatever secret happened to land in it — which is worse than silence.
 *  2. **Throttled, and therefore lossy on purpose.** `throttleAnnouncements` keeps at most
 *     one announcement per window and keeps the LAST pending one, not the first — the
 *     operator wants to know what the agent is doing now, not what it was doing 5 s ago.
 *  3. **Silence is a state too.** A settled agent announces its terminal state exactly once
 *     and then says nothing, because a live region that keeps repeating is the same spam
 *     the throttle exists to prevent. Identical consecutive text is never re-announced —
 *     assistive tech only speaks a region whose content actually CHANGED, so equality is
 *     the mechanism, not a heuristic on top of one.
 */

import type { TimelineItem } from './types.js'

/** §3.6, verbatim: one announcement per 5 s. */
export const FRONTIER_THROTTLE_MS = 5_000

/**
 * The two ceilings that make "never the raw stream" structural rather than a promise.
 *
 * A closed vocabulary bounds the PHRASES, but two things in the sentence are still drawn
 * from data: the agent's name (`AgentView.label`, which is whatever string the workflow
 * author passed to `agent({label})` and reaches the viewer unmodified) and a tool's name
 * (`TimelineItem.name`, taken from the provider's own tool-call record). Either can be a
 * megabyte of arbitrary text, and interpolating one unbounded is reading the stream through
 * the same side door the status branch already closes.
 */
export const MAX_IDENTIFIER = 32
/** No sentence this module can produce exceeds this, on any branch, for any input. */
export const MAX_ANNOUNCEMENT = 80

/**
 * Clip to `max` UTF-16 units without ever splitting a surrogate pair — half an astral
 * character is not a character, and a screen reader given one reads a replacement glyph.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = max - 1
  const prev = text.charCodeAt(cut - 1)
  if (cut > 0 && prev >= 0xd800 && prev <= 0xdbff) cut -= 1
  return `${text.slice(0, cut)}…`
}

/**
 * The characters an announcement can never contain. C0/C1 controls and the Unicode
 * line/paragraph separators split one live-region sentence into several; the bidi
 * embeddings, overrides and isolates reorder what is left of it; the zero-width and
 * invisible-formatting characters change what is spoken without appearing in the text at
 * all. All three are ways for an agent label or a tool name to take over the SHAPE of the
 * summary, which this module owns and the data does not.
 */
function isUnspeakable(code: number): boolean {
  return code <= 0x1f                       // C0 controls, newline and tab among them
    || (code >= 0x7f && code <= 0x9f)       // DEL and the C1 controls
    || code === 0xad                        // soft hyphen
    || code === 0x61c                       // Arabic letter mark
    || code === 0x180e                      // Mongolian vowel separator
    || (code >= 0x200b && code <= 0x200f)   // zero-width space through the RTL mark
    || code === 0x2028 || code === 0x2029   // line and paragraph separators
    || (code >= 0x202a && code <= 0x202e)   // bidi embeddings and overrides
    || (code >= 0x2060 && code <= 0x2064)   // word joiner and the invisible operators
    || (code >= 0x2066 && code <= 0x2069)   // bidi isolates
    || code === 0xfeff                      // BOM / zero-width no-break space
    // A lone surrogate — the prefix cut below can land between the halves of an astral
    // character, and half of one is not a character.
    || (code >= 0xd800 && code <= 0xdfff)
}

/**
 * A data-derived identifier, made safe to speak: flattened to one line, stripped of the
 * characters above, collapsed on whitespace, and cut to `MAX_IDENTIFIER`. Only a bounded
 * PREFIX is ever examined, so a 64 KiB label costs a fixed amount of work per render rather
 * than a full scan of the record. An identifier that is empty once flattened is not an
 * identifier, so the caller's neutral word is used instead — a label of pure zero-width
 * characters must not silently produce "agent : running".
 */
export function speakableIdentifier(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  let flat = ''
  for (const ch of raw.slice(0, MAX_IDENTIFIER * 8)) {
    flat += isUnspeakable(ch.codePointAt(0)!) ? ' ' : ch
  }
  flat = flat.replace(/\s+/g, ' ').trim()
  return flat ? clip(flat, MAX_IDENTIFIER) : fallback
}

export interface FrontierInput {
  /** What the agent is called, as the rest of the UI names it ("agent 3", or its label). */
  agent: string
  /** `AgentView.displayState` — the state the header shows, orphan-folding included. */
  state: string
  /** Whether the run AND this agent are live; a dead run's agent is never "working". */
  live: boolean
  /** The newest projected item in the pane, or `null` before anything has arrived. */
  latest: TimelineItem | null
}

/**
 * The terminal halves of `AgentView.displayState` — `AgentState | 'orphaned'`
 * (src/viewer/fold.d.ts:114), minus the three states a settled agent cannot be in.
 */
const SETTLED_STATES: ReadonlySet<string> = new Set([
  'done', 'failed', 'cancelled', 'cached', 'orphaned', 'completed',
])

/**
 * The one sentence. `null` means "nothing worth saying" — the caller renders an empty
 * region, which is what keeps the region in the DOM (assistive tech watches a region that
 * already exists; one inserted along with its first message is unreliably announced).
 */
export function frontierAnnouncement(input: FrontierInput): string | null {
  const { state, live, latest } = input
  // EVERY dynamic part of the sentence goes through `speakableIdentifier` before it is
  // interpolated, and the finished sentence goes through `clip` after. The agent's name is
  // `AgentView.label` — an arbitrary string the workflow author chose — and a tool's name
  // comes from the provider's own record; neither is engine-authored, and an unbounded one
  // makes the announcement as long as the data, which is §3.6's "never the raw stream" lost
  // to a different branch than the one the status case guards.
  const agent = speakableIdentifier(input.agent, 'agent')
  const say = (rest: string) => clip(`${agent}: ${rest}`, MAX_ANNOUNCEMENT)
  if (!live) {
    // A settled agent has exactly one thing to say, and it is its outcome — and the outcome
    // comes from a closed vocabulary, not from the string. `displayState` is
    // `AgentState | 'orphaned'` (src/viewer/fold.d.ts:114), so a value outside that set is an
    // older or newer server's, and speaking it would make this the one branch where an
    // unrecognized string reaches the region verbatim. It says "settled" instead, which is
    // the only thing it actually knows.
    if (state === 'running' || state === 'queued' || state === 'starting') return null
    return say(SETTLED_STATES.has(state) ? state : 'settled')
  }
  if (!latest) return say('running')
  switch (latest.kind) {
    case 'tool':
      // The spec's own example: "agent 3: running Bash". A tool still waiting on its result
      // is the frontier; one that already has a result is the most recent thing that
      // happened, and both read the same way to someone who cannot see the spinner.
      return say(`running ${speakableIdentifier(latest.name, 'a tool')}`)
    case 'orphan-result':
      return say(`${speakableIdentifier(latest.name, 'a tool')} returned`)
    case 'reasoning':
      return say('thinking')
    case 'text':
      return say('writing')
    case 'prompt':
      return say('prompt sent')
    case 'mail':
      return say(latest.direction === 'in' ? 'steer received' : 'reported progress')
    case 'status':
      // "Engine-authored" is not the same as "safe to read aloud". Every status line the
      // engine writes CARRIES foreign text: `${status}: ${err.message}` (src/engine.js:1073)
      // and `'error: ' + e.message` (src/agent-proc.js:528) embed the provider's error
      // string, and the mail statuses embed 200 chars of the steer itself
      // (src/agent-proc.js:143, 161, 245). Interpolating any of it is reading the raw
      // stream through a side door, so the record's text only ever SELECTS a category —
      // it is never quoted.
      return say(statusActivity(latest.text))
    case 'attempt':
      return say('new attempt')
    default:
      return say('running')
  }
}

/**
 * The closed vocabulary of status activities, keyed by the prefix the engine writes. Each
 * entry cites the writer it summarizes; the tail of every one of those lines is provider
 * text or operator text and never reaches this function's output.
 *
 * Order matters only in that the first matching prefix wins, and the prefixes are disjoint.
 */
const STATUS_ACTIVITIES: readonly (readonly [string, string])[] = [
  ['completed', 'completed'],                                   // src/engine.js:1060
  ['cancelled:', 'cancelled'],                                  // src/engine.js:1073
  ['failed:', 'failed'],                                        // src/engine.js:1073
  ['error:', 'provider error'],                                 // src/agent-proc.js:528
  ['parser exception', 'output parse error'],                   // src/agent-proc.js:418, 432
  ['schema validation failed', 'retrying for a valid result'],  // src/agent-proc.js:221
  ['delivering', 'delivering queued steers'],                   // src/agent-proc.js:232
  ['mail dropped', 'steer dropped'],                            // src/agent-proc.js:161
  ['workflow mail replay-suppressed', 'steer already delivered'], // src/agent-proc.js:143
  ['— resumed run', 'new attempt'],                             // src/engine.js:994
]

/**
 * A status record's text → one phrase from a fixed set. Nothing about the return value
 * varies with the record's content beyond WHICH constant is chosen, so a status line
 * carrying a token, a stack trace, or a steer's body announces its category and nothing
 * else. An unrecognized line — a newer engine's, or an old run's — falls back to the
 * vaguest phrase rather than to its own text: §3.6's "never the raw stream" has no
 * exception for lines this build does not recognize.
 */
export function statusActivity(text: string): string {
  // A prefix suffices: the longest key below is 38 characters, and matching against a
  // bounded window keeps a hostile 50 MiB status line from costing a 50 MiB scan per render.
  const flat = String(text ?? '').slice(0, 128).replace(/\s+/g, ' ').trim().toLowerCase()
  // `mail DROPPED …` (src/agent-proc.js:245) differs from :161 only in case; lowering the
  // haystack once folds both onto the same prefix.
  for (const [prefix, activity] of STATUS_ACTIVITIES) {
    if (flat.startsWith(prefix)) return activity
  }
  return 'status update'
}

export interface ThrottleState {
  /** The text currently in the region. */
  announced: string
  /** When `announced` was last written, on the caller's clock. */
  at: number
  /** The newest text that has not been announced yet, if any. */
  pending: string | null
}

export const initialThrottle = (): ThrottleState => ({ announced: '', at: 0, pending: null })

export interface ThrottleStep {
  next: ThrottleState
  /** Milliseconds until the caller should step again, or `null` if nothing is waiting. */
  waitMs: number | null
}

/**
 * One step of the throttle, as a pure function of (state, candidate, now) so the 5 s rule is
 * testable without a clock and without a DOM.
 *
 * `candidate === null` is "nothing to say": it clears anything pending rather than queueing
 * silence, because announcing a stale sentence 5 s after it stopped being true is exactly
 * the behaviour §3.6's throttle is meant to prevent, not a consolation for it.
 */
export function throttleStep(
  state: ThrottleState,
  candidate: string | null,
  now: number,
  windowMs = FRONTIER_THROTTLE_MS,
): ThrottleStep {
  if (candidate == null || candidate === state.announced) {
    return { next: { ...state, pending: null }, waitMs: null }
  }
  const elapsed = now - state.at
  if (state.at === 0 || elapsed >= windowMs) {
    return { next: { announced: candidate, at: now, pending: null }, waitMs: null }
  }
  // Inside the window: hold the NEWEST candidate and ask to be stepped again when it opens.
  return { next: { ...state, pending: candidate }, waitMs: windowMs - elapsed }
}
