# Contributing to flowition

## Setup

```
git clone https://github.com/ben-vargas/flowition.git
cd flowition
npm link      # exposes `flowition` and `flo` on PATH; there is nothing to install
npm test      # full suite via node:test against the in-process mock adapter
```

The tests need no API keys and none of the real agent CLIs — everything runs
against the deterministic mock adapter. `flowition doctor` checks which real CLIs
you have for manual testing with the workflows in `examples/`.

## Style

- **Zero runtime dependencies.** Do not add packages; use `node:` builtins.
- Plain ESM JavaScript, no build step. Match the existing code's style,
  comment density, and error-handling idiom (fail loudly, never silently).
- Bug fixes must come with a test that fails without the fix.
- Read [ARCHITECTURE.md](ARCHITECTURE.md) before touching the engine, journal,
  resume keys, or mail-delivery semantics — the invariants there are load-bearing
  and several were hard-won.

## Adapters

Adapter behaviors (stream protocols, resume vehicles, flag quirks) are
empirically verified against the real CLIs, not inferred from their docs.
A change to an adapter, or a new adapter, needs a transcript or reproducible
session with the real CLI demonstrating the claimed behavior, plus mock-adapter
test coverage of the parsing/argv logic.
