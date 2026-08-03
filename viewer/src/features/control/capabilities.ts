/**
 * §7.2's capability gate — the one rule every control in this feature asks before it renders,
 * and it FAILS CLOSED.
 *
 * `GET /api/session` reports `control: string[]`, the set the operator enabled with
 * `flowition viewer --control[=…]`. The gate has exactly one opening condition: **a
 * successful session response that names this capability**. Everything else — a probe still
 * in flight, a probe that failed, a response that granted something else — is a control the
 * operator cannot operate.
 *
 * Three readings, and the difference between the last two is the whole reason this module
 * exists — but it is a difference in WHAT THE UI SAYS, never in what it lets through:
 *
 *   • `allowed` — the capability is in the reported set. The control works.
 *   • `locked`  — the session ANSWERED and the capability is not in it. §7.2 is explicit
 *                 about what the UI does here: render the control *disabled with an
 *                 explanation*, never hidden and never enabled. A missing button is
 *                 indistinguishable from a missing feature, and the operator's next move
 *                 ("restart the viewer with --control") is only discoverable if the locked
 *                 control says so.
 *   • `unknown` — the session probe has NOT answered, or it failed. **Also disabled**, with
 *                 copy that says the check is what is missing rather than claiming this
 *                 viewer is read-only.
 *
 * **Why unknown is disabled** (review round 5, B1). The previous revision offered unknown
 * controls and let the server's 403 speak, on the argument that a transient network failure
 * must not present itself as a property of the viewer. The honesty half of that argument is
 * right and is kept — it is why `unknown` still has its own word and its own sentence. The
 * enablement half is wrong: `--control` is an opt-in whose entire point is that a viewer
 * cannot drive a full-permission agent process until the operator says so (§7.2, §7.4), and
 * a permission check that never answers must therefore deny, not permit. A read-only viewer
 * whose session probe fails is exactly the case the acceptance criterion names — its controls
 * are never enabled — and "the server holds the real gate" cannot be relied on by a UI whose
 * job is to not offer what it has no evidence it may do. The cost of failing closed is one
 * unnecessary disabled second on a slow probe, and the copy says so; the cost of failing open
 * is a live steer button on a viewer that was started read-only.
 *
 * Pure by design: no React, no DOM. `Locked.tsx` renders the chip, `dialogs`/composers read
 * the verdict, and `capabilities.test.ts` runs in the node environment.
 */

/** The five mutations `--control[=send,answer,cancel,resume,delete]` gates (§7.2). */
export type Capability = 'send' | 'answer' | 'cancel' | 'resume' | 'delete'

export const CAPABILITIES: readonly Capability[] = ['send', 'answer', 'cancel', 'resume', 'delete']

export type CapabilityState = 'allowed' | 'locked' | 'unknown'

/** The §7.2 reading of a session's `control` array for one capability. */
export function capabilityState(
  capabilities: readonly string[] | null | undefined,
  capability: Capability,
): CapabilityState {
  if (capabilities == null) return 'unknown'
  return capabilities.includes(capability) ? 'allowed' : 'locked'
}

/**
 * **The gate.** May this control be operated at all? True only for an explicit grant in a
 * successful session response — every composer, button and palette row in this feature asks
 * this and nothing else, so there is one place where "unknown" could ever become "yes".
 */
export const canOperate = (
  capabilities: readonly string[] | null | undefined,
  capability: Capability,
): boolean => capabilityState(capabilities, capability) === 'allowed'

/**
 * A CONFIRMED refusal — the session answered and said no. Narrower than `!canOperate`, and
 * used only for copy ("read-only" is a claim that needs an answer behind it).
 */
export const isLocked = (
  capabilities: readonly string[] | null | undefined,
  capability: Capability,
): boolean => capabilityState(capabilities, capability) === 'locked'

/** The exact CLI invocation that grants one capability — the copy every lock chip carries. */
export const controlFlag = (capability: Capability): string =>
  `flowition viewer --control=${capability}`

const VERB: Record<Capability, string> = {
  send: 'steering an agent',
  answer: 'answering a question',
  cancel: 'cancelling',
  resume: 'resuming',
  delete: 'deleting a run',
}

/**
 * The sentence a locked control shows. It names the act, the flag, and the fact that this
 * viewer was started read-only — §7.2's "controls locked" explanation, per control.
 */
export const lockedExplanation = (capability: Capability): string =>
  `${VERB[capability]} needs \`${controlFlag(capability)}\` — this viewer is read-only`

/**
 * The sentence an UNKNOWN control shows. It never claims read-only — nobody has said so —
 * and it never claims the control would work if pressed, because it is disabled. It states
 * the only two facts there are: the check has not succeeded, and nothing is granted until it
 * does.
 */
export const unknownExplanation = (
  capability: Capability,
  error?: string | null,
): string => (error
  ? `${VERB[capability]} is disabled — the permission check failed (${error}); this viewer `
    + 'will not act on a capability the session has not granted'
  : `${VERB[capability]} is disabled while this viewer's permissions are being checked — `
    + '`GET /api/session` has not answered yet')

