import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { it } from "node:test";
import { createHermesDispatcher } from "./hermes.js";
import type { WakeRequest } from "./index.js";

const request = {
  trigger: { id: "dao-proposal", predicate: {} },
  observation: { chain: "solana", source: "webhook", sourceId: "0", signature: "tx-2", slot: 55n, blockTime: null, programId: "Governance", sourceVerified: true, receivedAt: new Date(0).toISOString() },
  dedupeKey: "dao-proposal:tx-2:0",
} satisfies WakeRequest;

it("signs Hermes Generic V2 webhooks for an owned route", async () => {
  let captured: { url?: string; init: RequestInit | undefined } = { init: undefined };
  const dispatcher = createHermesDispatcher({
    gatewayUrl: "http://127.0.0.1:8644",
    route: "solana-risk",
    profile: "finance",
    secret: "route-secret",
    nowSeconds: () => 1_700_000_000,
    fetch: async (url, init) => { captured = { url: String(url), init }; return new Response("{}", { status: 200 }); },
  });
  await dispatcher.wake(request);
  const headers = captured.init?.headers as Record<string, string>;
  const body = String(captured.init?.body);
  const expected = createHmac("sha256", "route-secret").update(`1700000000.${body}`).digest("hex");
  assert.equal(captured.url, "http://127.0.0.1:8644/p/finance/webhooks/solana-risk");
  assert.equal(headers["x-webhook-signature-v2"], expected);
  assert.equal(headers["x-request-id"], request.dedupeKey);
});
