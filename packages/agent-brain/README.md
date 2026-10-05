# @agent-hooks/agent-brain

The experience-memory boundary for agents that operate hook compositions. Schema-versioned records can retain a normalized `LifecycleEvent`, per-hook trace, outcome feedback, and provenance labels, then return relevant history to an off-chain planner.

`AgentBrain` does not train or host a model, subscribe to a chain, or verify RPC responses. It defaults missing provenance to `unknown/unverified`; `recall({ verifiedOnly: true })` filters for caller-labeled confirmed/finalized chain records with a network, transaction ID, and slot/block height. This is a data-shape check, not cryptographic verification: only record those statuses after an independently trusted observer verifies them.

Rewards must be finite and include a `rewardUnit` (for example, `normalized_0_1` or `usd_e8`) so a planner cannot accidentally compare different scales as if they were equivalent.

The storage interface is deliberately replaceable. Implementations should append idempotently by `Experience.id`, preserve the immutable record, and apply query filters (including `verifiedOnly`) before limiting results. Durable writes should happen before records are made available for retrieval.

`brain.subscribe(listener, options)` delivers each newly persisted experience to in-process consumers, with awaited delivery and a maximum of 64 listeners. This is a low-latency local fan-out primitive, not a cross-process event broker. If a listener fails, `observe()` throws `ExperienceNotificationError` after the record has already been stored; retry with the same ID and make consumers idempotent because delivery is at-least-once.

```ts
await brain.observe({
  event,
  feedback: {
    compositionId: "sol-usdc-v1",
    hookProgramIds: ["<hook-program-id>"],
    accepted: true,
    outcome: "executed",
    reward: 0.92,
    rewardUnit: "normalized_0_1",
  },
  evidence: {
    channel: "chain",
    status: "finalized",
    network: "solana-mainnet",
    transactionId: "<signature>",
    slot: 123,
  },
  trace: [{ hookId: "<hook-program-id>", decision: "accepted" }],
  tags: ["solana", "borrow-policy"],
});

const confirmedHistory = await brain.recall({ verifiedOnly: true, limit: 50 });
```
