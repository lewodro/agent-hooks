# `@agent-hooks/toolkit`

An independent, open-source TypeScript package for Solana hook evaluation and agents that learn from execution outcomes. MIT licensed. It has no required runtime dependencies.

```sh
npm install @agent-hooks/toolkit
```

The package is split into four importable surfaces:

```ts
import { SolanaHookEngine } from "@agent-hooks/toolkit/solana";
import { LearningAgent, MemoryExperienceStore } from "@agent-hooks/toolkit/agents";
import { DailyXWorkflow } from "@agent-hooks/toolkit/x";
import { TreasuryReviewQueue } from "@agent-hooks/toolkit/treasury";
```

## Solana hooks and agent frameworks

`SolanaHookEngine` runs deterministic host-side hooks over normalized Solana lifecycle events. Hooks are ordered by priority; nonmatching hooks are skipped; a rejection ends evaluation; accepted effects are returned as proposals for the host. Malformed events, invalid effects, and hook exceptions fail closed. The engine does not send transactions, call RPC, or execute model code. This keeps model inference and network I/O away from action-critical evaluation.

```ts
const engine = new SolanaHookEngine([
  {
    id: "borrow-limit-v1",
    programId: "<hook-program-id>",
    priority: 10,
    events: ["beforeBorrow"],
    evaluate(event) {
      const amount = Number(event.data.amount ?? 0);
      return amount > 1_000
        ? { kind: "reject", reason: "Borrow exceeds configured cap" }
        : { kind: "accept" };
    },
  },
]);

const trace = engine.run({
  signature: "<transaction-signature>",
  slot: 123,
  timestamp: Date.now(),
  kind: "beforeBorrow",
  programId: "<protocol-program-id>",
  market: "<market-address>",
  data: { amount: 250 },
});
```

`SolanaEventSource` is the read-only seam for RPC/indexer integrations. Integrations that need transaction construction can pass reviewed proposals to their existing wallet adapter; this package intentionally does not own a signer.

## Self-improving agents and daily X workflow

`MemoryExperienceStore` is a bounded in-memory example implementing `ExperienceStore`. It defaults to 10,000 records, caps retrieval at 200, deduplicates exact retries by experience ID, rejects conflicting IDs, and returns cloned snapshots. It is still volatile: persist records in a durable, encrypted store in real deployments. `LearningAgent` retrieves matching, attributed experiences and passes them to an application-provided planner. This is an experience feedback loop—not automatic model-weight training or a guarantee that future decisions improve.

`DailyXWorkflow` lets an agent draft one active UTC-dated update linked to the experience IDs it summarizes. Approval records an operator label and time; the host must authenticate that identity. The publisher receives a stable draft ID as its idempotency key. Concurrent publishes are blocked, and an ambiguous network failure moves the draft to `publish-unknown`, which must be reconciled with X before any retry. If no X publisher is configured, approved copy can be posted manually. Supply the model and X API integration from your application; credentials are never requested, stored, or included here.

```ts
const dailyX = new DailyXWorkflow({
  async write({ date, experiences }) {
    const ids = experiences.slice(0, 3).map((item) => item.id).join(", ");
    return `${date}: Agent Hooks update from reviewed outcomes. Evidence: ${ids || "no new observations"}`;
  },
});

const post = await dailyX.draft(new Date().toISOString().slice(0, 10), recentExperiences);
// Present post.text and its sourceExperienceIds to a person for review.
dailyX.approve(post.id, authenticatedOperator.id);
// Without an XPublisher, export the approved copy for manual posting.
```

## Wallets and treasury

`TreasuryReviewQueue` creates chain-qualified proposals for Solana, Bitcoin, and Ethereum. Every allowlisted asset key is `chain:network:assetId` and every destination key is `chain:network:address`; use `treasuryAssetKey()` and `treasuryDestinationKey()` to avoid mixing networks or address formats. Proposal amounts and caps are integer smallest units (lamports, satoshis, wei, or token base units)—never JavaScript floats. Daily caps aggregate per exact chain/network/asset, since base units across different assets cannot be compared.

```ts
import {
  TreasuryReviewQueue,
  treasuryAssetKey,
  treasuryDestinationKey,
} from "@agent-hooks/toolkit/treasury";

const asset = { chain: "solana", network: "devnet", assetId: "SOL" } as const;
const destination = {
  chain: "solana",
  network: "devnet",
  address: "<reviewed-destination>",
} as const;
const treasury = new TreasuryReviewQueue({
  allowedAssets: [treasuryAssetKey(asset)],
  allowedDestinations: [treasuryDestinationKey(destination)],
  maxSingleTransfer: 50_000_000n, // 0.05 SOL in lamports
  maxDailyTransfer: 100_000_000n,
  requireHumanApproval: true,
});
const proposal = treasury.propose({
  ...asset,
  ...destination,
  amount: 10_000_000n,
  rationale: "Example only: reviewed devnet test",
});
const reviewed = treasury.review(proposal.id, "approve", authenticatedOperator.id);
// reviewed.reviewFingerprint must match the transfer content before the host's signer sees it.
```

The queue is a proposal/review ledger only: it has no signing method, wallet connection, RPC client, or transaction broadcast. Its named reviewer field is an audit label—not authentication—and the in-memory limits are not durable enforcement. Before any live transfer, a host must independently authenticate reviewers, re-check limits against durable state, validate the chain-specific transaction, and hand it to an isolated multisig/hardware/MPC signing service. Do not give an LLM a seed phrase or unrestricted wallet key. Keep X posting credentials separate from treasury authority.

The proposal queue is in memory; it is not a durable treasury ledger or an enforcement layer for actual wallet transfers. Pending and approved proposals reserve daily capacity; rejected and cancelled proposals release it. A review records the fingerprint of the transfer content. The host application must authenticate reviewers—the `reviewer` string is an audit label, not authentication. Production integrations must re-check limits against durable on-chain/accounting state immediately before their own signing flow.

## License and status

MIT. Source, build configuration, and usage docs are included in this repository. Package metadata is configured for a public npm release; no release has been published by this build. See the repository root for the wider Rust runtime, protocol adapters, Anchor prototype, and current implementation limits.
