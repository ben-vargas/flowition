/**
 * A value that can be represented by JSON.
 *
 * Structured agent results and CLI `--args` values are JSON values.
 */
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue }

/** A JSON Schema type name supported by Flowition's validator. */
export type JSONSchemaType =
  | 'null'
  | 'boolean'
  | 'object'
  | 'array'
  | 'number'
  | 'integer'
  | 'string'

/**
 * The JSON Schema subset enforced by Flowition.
 *
 * Unsupported validation keywords are rejected at runtime. Annotation keywords
 * are accepted but do not affect validation.
 *
 * A schema written inline in an `agent()` call is contextually typed and needs
 * no annotation. A schema hoisted into a `const` does need one — otherwise
 * `type: 'object'` widens to `string` and stops matching `JSONSchemaType`. In
 * TypeScript write `const FINDINGS = { ... } satisfies JSONSchema`; in
 * JavaScript put a JSDoc `@satisfies {import('flowition').JSONSchema}` tag on
 * the declaration. See "Editor autocomplete" in the README.
 */
export interface JSONSchema {
  /** Requires the value to have one of these JSON types. */
  type?: JSONSchemaType | readonly JSONSchemaType[]
  /** Names object properties that must be present. */
  required?: readonly string[]
  /** Schemas for known object properties. */
  properties?: Readonly<Record<string, JSONSchema>>
  /** Allows or rejects unknown object properties; schema-valued forms are unsupported. */
  additionalProperties?: boolean
  /** The single schema applied to every array item; tuple-form arrays are unsupported. */
  items?: JSONSchema
  /** Requires equality with one of these JSON values. */
  enum?: readonly JSONValue[]
  /** Requires equality with this JSON value. */
  const?: JSONValue
  /** Inclusive lower bound for numbers. */
  minimum?: number
  /** Inclusive upper bound for numbers. */
  maximum?: number
  /** Minimum string length, counted in Unicode code points. */
  minLength?: number
  /** Maximum string length, counted in Unicode code points. */
  maxLength?: number
  /** Minimum array length. */
  minItems?: number
  /** Maximum array length. */
  maxItems?: number
  /** Requires the value to match at least one branch. */
  anyOf?: readonly JSONSchema[]
  /** Inert schema title annotation. */
  title?: string
  /** Inert schema description annotation. */
  description?: string
  /** Inert default-value annotation. */
  default?: JSONValue
  /** Inert example-values annotation. */
  examples?: readonly JSONValue[]
  /** Inert comment annotation. */
  $comment?: string
  /** Inert schema-dialect annotation. */
  $schema?: string
  /** Inert schema-identifier annotation. */
  $id?: string
}

/**
 * A built-in CLI adapter name.
 *
 * `mock` is the deterministic in-process adapter used by Flowition's tests.
 */
export type AdapterName =
  | 'claude'
  | 'codex'
  | 'amp'
  | 'droid'
  | 'opencode'
  | 'pi'
  | 'mock'

/**
 * The portable effort vocabulary documented by Flowition.
 *
 * Adapters map these values to their own CLI flags or modes.
 */
export type Effort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** Metadata for one declared workflow phase. */
export interface WorkflowPhase {
  /** Human-readable phase title. */
  title: string
}

/**
 * Descriptive metadata exported by a workflow module.
 *
 * Flowition displays `name`; other metadata is passed through to the toolkit.
 */
export interface WorkflowMeta {
  /** Stable, human-readable workflow name. */
  name: string
  /** Short description of what the workflow does. */
  description: string
  /**
   * Optional phase outline for readers and authoring tools.
   *
   * Flowition does not read it: the phase list shown by `flowition status`
   * comes from the `phase()` calls the workflow actually makes.
   */
  phases?: readonly WorkflowPhase[]
  /**
   * Input contract for the run's `--args` value.
   *
   * Validated against the effective args before any agent or step executes, on
   * fresh runs and resumes alike; a violation fails the run with the schema
   * paths that did not match. Uses the same JSON Schema subset as agent output
   * schemas — unsupported keywords are rejected loudly. No defaults are merged:
   * the toolkit still receives the `--args` value verbatim.
   */
  argsSchema?: JSONSchema
  /** Additional metadata is passed through unchanged and is not interpreted. */
  [key: string]: unknown
}

