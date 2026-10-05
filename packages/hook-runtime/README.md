# agent-hooks-runtime

Runtime-agnostic types and execution logic for the Agent Hooks hook system. This crate is the source of truth for:

- The eight lifecycle event kinds (`LifecycleEventKind`).
- The position / market / oracle snapshot shapes.
- `Composition` + `CompositionBuilder` — at most eight hooks, ordered by unique priorities to match the SDK and Anchor registry.
- The `Hook` trait and `HookDecision` / `SideEffect` enums.
- An in-process `Simulator` that mirrors the on-chain executor.

The crate has no Solana program-side dependencies, which lets the simulator run inside the SDK or a CI job without spinning up a local validator.

## Execution boundary and event validation

Runtime evaluation is deterministic and requires a host-supplied `ExecutionContext` with the trusted current slot. Never use the `LifecycleEvent.market.slot` as a substitute for current chain state in a live execution path. `EventValidationPolicy` bounds event age, payload bytes, oracle count and age, oracle confidence, LTV, and basis-point ranges. The defaults are intentionally conservative examples and deployments should set policy from protocol risk requirements.

```rust
use agent_hooks_runtime::{
    Composition, EventValidationPolicy, ExecutionContext, LifecycleEvent,
};

fn evaluate(
    composition: &Composition,
    event: &LifecycleEvent,
    trusted_current_slot: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let trace = composition.evaluate(
        event,
        ExecutionContext { current_slot: trusted_current_slot },
        &EventValidationPolicy::default(),
    )?;
    if let Some(reason) = trace.rejection_reason() {
        return Err(reason.into());
    }
    // Apply trace.side_effects only after the complete composition accepts.
    Ok(())
}
```

Hooks declaring `UsesOracle` are skipped only when their lifecycle flags do not match; otherwise they fail closed if no oracle observations are present. Every supplied observation is checked for slot freshness, duplicate mints, zero price, and excessive confidence. The host is still responsible for authenticating adapter/event provenance and validating oracle account ownership/signatures before constructing the event; range checks alone do not prove source authenticity.

`Composition::evaluate` retains the full per-hook trace when a hook rejects, while clearing executable side effects. The compatibility `Composition::execute` returns a rejection as an error; use `evaluate` when traces feed audit, replay, or experience memory. Historical `Simulator::run` uses each recorded snapshot slot as its replay-time context. For live or delayed-ingestion evaluation, call `run_with_context` and provide a trusted current slot for each event; both event and oracle freshness are measured against that context.

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
