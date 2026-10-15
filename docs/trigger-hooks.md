# Trigger Hooks: on-chain to agent

Trigger Hooks are the ingress side of Agent Hooks. A trusted chain observer receives a Solana transaction or signed webhook, verifies its source, normalizes it into a `ChainObservation` and optional `LifecycleEvent`, then wakes an off-chain agent. The agent may inspect context, recall experience, simulate, and create a proposal. It does not gain signing authority from being woken.

```text
Solana RPC / indexer webhook
        ↓ verify program, signature, slot, accounts, freshness
ChainObservation + LifecycleEvent
        ↓ deterministic trigger predicate + durable dedupe
agent wake queue (at-least-once)
        ↓
planner → simulation → policy → operator approval → separate execution service
```

The first package implementation supports Solana RPC log subscriptions and HMAC-signed webhook intake. It intentionally leaves protocol event decoding, durable cursors, queue delivery, and the agent runtime to the host application. This keeps the trust boundary explicit: a log subscription is not proof that a normalized lending event or an LTV value is correct.

## Production checklist

- Use a durable cursor and atomic dedupe key such as `trigger_id + transaction_signature + event_index`.
- Reconcile RPC notifications with fetched, confirmed/finalized transactions and validate program IDs, account ownership, instruction discriminators, and event indexes.
- Add protocol-specific decoders for Marginfi, Kamino, Solend, whale transfers, and DAO proposal accounts.
- Put the wake request on a durable queue with retry, dead-letter handling, rate limits, and idempotent agent runs.
- Keep private keys in a separate transaction service. A trigger can create a proposal; it must not silently sign or broadcast.
