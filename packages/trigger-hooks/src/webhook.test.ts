import assert from "node:assert/strict";
import { it } from "node:test";
import { createWebhookDispatcher } from "./webhook.js";
import type { WakeRequest } from "./index.js";

const request = {
  trigger: { id: "treasury", predicate: {} },
  observation: { chain: "solana", source: "webhook", sourceId: "0", signature: "tx-3", slot: 77n, blockTime: null, programId: "Treasury", sourceVerified: true, receivedAt: new Date(0).toISOString() },
  dedupeKey: "treasury:tx-3:0",
} satisfies WakeRequest;

it("delivers a signed generic agent webhook", async () => {
  let headers: Record<string, string> = {};
  const dispatcher = createWebhookDispatcher({
    url: "https://agent.example/wake",
    bearerToken: "agent-token",
    hmacSecret: "signing-secret",
    fetch: async (_url, init) => { headers = init?.headers as Record<string, string>; return new Response(null, { status: 204 }); },
  });
  await dispatcher.wake(request);
  assert.equal(headers.authorization, "Bearer agent-token");
  assert.match(headers["x-agent-hooks-signature"] ?? "", /^sha256=[0-9a-f]{64}$/);
  assert.equal(headers["x-agent-hooks-delivery"], request.dedupeKey);
});
