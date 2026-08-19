# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] — 2026-08-18

### Fixed

- A claude agent that consumed a live mid-turn steer no longer hangs on teardown (#3). The claude CLI emits ONE `result` per turn — a user message injected mid-turn is coalesced into the running turn and never gets a result of its own — but `AgentJob` counted one expected result per injected message, so `outstanding` stuck above zero, stdin never closed, and the CLI (correctly) waited for EOF while the engine waited for exit: a deadlock only the 30-minute stall SIGKILL broke, after which the already-valid result was discarded as `truncated … refusing stale result` and the whole agent re-ran. A parsed terminal result now settles the whole outstanding count and closes stdin immediately (on error results too — the turn is over either way); a steer landing after the result queues for a `--resume` follow-up turn instead.
- A live-steer process that exits with messages still counted outstanding but a valid result post-dating every injection now has that result accepted, with the unanswered messages requeued for a follow-up turn, instead of the finished turn being refused as `truncated` and expensively re-run. True early death — no result yet, or an injection after the last result — still refuses.
- amp's per-message `turn-end` accounting is documented as intentionally unchanged: amp does not share claude's coalescing (a message sent without `steer: true` while the agent is busy is queued and run as its own turn, and amp exits only once the assistant is done AND stdin is closed — owner's manual appendix, checked 2026-08-18), now pinned by fake-CLI regression tests either way.
- Empty-reasoning handling is now deliberate and uniform across every stream parser. Claude Code ≥2.1 in headless print mode redacts thinking blocks to empty text plus a crypto signature (verified 2026-08-18 on claude-fable-5 and claude-sonnet-5, CLI 2.1.235); the parsers now record a final reasoning block with no text as an explicit `{kind:"reasoning", text:"", redacted:true}` transcript record (claude/amp/grok blocks, codex completed reasoning items, droid reasoning events) instead of a bare empty record, and drop empty *incremental* payloads (pi/cursor thinking deltas, opencode part snapshots), where a later event carries the block's text if there is any. The transcript keeps its honest record that reasoning occurred — which also feeds the viewer's Thinking… liveness indicator — without inventing text.
- The viewer no longer renders a textless reasoning record as an expandable "reasoning — 1 line" block that opens to nothing. Any reasoning row whose coalesced text is empty renders as a compact non-expandable row, worded by what the transcript attests: an episode carrying an engine `redacted:true` marker says "text withheld by the CLI", while the plain `{"kind":"reasoning","text":""}` records already sitting in recorded runs (which never recorded a cause) say "no reasoning text recorded". The Thinking…/Working… liveness indicator and the screen-reader frontier announcement are unchanged: textless reasoning still counts as thinking.

## [0.7.0] — 2026-08-18

### Added

- Attempt-scoped Timeline in the viewer cockpit. The fold now archives each agent's per-attempt view into the closing attempt scope when a resume opens a new one (`AttemptScope.agents`, archived before the round-11 clock clear), and selecting an earlier attempt in the lineage strip renders that attempt's real execution bars on its own `[start, end)` window — no `replay` badges for agents that actually executed there, replay ticks kept for agents that were cache hits in that attempt, and no now-line on a closed attempt. An agent with no events in the shown attempt renders an explicit "no events in this attempt" badge and none of the metadata its carried-over clock would support. Archives keep the journal-joined fields blank so server- and client-built archives are identical; a server re-fold of a run recorded before this change reconstructs its archives deterministically from the events log, and the explicit "no per-attempt agent timing recorded" state covers clients seeded from an old server's snapshot.

### Fixed

- Viewer Timeline no longer ignores the attempt selector: with "showing attempt 1" selected after a resume, the Gantt previously still rendered attempt 2's state (every replayed lane a collapsed `replay` tick at the replay instant).
- An archived attempt's Timeline now derives its capability verdict from that attempt's own opening-event engine (`AttemptScope.engine`) instead of inheriting the run-level caps, which every resume overwrites. Previously, resuming a run under an upgraded engine made earlier attempts claim queue-wait and progress support their engine could not emit and suppressed the "recorded by an older engine" notice; archives that predate the field keep today's run-level fallback.
- A previous attempt's lane can no longer leak into an archived attempt's Timeline through a same-millisecond resume boundary. The fold now records byte-order participation on every agent (`AgentView.inAttempt`, frozen into each archive), and the Gantt's pre-window refusal reads that flag ahead of the timestamp inference — which a terminal or cached event sharing the `resumed` event's millisecond used to defeat. The strict timestamp fallback remains for snapshots and archives that predate the field.

## [0.6.0] — 2026-08-13

### Added

- `grok` adapter for the Grok Build CLI: `claude-stream` protocol, turn steering via `--resume`, native `--json-schema`, `--reasoning-effort` mapped onto grok 1.0.3's `low|medium|high|xhigh` (omitted defaults to `high`), `--rules` on every turn, and a 0600 `--prompt-file`. Yolo argv is `--always-approve --permission-mode bypassPermissions`. Viewer gets a GK badge.

### Fixed

- Grok no longer passes `--cwd`. `AgentJob` already spawn()s with `spec.cwd`, and grok 1.0.3 resolves `--cwd` against process cwd, so a relative `agent({ cwd: 'packages/app' })` double-resolved to `packages/app/packages/app`.
- Grok `--reasoning-effort` no longer identity-maps the portable vocabulary. grok 1.0.3 accepts only `low|medium|high|xhigh`; `none`/`minimal` map to `low`, `max` to `xhigh`, and omitted effort now passes `--reasoning-effort high`.

## [0.5.0] — 2026-08-12

### Added

- `cursor` adapter for the Cursor CLI (`cursor-agent`): turn steering via `--resume`, schema-by-prompt, effort rejected at `agent()` time (encoded in the model id).

## [0.4.0] — 2026-08-05

### Added

- Tailnet viewer access via Tailscale Serve (`--tailscale-origin`).

## [0.3.2] — 2026-08-05

### Fixed

- Quiescent cache TTL jitter so viewer expiry no longer herds.

## [0.3.1] — 2026-08-04

### Added

- Cross-run result seeding (`--seed-from <runId>`).

### Fixed

- Fit-zoom reserves a trailing meta gutter.

## [0.3.0] — 2026-08-04

### Added

- `meta.argsSchema` input contracts and durable `step()` side-effect nodes.

## [0.2.0] — 2026-08-04

### Added

- Web viewer: observability and control cockpit for flowition runs.

## [0.1.0] — 2026-07-24

### Added

- Initial release: deterministic multi-CLI agent workflow engine.
