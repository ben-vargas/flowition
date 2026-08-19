# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Attempt-scoped Timeline in the viewer cockpit. The fold now archives each agent's per-attempt view into the closing attempt scope when a resume opens a new one (`AttemptScope.agents`, archived before the round-11 clock clear), and selecting an earlier attempt in the lineage strip renders that attempt's real execution bars on its own `[start, end)` window — no `replay` badges for agents that actually executed there, replay ticks kept for agents that were cache hits in that attempt, and no now-line on a closed attempt. An agent with no events in the shown attempt renders an explicit "no events in this attempt" badge and none of the metadata its carried-over clock would support. Archives keep the journal-joined fields blank so server- and client-built archives are identical; a server re-fold of a run recorded before this change reconstructs its archives deterministically from the events log, and the explicit "no per-attempt agent timing recorded" state covers clients seeded from an old server's snapshot.

### Fixed

- Viewer Timeline no longer ignores the attempt selector: with "showing attempt 1" selected after a resume, the Gantt previously still rendered attempt 2's state (every replayed lane a collapsed `replay` tick at the replay instant).
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