/**
 * The lock sentence SPLIT, for the action rows too narrow to carry it whole (a cockpit
 * header with three lifecycle buttons is the case that forced this — round 6, B1).
 *
 *   `hint` — stays VISIBLE, and is deliberately the shortest thing that is still actionable:
 *            the FLAG. It is the half a tooltip is worst at — the operator has to read it to
 *            type it — and it is short enough to sit in a row of buttons without pushing the
 *            run's own actions off the header. `null` for an unverified/checking control,
 *            where the chip's word already is the summary and there is no flag to name.
 *   `rest`  — the whole sentence, rendered visually-hidden inside the same chip, so the
 *            description a screen reader computes from `aria-describedby` is the explanation
 *            rather than one word.
 *
 * `null` when the capability is allowed — there is no chip at all.
 */
export function lockParts(
  capabilities: readonly string[] | null | undefined,
  capability: Capability,
  error?: string | null,
): { hint: string | null; rest: string } | null {
  const state = capabilityState(capabilities, capability)
  if (state === 'allowed') return null
  return {
    hint: state === 'locked' ? `--control=${capability}` : null,
    rest: explainCapability(capabilities, capability, error ?? null)!,
  }
}

/** The one-line explanation for a control's state, or `null` when it is simply allowed. */
export function explainCapability(
  capabilities: readonly string[] | null | undefined,
  capability: Capability,
  error?: string | null,
): string | null {
  const state = capabilityState(capabilities, capability)
  if (state === 'allowed') return null
  if (state === 'locked') return lockedExplanation(capability)
  return unknownExplanation(capability, error ?? null)
}

/**
 * The one word a gated control's chip carries. `checking` and `unverified` are both disabled
 * states; they differ in whether anything has gone wrong yet, which is the difference between
 * "wait a moment" and "this needs your attention".
 */
export function capabilityWord(
  state: CapabilityState,
  error?: string | null,
): 'locked' | 'unverified' | 'checking' | null {
  if (state === 'allowed') return null
  if (state === 'locked') return 'locked'
  return error ? 'unverified' : 'checking'
}

/**
 * The placeholder a GATED TEXT INPUT carries — one sentence-fragment per state, shared by
 * every composer in the product (the cockpit's inbox, Home's attention strip).
 *
 * It exists because the placeholder is the only copy an empty disabled input has, and the
 * three disabled reasons are not interchangeable: "read-only viewer" is a claim about what
 * the server said, and a probe that has not answered has said nothing. Two composers writing
 * this ladder by hand is how Home ended up telling the operator its controls were still
 * offered while the cockpit's said they were being checked.
 */
export function gatedPlaceholder(
  capabilities: readonly string[] | null | undefined,
  capability: Capability,
  error: string | null | undefined,
  allowed: string,
): string {
  const state = capabilityState(capabilities, capability)
  if (state === 'allowed') return allowed
  if (state === 'locked') return 'read-only viewer'
  return error ? 'permissions unverified' : 'checking permissions…'
}

export interface ControlSummary {
  kind: 'read-only' | 'partial' | 'unverified' | 'checking'
  /** The capabilities this viewer may not use — all five when nothing has been granted. */
  locked: Capability[]
  label: string
  detail: string
}

/**
 * The header chip §7.2 asks for ("a persistent 'controls locked' header chip"), as text.
 *
 * `null` only when every capability is granted. An unknown set is NOT silent any more: since
 * the gate fails closed, an unknown set means every mutation on the screen is disabled, and a
 * header that says nothing about that leaves five disabled controls with no page-level
 * explanation. It still never says "read-only" — that claim needs an answer behind it — so it
 * says what is true instead: the check has not succeeded and nothing is granted until it does.
 */
export function lockedSummary(
  capabilities: readonly string[] | null | undefined,
  error?: string | null,
): ControlSummary | null {
  if (capabilities == null) {
    return {
      kind: error ? 'unverified' : 'checking',
      locked: [...CAPABILITIES],
      label: error ? 'permissions unverified' : 'checking permissions…',
      detail: error
        ? `\`GET /api/session\` failed (${error}), so this viewer has not been granted any `
          + 'mutation. Every control is disabled until the check succeeds — reload, or check '
          + 'that the viewer is still running.'
        : 'This viewer is asking `GET /api/session` which mutations it may perform. Controls '
          + 'stay disabled until it answers.',
    }
  }
  const locked = CAPABILITIES.filter((capability) => !capabilities.includes(capability))
  if (!locked.length) return null
  const all = locked.length === CAPABILITIES.length
  return {
    kind: all ? 'read-only' : 'partial',
    locked,
    label: all ? 'read-only' : 'controls partly locked',
    detail: all
      ? 'This viewer was started without `--control`, so every mutation is refused by the '
        + 'server. Restart it with `flowition viewer --control` to answer, steer, cancel, '
        + 'resume or delete.'
      : `Locked: ${locked.join(', ')}. Restart the viewer with `
        + `\`flowition viewer --control=${locked.join(',')}\` to enable ${
          locked.length === 1 ? 'it' : 'them'}.`,
  }
}
