# @agent-hooks/agent-brain

The experience-memory boundary for agents that operate hook compositions. Schema-versioned records can retain a normalized `LifecycleEvent`, per-hook trace, outcome feedback, and provenance labels, then return relevant history to an off-chain planner.

`AgentBrain` does not train or host a model, subscribe to a chain, or verify RPC responses. It defaults missing provenance to `unknown/unverified`; `recall({ verifiedOnly: true })` filters for caller-labeled confirmed/finalized chain records with a network, transaction ID, and slot/block height. This is a data-shape check, not cryptographic verification: only record those statuses after an independently trusted observer verifies them.

Rewards must be finite and include a `rewardUnit` (for example, `normalized_0_1` or `usd_e8`) so a planner cannot accidentally compare different scales as if they were equivalent.

The storage interface is deliberately replaceable. Implementations should append idempotently by `Experience.id`, preserve the immutable record, and apply query filters (including `verifiedOnly`) before limiting results. Durable writes should happen before records are made available for retrieval.

`PostgresExperienceStore` is a driver-neutral durable adapter. Pass it an application-owned PostgreSQL pool/client that implements `PostgreSqlExecutor`, then call `initialize()` from a controlled migration step. It creates an append-only JSONB table, indexes event, composition, outcome, hook, and tag fields, and supports bounded idempotent inserts. Reusing an experience ID with different content is rejected. `recall()` can filter by adapter, event kind, composition, outcome, hook ID, tag, time window, and caller-labeled verified-chain status. The adapter does not open connections or load credentials. It does not cryptographically verify RPC evidence.

```ts
import { AgentBrain, PostgresExperienceStore, type PostgreSqlExecutor } from "@agent-hooks/agent-brain";

declare const applicationPool: PostgreSqlExecutor;
const store = new PostgresExperienceStore(applicationPool);
await store.initialize(); // Prefer invoking this from a migration job.
const brain = new AgentBrain(store);
```

`MemoryExperienceStore` is the included bounded in-process implementation for local development and tests. It defaults to 10,000 records, caps query results at 200, keeps records immutable, and evicts the oldest appended record when full. It is volatile: use a durable `ExperienceStore` implementation for production agents or any treasury-related workflow.

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
