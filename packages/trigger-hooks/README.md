# `@agent-hooks/trigger-hooks`

Solana-first ingress and trigger primitives for waking an idle off-chain agent when a chain observation matches a configured condition.

```ts
const engine = new TriggerEngine({
  triggers: [{
    id: "liquidation-risk",
    predicate: { eventKinds: ["beforeLiquidate"], minLtvBps: 8_000 },
  }],
  dispatcher: { wake: async ({ observation }) => queueAgentRun(observation) },
});
```

`SolanaLogSource` listens to a program through `Connection.onLogs`. `parseSignedWebhook` verifies an HMAC webhook before accepting it. `TriggerEngine` rejects unverified observations, matches deterministic predicates, and deduplicates by trigger/source/signature. The dispatcher is deliberately an application boundary: this package does not run a model, sign a transaction, or broadcast a transaction.

Important limitation: RPC logs authenticate the subscribed program and transaction, but they do not decode protocol-specific events. A Marginfi, Kamino, Solend, or indexer decoder must turn logs/account changes into the shared `LifecycleEvent` contract and validate the source accounts before risk predicates such as LTV are trusted. `MemoryDedupeStore` is for tests; production workers need a durable atomic claim store and a replay cursor.