/** Options accepted by `agent()` and `spawn()`. */
export interface AgentOptions {
  /** CLI adapter; defaults to the run's `--adapter`. */
  adapter?: AdapterName
  /**
   * Model identifier for the selected CLI.
   *
   * For amp this selects an agent mode and is an alias of `mode`.
   */
  model?: string
  /** Amp-only explicit agent-mode selector, equivalent to `model` for amp. */
  mode?: string
  /** Portable reasoning-effort level, mapped by the selected adapter. */
  effort?: Effort
  /**
   * System instructions.
   *
   * Claude, droid, and pi use native flags. Amp, codex, and opencode prepend
   * these instructions only to the first turn of a fresh session.
   */
  system?: string
  /**
   * Schema for a structured final result.
   *
   * Codex strict schema mode requires every property to appear in `required`;
   * represent optional fields with nullable types such as
   * `{ type: ['string', 'null'] }`.
   */
  schema?: JSONSchema
  /** Working directory in which the agent CLI runs. */
  cwd?: string
  /** Display label, also usable as a live `sendTo()` target. */
  label?: string
  /**
   * Phase this agent belongs to, overriding the ambient `phase()` for this call.
   *
   * Use it inside `parallel()`/`pipeline()` stages, where the ambient phase can
   * move on while an item is still running. A title no `phase()` call has declared
   * yet opens its own phase group. The value is observational only: it never
   * affects the resume key.
   */
  phase?: string
  /** Explicit resume-cache key; it must be unique within the run. */
  key?: string
  /** Milliseconds without provider output before the current turn is killed; defaults to 30 minutes. */
  stallMs?: number
}

/**
 * Starts an agent and waits for its final result.
 *
 * A directly awaited agent failure rejects. Inside `parallel()` or
 * `pipeline()`, agent failures degrade that item to `null`.
 *
 * A run may start at most 1000 agents in its lifetime; the call after that
 * rejects as a runaway-loop backstop.
 */
export interface Agent {
  /**
   * Runs an agent with a schema and returns the validated JSON value.
   *
   * The schema may describe any JSON root type, not only an object.
   */
  (prompt: string, options: AgentOptions & { schema: JSONSchema }): Promise<JSONValue>
  /** Runs an agent without a schema and returns its final text. */
  (prompt: string, options?: AgentOptions & { schema?: undefined }): Promise<string>
  /** Runs an agent when schema presence is dynamic. */
  (prompt: string, options: AgentOptions): Promise<string | JSONValue>
}

/**
 * Immediate verdict returned when workflow code sends steering mail.
 *
 * A verdict reports send-time acceptance, not final delivery. In particular,
 * queued mail may later be declared undeliverable if no resumable session exists.
 */
export type SendVerdict =
  | 'live'
  | 'queued'
  | 'replayed'
  | 'dropped'
  | 'pending'

/** Handle returned immediately by `spawn()`. */
export interface SpawnHandle<Result = string | JSONValue> {
  /** Final agent result; rejects on a directly observed agent failure. */
  done: Promise<Result>
  /**
   * Sends steering mail.
   *
   * Claude and amp can receive it during the current turn. Other real adapters
   * queue it for a session-resume follow-up turn. `pending` means the handle
   * accepted it before the agent was admitted.
   */
  send(message: string): SendVerdict
}

/** Starts a steerable agent and returns its handle without waiting. */
export interface Spawn {
  /** Starts an agent with a schema and exposes its validated JSON result. */
  (prompt: string, options: AgentOptions & { schema: JSONSchema }): SpawnHandle<JSONValue>
  /** Starts an agent without a schema and exposes its final text. */
  (prompt: string, options?: AgentOptions & { schema?: undefined }): SpawnHandle<string>
  /** Starts an agent when schema presence is dynamic. */
  (prompt: string, options: AgentOptions): SpawnHandle<string | JSONValue>
}

