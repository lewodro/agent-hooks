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

`SolanaHookEngine` runs deterministic host-side hooks over normalized Solana lifecycle events. Hooks are ordered by priority; nonmatching hooks are skipped; a rejection ends evaluation; accepted effects are returned as proposals for the host. The engine does not send transactions, call RPC, or execute model code. This keeps model inference and network I/O away from action-critical evaluation.

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

`MemoryExperienceStore` is a small in-memory example implementing `ExperienceStore`. Persist records in a durable store in real deployments. `LearningAgent` retrieves matching, attributed experiences and passes them to an application-provided planner. This is an experience feedback loop—not automatic model-weight training or a guarantee that future decisions improve.

`DailyXWorkflow` lets an agent draft a daily update linked to the experience IDs it summarizes. A reviewer must approve before `publish()` is allowed. If no X publisher is configured, approved copy can be posted manually. Supply the model and X API integration from your application; credentials are never requested, stored, or included here.

```ts
const dailyX = new DailyXWorkflow({
  async write({ date, experiences }) {
    const ids = experiences.slice(0, 3).map((item) => item.id).join(", ");
    return `${date}: Agent Hooks update from reviewed outcomes. Evidence: ${ids || "no new observations"}`;
  },
});

const post = await dailyX.draft(new Date().toISOString().slice(0, 10), recentExperiences);
// Present post.text and its sourceExperienceIds to a person for review.
dailyX.approve(post.id);
// Without an XPublisher, export the approved copy for manual posting.
```

## Wallets and treasury

`TreasuryReviewQueue` validates allowlisted destinations and assets, per-transfer and daily proposal limits, and records a named human decision. It is a proposal/review ledger only: it has no signing method and cannot send funds. Use a multisig or hardware/MPC signer behind a separately secured service, with independent human approval, spending limits, audit records, and a delay for material changes. Do not give an LLM a seed phrase or unrestricted wallet key. The X posting credential must remain separate from treasury authority.

The proposal queue is in memory; it is not a durable treasury ledger or an enforcement layer for actual wallet transfers. The host application must authenticate reviewers—the `reviewer` string is an audit label, not authentication. Production integrations must re-check limits against durable on-chain/accounting state immediately before their own signing flow.

## License and status

MIT. Source, build configuration, and usage docs are included in this repository. Package metadata is configured for a public npm release; no release has been published by this build. See the repository root for the wider Rust runtime, protocol adapters, Anchor prototype, and current implementation limits.
