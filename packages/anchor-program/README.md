# Agent Hooks Anchor programs

This Anchor 0.31 workspace contains the composition registry/executor prototype and a separately deployable agent policy hook.

## `agent-hooks-policy`

The `agent-hooks-policy` example stores an owner-controlled policy PDA, permits only the configured executor program's PDA signer to call `authorize_execution`, checks quoted-output slippage against a maximum in basis points, enforces a slot cooldown, supports a pause switch, and emits an action-hash receipt. Its policy PDA is initialized once per owner; limits and pause state are owner controlled.

An integrating executor should CPI to this gate immediately before its state-mutating CPI, pass the same quote/minimum-output values to both operations, and propagate any error. Solana transaction atomicity then rolls back the gate's slot update if the later operation fails. This is a reusable policy hook, not a guarantee for protocols that do not integrate it. The configured executor program is a trust boundary: review its deployed code, upgrade authority, and PDA seed convention. The example does not itself execute a swap or prove that a quote is fair.

The declared program ID is a deterministic local-development placeholder, not a deployed address. Replace it with the deployment keypair's address before producing deployment artifacts.

## `agent-hooks-executor`

The registry prototype stores `Composition` PDAs and checks hook eligibility at lifecycle events.

## Instructions

| Instruction | Purpose |
|------------|---------|
| `register_pool(adapter, bump)` | Bind a Marginfi / Kamino / Solend market to a `Pool` PDA |
| `install_composition(slot_index, entries)` | Write up to eight hook entries to a `Composition` PDA |
| `update_composition(entries)` | Replace the entries on an existing composition |
| `run_composition(event_kind, owner, adapter, payload)` | Invoked by the adapter; returns a `RunReceipt` |
| `publish_hook(flags, manifest_uri, bump)` | List a hook program in the marketplace; the flags bitmap becomes the on-chain manifest |

## Accounts

| Account | Seeds | Stores |
|--------|-------|--------|
| `Pool` | `["pool", market]` | authority, market, adapter byte, composition_count |
| `Composition` | `["composition", pool, slot_index]` | up to 8 `HookEntry { hook_program, priority, flags }` |
| `HookListing` | `["listing", hook_program]` | author, flags, manifest URI (≤200 bytes) |

## Build

```
anchor build
```

The executor's program id in `declare_id!` is a placeholder. Replace it before deployment.

## Test

The mocha tests in `tests/` need a local validator with the three lending programs cloned. The `Anchor.toml` at the repo root configures them.

```
anchor test
```
