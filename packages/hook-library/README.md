# agent-hooks-library

The six standard hooks. Each is a small Rust module that implements `agent_hooks_runtime::Hook`.

| Hook | Lifecycle | Decision |
|------|-----------|---------|
| `DynamicLtv` | beforeBorrow, afterDeposit | rejects when the position exceeds the dynamic LTV cap; otherwise emits `OverrideMaxLtvBps` |
| `TimeTriggerLiq` | beforeLiquidate | delays under stale oracle; rejects outside operator windows; otherwise accepts |
| `WhitelistBorrow` | beforeBorrow | accepts only if the borrower is in the `PermissionGate`; rejects otherwise |
| `AntiMevLiq` | beforeLiquidate | optionally restricts to registered keepers; emits `DelayLiquidationSlots` |
| `AutoHedge` | afterBorrow, afterDeposit | emits a `DriftShort` instruction when the collateral oracle dips below the trigger |
| `ReputationRate` | beforeBorrow | reads from a `ReputationProvider` and emits `OverrideRateBps` |

Each module has a `#[cfg(test)] mod tests` block exercising the accept and reject paths.

```
cargo test -p agent-hooks-library
```
