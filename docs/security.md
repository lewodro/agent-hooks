# Security

## Mainnet deploy gates

Mainnet deploys are not automated. The CLI's `agent-hooks deploy --cluster mainnet` command prints the plan and refuses to broadcast. The deployer:

1. Names the keypair path and its Base58 pubkey.
2. Names the cluster (mainnet, devnet, localnet — each a separate approval).
3. Confirms the balance via `solana balance`.

The CLI re-derives the pubkey from the keypair at the last moment and aborts if it doesn't match the human-approved value. This catches stale keypair files leaking between projects.

## Listing manifest checks

`publish_hook` stores a manifest URI on-chain along with the declared flags. The executor uses the on-chain flags as the source of truth — the off-chain manifest is for discovery only. If a hook program tries to fire on an event whose flag bit was not declared at listing time, the executor rejects the run.

## Composition install authority

Compositions are PDAs keyed by `(pool, slot_index)`. Only the pool's recorded authority may install or update a Composition. The authority is set at `register_pool` and not transferable from the on-chain program — operators rotate authority by reinstalling the pool under a new market account.

## Side-effect bounds

`SideEffect` payload size is capped at 256 bytes by the executor. `EmitInstruction` payloads must round-trip through the adapter; the executor never CPIs into unknown programs directly.
