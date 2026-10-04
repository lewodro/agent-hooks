# agent-hooks-executor

The Anchor 0.31 program that stores `Composition` PDAs and runs them at lifecycle events.

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

The program id in `declare_id!` is a placeholder. Replace it after the first mainnet deploy.

## Test

The mocha tests in `tests/` need a local validator with the three lending programs cloned. The `Anchor.toml` at the repo root configures them.

```
anchor test
```
