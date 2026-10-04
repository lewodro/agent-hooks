## What

A one-line summary of the change.

## Why

What problem this fixes or what the motivation is.

## How

How the change works. Link to relevant tests or docs.

## Checklist

- [ ] `cargo test --workspace --exclude agent-hooks-executor` passes locally
- [ ] `pnpm typecheck` passes locally
- [ ] If this touches the executor program, the test under `packages/anchor-program/tests/` covers it
- [ ] If this is a new standard hook, it has at least one accept-path and one reject-path test
- [ ] Docs in `docs/` updated if behaviour changes
