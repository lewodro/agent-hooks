# Trigger Hooks service

This is the runnable Rust mockup for on-chain-to-agent Trigger Hooks. It accepts observations from an RPC/indexer bridge, applies deterministic triggers, persists dedupe state and queued wake jobs, and exposes a small HTTP API.

Run it locally:

```bash
TRIGGER_WEBHOOK_SECRET=dev-secret cargo run -p agent-hooks-trigger-service
curl http://127.0.0.1:8787/health
curl -X POST http://127.0.0.1:8787/v1/triggers \
  -H 'content-type: application/json' \
  -d '{"id":"liquidation-risk","program_id":"LendingProgram","event_kind":"beforeLiquidate","min_ltv_bps":8000}'
```

`POST /v1/observations` accepts `{signature,slot,program_id,event_kind,ltv_bps,payload}`. If `TRIGGER_WEBHOOK_SECRET` is set, send `x-agent-hooks-timestamp` and `x-agent-hooks-signature` where the signature is `sha256=<HMAC-SHA256(secret, timestamp + "." + raw_body)>`. Matching observations create idempotent `queued` wake jobs visible at `GET /v1/jobs`.

This is intentionally a host-side wake boundary. It does not claim to decode Marginfi/Kamino/Solend instructions, verify arbitrary RPC data, call an LLM, sign, or broadcast transactions. Replace the file state with Postgres/Redis and place a real protocol decoder/indexer in front of it for a release deployment.
