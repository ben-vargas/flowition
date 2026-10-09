# flowition-cockpit

A Claude Code plugin that watches and steers [flowition](../../README.md) runs from
inside Claude Code: in the terminal, and in the desktop app's Code tab.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install flowition-cockpit --marketplace ben-vargas/flowition
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every
session, the desktop app's included). It needs the `flowition` CLI: on `PATH`, in an
nvm, Volta, Bun or Homebrew global install, or named by `FLOWITION_BIN`. It reads
`$FLOWITION_HOME` (default `~/.flowition`).

## What it does

- **Status line**: `flo · 2 running · 1 question waiting` while runs are live.
- **`/flo [runId]`** opens the pane:
  - **Runs**: cards for the runs this session launched, everything live, and recent
    runs grouped by day (back-to-back runs of one workflow fold into one card).
    Filter by All / Live / Needs attention / Completed, or search by workflow or id.
    **New run…** starts a workflow from `~/.flowition/workflows/` detached.
  - **A run**: tiles (agents, time, output, cost, phase), a progress bar, open
    `ask()` questions you can answer, the result rendered as Markdown, and tabs:
    **Agents** (cards with Steer and Cancel), **Timeline** (queue wait and run time
    per agent), **Phases**, **Log** (the workflow's `log()` lines, messages,
    questions, agent starts and ends) and **Structure** (its `parallel()` and
    `pipeline()` fan-outs). Footer: Open in viewer, Tell Claude when done, Cancel
    run, Resume, Delete (to flowition's trash), Ask Claude.
  - **An agent's thread**: its transcript as it streams (tool calls expand to their
    input and output), with a box to message it.
- **Auto-attach**: a run Claude launches (`flowition run|resume` in Bash, or the
  flowition MCP tools) opens in the pane, and toasts when it asks a question or ends.

Every control that changes a run (answer, steer, cancel, resume, delete, start) runs
only from a press in the pane; cancel, resume and delete ask twice. Each leaves a dim
line in the transcript saying what it did.

## How it works

It reads runs only through the flowition CLI (`runs`, `status`, `--json`) and the run
directory's append-only files (`events.jsonl`, `agents/<n>.jsonl`, read from where the
last read stopped), and acts only through the CLI (`answer`, `send`, `cancel`, `rm`,
`run --detach`, `run --resume --detach`). It needs no viewer; **Open in viewer** asks a
live one for its URL and opens it through `osascript` (macOS), so the token never
appears in a process's arguments.

On the desktop, the pane's buttons and cards are drawn as `Client` regions, because
the desktop's native plugin Button takes a first click as focus alone.

## Develop

```sh
claude plugin validate plugins/flowition-cockpit
claude plugin test plugins/flowition-cockpit
claude --plugin-dir plugins/flowition-cockpit
```

The hooks module is `hooks/register.tsx`; pure logic (parsing, layout maths) is in
`hooks/lib.ts`, the larger views in `hooks/*-view.tsx`, and the plugin's `$.state`
contract in `types/index.d.ts`.
