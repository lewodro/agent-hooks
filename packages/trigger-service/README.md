# Trigger Hooks service

This is the runnable Rust mockup for on-chain-to-agent Trigger Hooks. It accepts observations from an RPC/indexer bridge, applies deterministic triggers, persists dedupe state and queued wake jobs, and exposes a small HTTP API.

Start the service in terminal 1:

```bash
TRIGGER_WEBHOOK_SECRET=dev-webhook-secret \
TRIGGER_AGENT_SECRET=dev-agent-secret \
TRIGGER_REVIEW_SECRET=dev-review-secret \
cargo run -p agent-hooks-trigger-service
```

Then configure a trigger in terminal 2:

```bash
curl http://127.0.0.1:8787/health
curl -X POST http://127.0.0.1:8787/v1/triggers \
  -H 'authorization: Bearer dev-review-secret' \
  -H 'content-type: application/json' \
  -d '{"id":"liquidation-risk","program_id":"LendingProgram","event_kind":"beforeLiquidate","min_ltv_bps":8000}'
```

`POST /v1/observations` accepts `{signature,slot,program_id,event_kind,ltv_bps,payload}` and rejects requests unless `TRIGGER_WEBHOOK_SECRET` is configured. Send `x-agent-hooks-timestamp` and `x-agent-hooks-signature` where the signature is `sha256=<HMAC-SHA256(secret, timestamp + "." + raw_body)>`. Matching observations create idempotent `queued` wake jobs. `examples/trigger-openclaw-bridge.mjs` claims those jobs and calls the operator's OpenClaw `/hooks/wake`; run it with `TRIGGER_SERVICE_URL`, `TRIGGER_AGENT_TOKEN`, `OPENCLAW_GATEWAY_URL`, and `OPENCLAW_HOOK_TOKEN` set. The bridge only marks a job complete after OpenClaw accepts the wake.

An authenticated observer can submit a normalized Solana event like this from Node.js (after its own RPC reconciliation and program/account/event validation):

```js
import { createHmac } from "node:crypto";

const body = JSON.stringify({
  signature: "<transaction-signature>", slot: 42, program_id: "<verified-program-id>",
  event_index: 0, event_kind: "beforeLiquidate", ltv_bps: 8500, payload: {},
});
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = `sha256=${createHmac("sha256", process.env.TRIGGER_WEBHOOK_SECRET)
  .update(`${timestamp}.${body}`).digest("hex")}`;
await fetch("http://127.0.0.1:8787/v1/observations", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-agent-hooks-timestamp": timestamp,
    "x-agent-hooks-signature": signature,
  },
  body,
});
```

HMAC authenticates the observer-to-service request; it does not substitute for the RPC verification described in the code comment.

```bash
TRIGGER_SERVICE_URL=http://127.0.0.1:8787 \
TRIGGER_AGENT_TOKEN=dev-agent-secret \
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789 \
OPENCLAW_HOOK_TOKEN=your-openclaw-hook-token \
node examples/trigger-openclaw-bridge.mjs
```

## Agent-proposed token launch

An agent can submit a token-launch proposal with its `TRIGGER_AGENT_SECRET`; only a separate reviewer credential can approve or reject it:

```bash
curl -X POST http://127.0.0.1:8787/v1/token-launch-proposals \
  -H 'authorization: Bearer dev-agent-secret' \
  -H 'content-type: application/json' \
  -d '{"name":"Example Finance Token","symbol":"EFT","decimals":6,"initial_supply":"1000000000","network":"devnet","metadata_uri":"https://example.com/token.json"}'
```

Use `createTokenLaunchProposalClient()` from `@agent-hooks/trigger-hooks` inside an agent's explicitly configured tool to submit a request; the client cannot review or execute it:

```ts
import { createTokenLaunchProposalClient } from "@agent-hooks/trigger-hooks/launch-proposals";

const launchProposals = createTokenLaunchProposalClient({
  serviceUrl: process.env.TRIGGER_SERVICE_URL!,
  agentToken: process.env.TRIGGER_AGENT_TOKEN!,
});

// Register this function as a narrowly scoped tool in your agent runtime.
export async function proposeTokenLaunch(input: {
  name: string; symbol: string; decimals: number; initialSupply: string;
  network: "devnet" | "mainnet-beta"; metadataUri: string;
}) {
  return launchProposals.propose({ ...input, initialSupply: BigInt(input.initialSupply) });
}
```

The API stores an immutable fingerprint and returns `pending_review`. An operator reviews it at `POST /v1/token-launch-proposals/{id}/approve` (or `/reject`) with the reviewer credential and a JSON reviewer label. The separate credentials define the API roles; the reviewer string is an audit label, not an independent identity provider. Do not expose `TRIGGER_REVIEW_SECRET` to the agent's tool runtime.

```bash
curl -X POST "http://127.0.0.1:8787/v1/token-launch-proposals/PROPOSAL_ID/approve" \
  -H 'authorization: Bearer dev-review-secret' \
  -H 'content-type: application/json' \
  -d '{"reviewer":"operator@example.com"}'
```

Approval is **not** a token mint or transaction signature. This service does not create the mint account, attach metadata on-chain, pay rent/fees, sign, or broadcast. A separate wallet-backed launch application must revalidate the approved fingerprint, display the exact network/supply/metadata, and request the human's wallet signature. Never give the agent or this service a wallet seed phrase or unrestricted signer. The built-in service is plain HTTP and defaults to loopback; if you expose it, put it behind TLS and network access controls, use high-entropy secrets, and move beyond local JSON persistence before production.

This is intentionally a host-side wake and review boundary. It does not claim to decode Marginfi/Kamino/Solend instructions, verify arbitrary RPC data, call an LLM, sign, or broadcast transactions. Replace the file state with Postgres/Redis and place a real protocol decoder/indexer in front of it for a release deployment.