/** A value or promise-like value accepted from workflow callbacks. */
export type MaybePromise<Value> = Value | PromiseLike<Value>

/** A deferred operation passed to `parallel()`. */
export type ParallelThunk<Result> = () => MaybePromise<Result>

/**
 * Runs thunks concurrently and waits at a barrier for all results.
 *
 * Agent failures become `null` in their original positions. Workflow errors and
 * non-agent exceptions still reject the operation. At most 4096 thunks.
 */
export interface Parallel {
  /** Runs a tuple or array of thunks; passing already-started promises is invalid. */
  <const Thunks extends readonly ParallelThunk<unknown>[]>(
    thunks: Thunks,
  ): Promise<{
    -readonly [Index in keyof Thunks]: Awaited<ReturnType<Thunks[Index]>> | null
  }>
}

/**
 * One `pipeline()` stage.
 *
 * `previous` is the prior stage's result, `originalItem` is the input item, and
 * `index` is its stable array index.
 */
export type PipelineStage<Previous, Item, Result> = (
  previous: Previous,
  originalItem: Item,
  index: number,
) => MaybePromise<Result>

/**
 * Runs each item through stages independently, with no barrier between stages.
 *
 * An agent failure stops that item and yields `null`. Returning `null`
 * intentionally also stops that item. Workflow errors and non-agent exceptions
 * reject the operation. At most 4096 items.
 */
export interface Pipeline {
  /** Returns the input items unchanged when no stages are supplied. */
  <Item>(items: readonly Item[]): Promise<Item[]>
  /** Runs one stage for every item. */
  <Item, First>(
    items: readonly Item[],
    first: PipelineStage<Item, Item, First>,
  ): Promise<Array<Awaited<First> | null>>
  /** Runs two chained stages for every item. */
  <Item, First, Second>(
    items: readonly Item[],
    first: PipelineStage<Item, Item, First>,
    second: PipelineStage<Exclude<Awaited<First>, null>, Item, Second>,
  ): Promise<Array<Awaited<Second> | null>>
  /** Runs three chained stages for every item. */
  <Item, First, Second, Third>(
    items: readonly Item[],
    first: PipelineStage<Item, Item, First>,
    second: PipelineStage<Exclude<Awaited<First>, null>, Item, Second>,
    third: PipelineStage<Exclude<Awaited<Second>, null>, Item, Third>,
  ): Promise<Array<Awaited<Third> | null>>
  /** Runs four chained stages for every item. */
  <Item, First, Second, Third, Fourth>(
    items: readonly Item[],
    first: PipelineStage<Item, Item, First>,
    second: PipelineStage<Exclude<Awaited<First>, null>, Item, Second>,
    third: PipelineStage<Exclude<Awaited<Second>, null>, Item, Third>,
    fourth: PipelineStage<Exclude<Awaited<Third>, null>, Item, Fourth>,
  ): Promise<Array<Awaited<Fourth> | null>>
  /**
   * Runs any number of stages when a longer chain cannot be inferred precisely.
   *
   * The implementation accepts unbounded stages; this fallback preserves the
   * honest `unknown | null` result instead of guessing a chain type.
   */
  <Item>(
    items: readonly Item[],
    ...stages: Array<PipelineStage<any, Item, unknown>>
  ): Promise<Array<unknown | null>>
}

/** Advisory output-token budget exposed to the workflow. */
export interface Budget {
  /** Configured output-token ceiling, or `null` when no ceiling was set. */
  total: number | null
  /** Output tokens spent by completed, failed, and cancelled attempts. */
  spent(): number
  /**
   * Tokens left, or `Infinity` when unlimited.
   *
   * The budget is checked only before agent admission, so in-flight work can
   * overshoot it. Spend and the ceiling are restored on resume.
   */
  remaining(): number
}

/** Options accepted by `ask()`. */
export interface AskOptions {
  /** Question identifier; it must be unique for the entire run. */
  id?: string
}

