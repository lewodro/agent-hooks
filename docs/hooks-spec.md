# Hook specification

This document describes the local Rust runtime contract and separates it from on-chain behavior that is not implemented yet. In the current Anchor executor, registering a hook stores metadata; `run_composition` counts lifecycle-eligible entries and emits eligibility receipts. It does not invoke hook programs, enforce their results, or apply their side effects.

## Lifecycle events

Eight lifecycle points map to flag bits:

| Event | Flag bit |
|---|---:|
| `beforeDeposit` | `1 << 0` |
| `afterDeposit` | `1 << 1` |
| `beforeBorrow` | `1 << 2` |
| `afterBorrow` | `1 << 3` |
| `beforeRepay` | `1 << 4` |
| `afterRepay` | `1 << 5` |
| `beforeLiquidate` | `1 << 6` |
| `afterLiquidate` | `1 << 7` |

Capability declarations occupy the upper bits:

| Capability | Flag bit | Rust runtime enforcement |
|---|---:|---|
| `MutatePayload` | `1 << 8` | Required for LTV overrides, liquidation delays, and emitted instructions. |
| `MayReject` | `1 << 9` | Required when returning `Reject`; an undeclared rejection is converted to a policy rejection. |
| `UsesOracle` | `1 << 10` | An eligible hook fails closed if the event has no oracle observations. The runtime does not authenticate their source. |
| `MutatesRate` | `1 << 11` | Required for rate overrides. |

Flags are metadata and must not be trusted as authorization by themselves. A host or future on-chain executor must bind the declared capabilities to an allowlisted program and validate the program's result.

## Hook decisions and trace

Local Rust hooks return one of:

```rust
pub enum HookDecision {
    Accept,
    AcceptWith(SideEffect),
    Reject(String),
}
```

`Composition::evaluate` runs eligible hooks in priority order. It validates event freshness and bounds against a host-supplied current slot, records each hook result, and rejects out-of-policy decisions. Configurable limits cover LTV, delay, and instruction payload size; rates and basis-point values are capped at 10,000. On rejection, the audit trace is retained and the executable side-effect list is cleared. The runtime result remains a local decision until a protocol integration enforces it.

## Side-effect proposals

```rust
pub enum SideEffect {
    OverrideMaxLtvBps(u16),
    OverrideRateBps(u16),
    DelayLiquidationSlots(u64),
    EmitInstruction { kind: InstructionKind, payload: Vec<u8> },
}
```

The runtime validates capability and configured bounds before including a proposal in an accepted trace. It does not relay emitted instructions, change a borrow rate, delay a real liquidation, or mutate lending protocol state. Those actions require a downstream protocol-specific host/CPI integration that binds the values to the exact operation and aborts if a hook rejects.

## Composition limits and on-chain status

- The local Rust composition accepts one to eight hooks and sorts by ascending priority; lower values run first.
- A local hook without the matching lifecycle flag is recorded as skipped.
- The Anchor registry stores hook program IDs, priorities, and flag bits in PDAs and limits pool compositions.
- Anchor `run_composition` currently emits eligibility receipts only. `HookRan.decision` is a placeholder, not an observed hook decision.
- No generic hook CPI ABI or downstream protocol mutation guard is implemented in this repository yet.

See [architecture](architecture.md) for package ownership and [security](security.md) for trust boundaries.
