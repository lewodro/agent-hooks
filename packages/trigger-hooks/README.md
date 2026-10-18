# `@agent-hooks/trigger-hooks`

Solana-first event ingress and TypeScript adapters for waking an off-chain agent when a verified observation matches a deterministic trigger.

| Target | Adapter | Transport |
| --- | --- | --- |
| [OpenClaw Gateway](https://docs.openclaw.ai/gateway/config-hooks) | `@agent-hooks/trigger-hooks/openclaw` | Bearer-authenticated `/hooks/wake` |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks) | `@agent-hooks/trigger-hooks/hermes` | Signed Generic V2 webhook |
| LangGraph, CrewAI, custom worker | `@agent-hooks/trigger-hooks/webhook` | HTTPS JSON, optional bearer token and HMAC |
| Agent-created Solana token proposal | `@agent-hooks/trigger-hooks/launch-proposals` | Authenticated request to Rust Trigger Service; human review required |

These are outbound dispatchers: configure the receiving endpoint on your own agent host. LangGraph and CrewAI are webhook-compatible examples, not bundled framework plugins.

## Install

The package is configured for public npm publication, but has not been published yet. For development inside this repository:

```bash
pnpm install
pnpm --filter @agent-hooks/trigger-hooks build
```

After a release, install with `npm install @agent-hooks/trigger-hooks`. The package requires Node.js 22 or newer. Its Solana event types import `@agent-hooks/contracts`, which is currently a workspace dependency; publishing/releasing this package requires that dependency to be independently resolvable from npm.

### npm release path

This repository has not published either package. Before the first public release, an npm maintainer needs to:

1. Confirm the `@agent-hooks` npm organization and release permissions, then build and publish `@agent-hooks/contracts` first (currently version `0.1.0`).
2. Build `@agent-hooks/trigger-hooks`, inspect its packed contents with `pnpm --filter @agent-hooks/trigger-hooks pack:check`, and confirm its packed dependency points to a released `@agent-hooks/contracts` version—not a workspace-only specifier.
3. Publish the trigger package only after the tarball can install in a clean external TypeScript project. Verify all three adapter subpath imports from the installed tarball and keep the published README, license, and declarations in the package.
4. For later releases, increment package versions intentionally and publish the contracts dependency before any consumer that requires its new API. Do not commit npm tokens; use the maintainer's trusted publishing or local npm login flow.

The `pack:check` script currently runs `npm pack --dry-run`; it is a contents preview, not proof that the package installs outside this pnpm workspace. The `prepack` lifecycle runs this package's tests and build when pnpm packs it.

## Choose an agent dispatcher

```ts
import { createOpenClawDispatcher } from "@agent-hooks/trigger-hooks/openclaw";

const openclaw = createOpenClawDispatcher({
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL!,
  token: process.env.OPENCLAW_HOOK_TOKEN!,
  agentId: "finance-reviewer",
  mode: "now",
});
```

Or configure Hermes:

```ts
import { createHermesDispatcher } from "@agent-hooks/trigger-hooks/hermes";

const hermes = createHermesDispatcher({
  gatewayUrl: process.env.HERMES_GATEWAY_URL!,
  route: "finance-review",
  secret: process.env.HERMES_WEBHOOK_SECRET!,
});
```

Or send to your own worker endpoint:

```ts
import { createWebhookDispatcher } from "@agent-hooks/trigger-hooks/webhook";

const customAgent = createWebhookDispatcher({
  url: process.env.AGENT_WAKE_URL!,
  bearerToken: process.env.AGENT_WAKE_TOKEN,
  hmacSecret: process.env.AGENT_WAKE_HMAC_SECRET,
});
```

Use exactly one dispatcher as the `TriggerEngine`'s `dispatcher`. URLs must use HTTPS except for loopback development addresses. Never commit tokens or webhook secrets.

## Agent-authored token launch proposals

Expose this client only as a narrow tool in your agent runtime. It submits a validated, fingerprinted request to the Rust service using a separate agent credential:

```ts
import { createTokenLaunchProposalClient } from "@agent-hooks/trigger-hooks/launch-proposals";

const launchClient = createTokenLaunchProposalClient({
  serviceUrl: process.env.TRIGGER_SERVICE_URL!,
  agentToken: process.env.TRIGGER_AGENT_TOKEN!,
});

const proposal = await launchClient.propose({
  name: "Example Finance Token",
  symbol: "EFT",
  decimals: 6,
  initialSupply: 1_000_000_000n, // exact integer base units
  network: "devnet",
  metadataUri: "https://example.com/token.json",
});
console.log(proposal.id, proposal.status); // pending_review
```

An independent reviewer credential is required to approve/reject the proposal. Neither the client nor Trigger Service creates a mint, signs, or broadcasts. The approved fingerprint must be revalidated by a separate wallet-backed launch app before the human signs. See the [Rust service setup](../../packages/trigger-service/README.md).

## Match and deliver a trigger

```ts
import {
  MemoryDedupeStore,
  TriggerEngine,
  type ChainObservation,
} from "@agent-hooks/trigger-hooks";
import { createOpenClawDispatcher } from "@agent-hooks/trigger-hooks/openclaw";

const engine = new TriggerEngine({
  triggers: [{
    id: "liquidation-review",
    predicate: { eventKinds: ["beforeLiquidate"], minLtvBps: 8_000 },
  }],
  dispatcher: createOpenClawDispatcher({
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL!,
    token: process.env.OPENCLAW_HOOK_TOKEN!,
  }),
  // Demo only. Supply an atomic durable store in a multi-process deployment.
  dedupe: new MemoryDedupeStore(),
});

declare const verifiedObservation: ChainObservation; // produced by your trusted observer/decoder
await engine.ingest(verifiedObservation);
```

`TriggerEngine` rejects observations unless `sourceVerified` is true, checks deterministic predicates, and uses the injected dedupe store before calling the dispatcher. The boolean is an assertion supplied by the host—not a cryptographic proof. `SolanaLogSource` filters logs for a subscribed program but does not decode Marginfi/Kamino/Solend events or independently verify account ownership, whale transfer meaning, or DAO proposal state.

## Delivery and trust boundaries

- Delivery is at-least-once, not exactly-once. A failed dispatch releases its dedupe claim so the host can retry; the receiving worker must be idempotent.
- `MemoryDedupeStore` is process-local and volatile. Production requires a durable atomic claim store, replay cursor, queue, retry/dead-letter policy, and monitoring. These are host responsibilities, not included components today.
- HMAC authenticates payload integrity between parties that share the secret; it does not establish source-chain truth. Validate RPC/indexer results and decode protocol events before creating trusted observations.
- A wake asks an agent to inspect an event. Keep the agent's analysis tools separate from signing authority; proposal, simulation, policy, human approval, and transaction execution belong in separately controlled services.

See the repository's [Trigger Hooks integration guide](../../docs/trigger-hooks.md), [architecture](../../docs/architecture.md), and [security assumptions](../../docs/security.md).
