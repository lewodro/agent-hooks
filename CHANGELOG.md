# Changelog

## 0.1.2 / 0.1.3 — per-entry HookRan receipt

- `run_composition` now emits a `HookRan` event for every entry whose declared flags cover the lifecycle event (in addition to the existing `CompositionExecuted` aggregate). Fields: `composition`, `pool`, `event_kind`, `hook_program`, `priority`, `flags_bits`, `decision`, `side_effect_kind`, `side_effect_payload`, `timestamp`. Indexers and CLIs read this directly instead of having to decode hook-program-specific logs.
- Mainnet program upgraded in place (same Program ID `5yNMqcyZsGQJk4xvw4jjvoRBSnGs8mgramEa3HQe5faD`). Upgrade signature `2YfSbXyVD8yYfXeJPCT3TQKzZkzpBJG7T31mAs5fNcWnQjSt3bFdWNCi8wjYNBPDFfoHYKFbpvvbC32sT3Ya4ZEi`. .so grew from 267,256 to 268,816 bytes.
- `@agent-hooks/cli` 0.1.3 ships with HookRan decoding — `agent-hooks receipts --signature <tx>` prints both the aggregate and the per-entry list.

## 0.1.1 — mainnet patch

- `install_composition` and `update_composition` now refuse compositions whose entries share a priority byte. Two entries silently colliding on the same fold position was an edge case the type system did not prevent. Added `HookExecutorError::DuplicatePriority` and a guard in both instruction handlers.
- Mainnet program upgraded in place (same Program ID `5yNMqcyZsGQJk4xvw4jjvoRBSnGs8mgramEa3HQe5faD`). Upgrade signature `3AWddY7i9UYczUjN9PW8zgajmgT3Kr9hUbY2tcfpKmD8ugyAehbjwUDZDbgGriptbsvFBwFpAWHtdvykGzxLbijR`. .so grew from 265,256 to 267,256 bytes.
- Hook Marketplace page is now open at agent-hooks.dev/marketplace alongside this upgrade.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/) but written in plain prose because the project is small.

## 0.1.0 — 2026-06-12

First public tag.

- Anchor 0.31 hook executor program with Pool / Composition / HookListing PDAs and four instructions (`register_pool`, `install_composition`, `update_composition`, `run_composition`, `publish_hook`).
- Hook runtime crate (`agent-hooks-runtime`) with the lifecycle event types, `Composition` + `CompositionBuilder`, `Simulator`, and the `Hook` trait.
- Six standard hooks (`agent-hooks-library`): `DynamicLTV`, `TimeTriggerLiq`, `WhitelistBorrow`, `AntiMEVLiq`, `AutoHedge`, `ReputationRate`. Each ships with unit tests covering accept and reject paths.
- Adapters for Marginfi v2, Kamino Lend, and Solend that normalise pool state into the shared `LifecycleEvent` shape.
- TypeScript SDK (`@agent-hooks/sdk`) with `Composition`, `ExecutorClient`, deterministic `simulate()`, and helpers for every standard hook.
- `@agent-hooks/cli` (`npm i -g @agent-hooks/cli`) with `list`, `simulate`, `create`, `deploy` (plan-only — does not broadcast), and `action` (writes a GitHub Actions workflow).
- VS Code extension (`agent-hooks.agent-hooks-vscode`) with three commands: Open Hook Designer, Simulate Current Composition, Show Deploy Plan.
- Docs: `docs/architecture.md`, `docs/hooks-spec.md`, `docs/security.md`.
- CI workflow at `.github/workflows/ci.yml`.

## Notes

The executor program is not yet deployed to mainnet. The placeholder pubkey in `declare_id!` is replaced at deploy time. The `agent-hooks deploy` command only prints the deploy plan; the actual `anchor deploy` is operator-driven.