/** Toolkit passed to a workflow's default export. */
export interface WorkflowToolkit<
  Args = unknown,
  Meta extends Record<string, unknown> = Partial<WorkflowMeta>,
> {
  /** Starts an agent and waits for its text or structured result. */
  agent: Agent
  /**
   * Runs local code as a durable, journaled step.
   *
   * A completed callback's JSON result is journaled and replayed on resume
   * instead of re-executing; incomplete or failed attempts re-run on resume.
   * `name` plus the canonicalized `args` are
   * part of the step's resume key, so a changed name or args is a different
   * step that never reuses a cached result. Steps use their own per-branch
   * counter, independent of agents — adding or removing a step never shifts
   * agent resume keys.
   *
   * Args and the result must be JSON values (`undefined`, functions, BigInt,
   * cycles, and non-finite numbers are rejected loudly). A callback that
   * returns nothing resolves to `null`.
   *
   * The guarantee is durable memoization, not exactly-once side effects: a
   * crash between the callback's external effect and its completion record
   * re-runs the callback on resume, so callbacks should be idempotent. A
   * failed step is journaled but not cached — it re-runs on resume.
   *
   * At most 10000 `step()` calls per execution attempt (replayed cached calls
   * count too; the counter resets on resume).
   */
  step<T extends JSONValue | void = JSONValue>(
    name: string,
    args: JSONValue,
    fn: () => MaybePromise<T>,
  ): Promise<T extends void ? null : T>
  step<T extends JSONValue | void = JSONValue>(
    name: string,
    fn: () => MaybePromise<T>,
  ): Promise<T extends void ? null : T>
  /** Starts an agent immediately and returns a steerable handle. */
  spawn: Spawn
  /** Runs thunks concurrently behind a result barrier. */
  parallel: Parallel
  /** Streams each input item through a sequence of stages. */
  pipeline: Pipeline
  /** Emits a phase marker to status and tail output. */
  phase(title: string): void
  /** Emits a workflow log message to status and tail output. */
  log(message: string): void
  /**
   * Blocks for an operator answer, which is journaled and replayed on resume.
   *
   * Explicit IDs must be unique for the entire run.
   */
  ask(question: string, options?: AskOptions): Promise<string>
  /**
   * Steers one currently live agent by numeric index or label.
   *
   * Returns `false` when no live target matches. Turn-steered adapters queue a
   * follow-up session turn instead of injecting into the current process.
   */
  sendTo(
    target: number | string,
    message: string,
  ): Exclude<SendVerdict, 'pending'> | false
  /** Verbatim JSON supplied through `--args` or `--args-file`. */
  args: Args
  /** Advisory output-token budget for the run. */
  budget: Budget
  /**
   * The workflow module's exported metadata object.
   *
   * A module that exports no `meta` gets `{}`, so the default type treats every
   * field as optional; pass a `Meta` type argument to assert your own shape.
   */
  meta: Meta
  /**
   * Returns a deterministic, branch-local stand-in for `Date.now()`.
   *
   * The value is the run's creation time plus a per-branch call counter, so it
   * is monotonic and replay-stable but not a wall clock: a difference between
   * two `now()` values counts calls, not elapsed milliseconds. Use this instead
   * of `Date.now()` so journal replay stays deterministic.
   */
  now(): number
  /**
   * Returns deterministic, branch-local pseudorandom values in `[0, 1)`.
   *
   * Use this instead of `Math.random()` so journal replay stays deterministic.
   */
  random(): number
}

/**
 * Type of the workflow module's default-export function.
 *
 * Flowition awaits the return value, then drains all agents started by the
 * workflow before completing the run.
 */
export type Workflow<
  Args = unknown,
  Result = unknown,
  Meta extends Record<string, unknown> = Partial<WorkflowMeta>,
> = (toolkit: WorkflowToolkit<Args, Meta>) => MaybePromise<Result>

/** Type-only default export for annotating a workflow module's default function. */
export type { Workflow as default }
