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

## Agent integrations available now

The TypeScript package exposes dispatchers through `@agent-hooks/trigger-hooks/openclaw`, `/hermes`, and `/webhook`. These send a wake request after the host's `TriggerEngine` matches an observation. They do not install or configure software on the agent host. Configure the receiving endpoint and credentials in your own OpenClaw, Hermes, or worker deployment, and keep secrets in your deployment's secret manager.

### OpenClaw

Enable the Gateway hooks feature and configure an operator-owned hook token in OpenClaw using its [Gateway hooks documentation](https://docs.openclaw.ai/gateway/config-hooks). Then use the built-in `/hooks/wake` adapter:

```ts
import { createOpenClawDispatcher } from "@agent-hooks/trigger-hooks/openclaw";

const dispatcher = createOpenClawDispatcher({
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL!,
  token: process.env.OPENCLAW_HOOK_TOKEN!,
  agentId: "finance-reviewer", // optional; use an agent configured on your Gateway
  mode: "now",
});
```

The dispatcher sends the matching observation summary in `text`, using Bearer authentication. OpenClaw must be configured to accept the hook. Review the gateway's exposure and access controls; use HTTPS except for a loopback development endpoint. `mode: "now"` asks the host to wake promptly; it is not a latency or execution guarantee.

### Hermes Agent

Create a webhook route on your Hermes deployment, set a strong route secret, and optionally restrict the route to the tools needed for analysis. The adapter sends the [Hermes Generic V2 signed request](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks):

```ts
import { createHermesDispatcher } from "@agent-hooks/trigger-hooks/hermes";

const dispatcher = createHermesDispatcher({
  gatewayUrl: process.env.HERMES_GATEWAY_URL!,
  route: "finance-review",
  secret: process.env.HERMES_WEBHOOK_SECRET!,
  profile: "default", // optional Hermes profile
});
```

Each request includes the Generic V2 timestamp/signature headers and a deterministic request ID. Configure the matching secret on Hermes. A valid signature proves possession of that secret and protects request integrity; it does not prove the underlying chain observation is accurate or safe to act on.

### Generic agent webhook

For LangGraph, CrewAI, a private financial bot, or another agent host, expose an HTTPS endpoint that accepts JSON and queues an idempotent run. This is a generic HTTP integration, not a framework-specific plugin:

```ts
import { createWebhookDispatcher } from "@agent-hooks/trigger-hooks/webhook";

const dispatcher = createWebhookDispatcher({
  url: process.env.AGENT_WAKE_URL!,
  bearerToken: process.env.AGENT_WAKE_TOKEN,
  hmacSecret: process.env.AGENT_WAKE_HMAC_SECRET,
});
```

The payload identifies the trigger, chain, transaction signature, slot, program, and optional normalized lifecycle fields. The receiver should authenticate the request, validate timestamp skew if checking HMAC, deduplicate using `x-agent-hooks-delivery`, persist the wake before acknowledging, and treat event values as input to its own verification—not as instructions to transact.

### Connect a dispatcher to trigger matching

The application's observer/decoder owns chain verification and provides a `ChainObservation` marked as verified only after that work succeeds:

```ts
import { TriggerEngine } from "@agent-hooks/trigger-hooks";

const engine = new TriggerEngine({
  triggers: [{
    id: "solana-liquidation-review",
    predicate: { eventKinds: ["beforeLiquidate"], minLtvBps: 8_000 },
  }],
  dispatcher, // one of the dispatchers above
  dedupe: durableDedupeStore, // implement DedupeStore with an atomic persistent claim
});

await engine.ingest(verifiedObservation);
```

`MemoryDedupeStore` is the default and is only suitable for a single process with ephemeral state (for example, a prototype). A production worker must inject persistent atomic deduplication and durable delivery/retry; those facilities are not included in this package yet. The `dispatcher` variable above is selected from the adapter-specific examples.

## Production checklist

- Use a durable cursor and atomic dedupe key such as `trigger_id + transaction_signature + event_index`.
- Reconcile RPC notifications with fetched, confirmed/finalized transactions and validate program IDs, account ownership, instruction discriminators, and event indexes.
- Add protocol-specific decoders for Marginfi, Kamino, Solend, whale transfers, and DAO proposal accounts.
- Put the wake request on a durable queue with retry, dead-letter handling, rate limits, and idempotent agent runs.
- Keep private keys in a separate transaction service. A trigger can create a proposal; it must not silently sign or broadcast.
