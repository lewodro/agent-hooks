# agent-hooks-runtime

Runtime-agnostic types and execution logic for the Agent Hooks hook system. This crate is the source of truth for:

- The eight lifecycle event kinds (`LifecycleEventKind`).
- The position / market / oracle snapshot shapes.
- `Composition` + `CompositionBuilder` — priority-ordered list of hooks.
- The `Hook` trait and `HookDecision` / `SideEffect` enums.
- An in-process `Simulator` that mirrors the on-chain executor.

The crate has no Solana program-side dependencies, which lets the simulator run inside the SDK or a CI job without spinning up a local validator.

## Layout

```
src/
  lib.rs           crate surface + RuntimeError
  event.rs         LifecycleEventKind, PositionSnapshot, MarketSnapshot, AdapterKind
  hook.rs          Hook trait, HookFlag bitmap, HookDecision, SideEffect
  composition.rs   CompositionBuilder, Composition, ExecutionTrace
  permission.rs    ReputationProvider trait + MemoryReputation, PermissionGate
  simulation.rs    Simulator + BacktestReport
```

## Tests

```
cargo test -p agent-hooks-runtime
```
