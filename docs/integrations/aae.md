# Autonomous Agent Economy (AAE)

Agent Hooks can wake an AAE worker when the AAE Rust economy coordinator emits an event such as `EntryPaymentConfirmed`, `SettlementConfirmed`, `RefundConfirmed`, or `EconomyFailed`. The adapter preserves AAE's match ID, event sequence, event type, and exact base-unit strings in a signed webhook envelope.

## Current integration boundary

AAE's Rust `EconomyEvent` wire record has `schema_version`, `seq`, `match_id`, a flattened `type` and event fields, and a `projection`. AAE's current HTTP surface exposes read-only match SSE snapshots and economy projections; it does not currently expose the individual `EconomyEvent` records on a public route. Consequently, the Agent Hooks package is ready for an event sink, but the two repositories are not connected automatically.

To connect them, add an AAE-side event sink at the Rust coordinator's existing event emission boundary. Persist or enqueue the serialized event to a bounded outbox, and have a separate worker forward each record to your Agent Hooks webhook with the delivery ID `aae:<match_id>:<seq>`. Keep the economic transition authoritative in AAE; webhook failure must not roll back or delay funding/settlement. Retry the same delivery ID and let the receiver deduplicate it. Do not reconstruct a supposed chain receipt from an SSE projection.

For events that refer to real chain transactions, include the confirmed transaction signature and finality in the AAE event/outbox record before presenting them to an agent as chain-confirmed. Mock and local-validator events must remain labeled as such. A webhook HMAC authenticates the sender; it does not verify an on-chain transaction.

## TypeScript receiver delivery

Install the package after publishing, or use the workspace package during development:

```ts
import {
  createAaeWebhookDispatcher,
  parseAaeEconomyEvent,
} from "@agent-hooks/trigger-hooks/aae";

const notifyAgent = createAaeWebhookDispatcher({
  url: process.env.AAE_AGENT_WEBHOOK_URL!,
  bearerToken: process.env.AAE_AGENT_WEBHOOK_TOKEN,
  hmacSecret: process.env.AAE_AGENT_WEBHOOK_HMAC,
});

// Call from the AAE outbox consumer with the decoded Rust EconomyEvent JSON.
const event = parseAaeEconomyEvent(outboxRecord);
await notifyAgent.wake(event);
```

The adapter sends a JSON envelope with `schema: "agent-hooks/aae-economy-event@1"`, `trust: "notification_only"`, and stable `delivery_id`. It rejects unsafe external HTTP URLs and does not follow redirects. Use HTTPS in deployment; loopback HTTP is permitted for development.

The repository includes a Rust-shaped mock settlement event at [`examples/aae-economy-event.json`](../../examples/aae-economy-event.json) for receiver and outbox integration work. Its `payment_mode` is explicitly `mock`; it is a schema fixture, not a real transaction receipt.

## Trust and economic safety

- This integration sends notifications. It does not advance an AAE match, create/confirm receipts, settle a match, sign a transaction, or control a wallet.
- The agent may inspect the event and produce a proposal. AAE remains the source of truth for its coordinator state and receipt verification.
- Keep mock, local-validator, and devnet environments distinct. Never interpret mock amounts as chain balances; amounts are exact base-unit decimal strings.
- Use an authenticated durable outbox, enforce receiver-side idempotency using `delivery_id`, bound retries and payload sizes, and monitor undelivered records.
- Keep mainnet disabled until the AAE operator independently implements and reviews its production signing and settlement controls.

See [AAE's integration and security documentation](https://github.com/lewodro/autonomous-agent-economy) for its current implementation and environment limits.
