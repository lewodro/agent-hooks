# Hook spec

## Lifecycle events

Eight discrete events. Each maps to one bit in the flags bitmap.

| Event | Flag bit |
|-------|---------|
| `beforeDeposit` | `1 << 0` |
| `afterDeposit` | `1 << 1` |
| `beforeBorrow` | `1 << 2` |
| `afterBorrow` | `1 << 3` |
| `beforeRepay` | `1 << 4` |
| `afterRepay` | `1 << 5` |
| `beforeLiquidate` | `1 << 6` |
| `afterLiquidate` | `1 << 7` |

The four "capability" bits sit above the lifecycle bits.

| Capability | Flag bit |
|-----------|---------|
| `MutatePayload` | `1 << 8` |
| `MayReject` | `1 << 9` |
| `UsesOracle` | `1 << 10` |
| `MutatesRate` | `1 << 11` |

A hook that lacks the matching lifecycle bit is skipped at runtime — no CPI happens. A hook that lacks the matching capability bit but tries to use it at runtime is rejected by the executor.

## Decision shapes

A hook returns one of three decisions:

```rust
pub enum HookDecision {
    Accept,
    AcceptWith(SideEffect),
    Reject(String),
}
```

`Accept` flows through. `Reject` halts the lifecycle and surfaces the reason. `AcceptWith` enqueues a bounded side effect.

## Side-effect ABI

```rust
pub enum SideEffect {
    OverrideMaxLtvBps(u16),
    OverrideRateBps(u16),
    DelayLiquidationSlots(u64),
    EmitInstruction { kind: InstructionKind, payload: Vec<u8> },
}
```

The adapter consumes these in order. `OverrideMaxLtvBps` clamps the position's max LTV for the duration of the call. `OverrideRateBps` overrides the accrued interest rate. `DelayLiquidationSlots` pushes the actual liquidation by N slots — used by both `TimeTriggerLiq` and `AntiMEVLiq`. `EmitInstruction` queues a CPI for the adapter to relay (e.g. a Drift perp short for `AutoHedge`).

## Composition rules

- A Composition contains up to eight hook entries.
- Entries are sorted by `priority` (lower runs first).
- Each entry stores its hook's `program_id`, `priority`, and a copy of the hook's flag bitmap.
- The executor refuses to run a composition slot whose declared flags don't include the event kind for the call.
- A single `Reject` halts the composition; downstream side effects are dropped.
