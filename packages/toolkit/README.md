# `@agent-hooks/toolkit`

An independent, open-source TypeScript package for Solana hook evaluation and agents that learn from execution outcomes. MIT licensed. It has no required runtime dependencies.

```sh
npm install @agent-hooks/toolkit
```

The package is split into focused importable surfaces:

```ts
import { SolanaHookEngine } from "@agent-hooks/toolkit/solana";
import { LearningAgent, MemoryExperienceStore } from "@agent-hooks/toolkit/agents";
import { DailyXWorkflow } from "@agent-hooks/toolkit/x";
import { TreasuryReviewQueue } from "@agent-hooks/toolkit/treasury";
import { researchAssets } from "@agent-hooks/toolkit/research";
import { createXResearchClient } from "@agent-hooks/toolkit/x-research";
import { createXApiPublisher, createMoltbookPublisher } from "@agent-hooks/toolkit/social";
```

## Social research and publishing

The X research client uses read-only X API v2 user lookup and timeline endpoints. It accepts public handles, requests a bounded recent-post window, and returns profile metrics with timestamped post links. X API access and per-resource pricing are controlled by X; set a usage budget and cache results. It does not scrape the website, bypass access controls, or access protected/private profiles.

```ts
import { createXResearchClient } from "@agent-hooks/toolkit/x-research";

const xResearch = createXResearchClient({ bearerToken: process.env.X_BEARER_TOKEN! });
const snapshot = await xResearch.researchProfile("XDevelopers", 10);
// Give the model this source-attributed snapshot, not an unrestricted browser.
```

`@agent-hooks/toolkit/social` also exports narrow X and Moltbook publishing adapters. The X adapter requires an OAuth user access token that can create posts; the Moltbook adapter sends its bearer key only to `https://www.moltbook.com/api/v1/posts` and refuses redirects. Neither adapter retries an uncertain publish automatically. Use `DailyXWorkflow` or your own durable approval queue around the X publisher; Moltbook keys belong only in server-side secrets, never in model prompts. Register and claim the Moltbook agent manually using [Moltbook's current skill instructions](https://www.moltbook.com/skill.md). Respect the platform's current posting limits, and verify the result in the feed after a timeout before retrying.

```ts
import { createXApiPublisher, createMoltbookPublisher } from "@agent-hooks/toolkit/social";

const xPublisher = createXApiPublisher({ userAccessToken: process.env.X_USER_ACCESS_TOKEN! });
const moltbook = createMoltbookPublisher({ apiKey: process.env.MOLTBOOK_API_KEY! });

// Call these only after the configured approval policy accepts the draft.
const xResult = await xPublisher.publish("Source-linked public research summary.");
const moltbookResult = await moltbook.publish({
  submolt: "general", title: "Research update", content: "Source-linked public research summary.",
});
```

The repository includes a conservative starting policy at [`examples/social-agent-policy.json`](../../examples/social-agent-policy.json): five X profiles per run, ten posts per profile, read-only AAE access, one daily post per platform, and no automated replies/comments or direct push to `main`. Treat it as configuration guidance—the host must enforce these limits in durable state.

## Financial market research

`@agent-hooks/toolkit/research` includes read-only CoinGecko `/coins/markets` and DEX Screener token-pair adapters. It returns price, market cap, volume, 24-hour movement, liquidity, pair age, provider labels, and observation/report timestamps. CoinGecko IDs and token addresses are explicit inputs; symbols are not treated as unique asset identities. Missing provider fields remain `null`, malformed values fail closed, and each report includes data-quality caveats.

```ts
import { researchAssets } from "@agent-hooks/toolkit/research";

const report = await researchAssets({
  coinIds: ["solana", "bitcoin"],
  tokenAddresses: ["<solana-token-mint>"],
}, {
  coingeckoApiKey: process.env.COINGECKO_API_KEY, // optional, depending on provider access/limits
});
console.log(report.generatedAt, report.assets, report.pairs, report.caveats);
```

This is a provider-integration foundation, not a complete institutional terminal: it does not yet provide historical candles, order books, news, fundamentals, portfolio accounting, cross-source reconciliation, or investment recommendations. Provider observations can be stale, incomplete, or manipulated; use independent sources and your own risk controls before an agent acts.

### Fresh market alerts

The toolkit bounds each research report to 25 unique token-address lookups, deduplicates repeated requests, labels DEX data with its local receipt time, and rejects negative price, liquidity, and volume fields. The `@agent-hooks/toolkit/market-alerts` evaluator compares a report to explicit rules using exact CoinGecko IDs or chain-qualified pair addresses, a maximum data age, and an optional minimum pair-liquidity floor:

```ts
import { researchAssets } from "@agent-hooks/toolkit/research";
import { evaluateMarketAlerts } from "@agent-hooks/toolkit/market-alerts";

const report = await researchAssets({ coinIds: ["solana"] });
const alerts = evaluateMarketAlerts(report, [{
  id: "solana-move-review",
  assetKey: "coingecko:solana",
  metric: "change24hPct",
  operator: "gte",
  threshold: 8,
  severity: "warning",
  maxAgeMs: 120_000,
}]);
// Queue matched, source-attributed alerts for agent review; they are not trade instructions.
```

Rules and units are shown in [`examples/crypto-market-alerts.json`](../../examples/crypto-market-alerts.json). `maxAgeMs` is checked against the local provider-response time. It does not prove upstream price freshness, chain truth, or adequate market depth. The evaluator only creates deterministic alert records; persistent delivery, cooldowns, agent wake-up, policy, simulation, approval, and signing remain host responsibilities.

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

`DailyXWorkflow` lets an agent draft one active UTC-dated update per workflow instance, linked to the experience IDs it summarizes. It defaults to a 10,000-draft history cap. The 280-code-point limit is a local bound; the X API remains authoritative for accepted post length. Approval records an operator label and time; the host must authenticate that identity and enforce daily uniqueness across processes if multiple workers run. The publisher receives a stable draft ID as its idempotency key. Concurrent publishes are blocked, and an ambiguous network failure moves the draft to `publish-unknown`, which must be reconciled with X before any retry. This workflow keeps state in memory, so use a durable application store for production. If no X publisher is configured, approved copy can be posted manually. Supply the model and X API integration from your application; credentials are never requested, stored, or included here.

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
