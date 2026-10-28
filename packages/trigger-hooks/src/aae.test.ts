import assert from "node:assert/strict";
import { it } from "node:test";
import { createAaeWebhookDispatcher, parseAaeEconomyEvent } from "./aae.js";

const event = {
  schema_version: 1,
  seq: 7,
  match_id: "match_123",
  type: "SettlementConfirmed",
  winner: "agent_1",
  amount: "1000000",
  projection: { payment_mode: "mock", state: "settled", settlement_status: "completed", pot_amount: "1000000" },
};

it("accepts AAE versioned events and preserves exact base-unit strings", () => {
  assert.equal(parseAaeEconomyEvent(event).projection?.pot_amount, "1000000");
  assert.throws(() => parseAaeEconomyEvent({ ...event, schema_version: 2 }), /unsupported/);
  assert.throws(() => parseAaeEconomyEvent({ ...event, seq: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
  assert.throws(() => parseAaeEconomyEvent({ ...event, projection: { pot_amount: 1_000_000 } }), /base-unit string/);
});

it("sends an idempotent notification-only webhook with HMAC provenance", async () => {
  let sentBody = "";
  let sentHeaders: Record<string, string> = {};
  const dispatcher = createAaeWebhookDispatcher({
    url: "https://agent.example/aae",
    bearerToken: "agent-token",
    hmacSecret: "shared-secret",
    nowSeconds: () => 123,
    fetch: async (_url, init) => {
      sentBody = String(init?.body);
      sentHeaders = init?.headers as Record<string, string>;
      return new Response(null, { status: 202 });
    },
  });
  const envelope = await dispatcher.wake(event);
  assert.equal(envelope.delivery_id, "aae:match_123:7");
  assert.equal(envelope.trust, "notification_only");
  assert.equal(sentHeaders.authorization, "Bearer agent-token");
  assert.equal(sentHeaders["x-agent-hooks-delivery"], envelope.delivery_id);
  assert.match(sentHeaders["x-agent-hooks-signature"] ?? "", /^sha256=[0-9a-f]{64}$/);
  assert.equal(JSON.parse(sentBody).event.amount, "1000000");
});

it("rejects credential-bearing or insecure external webhook URLs", () => {
  assert.throws(() => createAaeWebhookDispatcher({ url: "http://agent.example/wake" }), /HTTPS/);
  assert.throws(() => createAaeWebhookDispatcher({ url: "https://user:pass@agent.example/wake" }), /credentials/);
});
