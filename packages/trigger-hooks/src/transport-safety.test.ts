import assert from "node:assert/strict";
import { it } from "node:test";
import { createHermesDispatcher } from "./hermes.js";
import type { WakeRequest } from "./index.js";
import { createOpenClawDispatcher } from "./openclaw.js";
import { createWebhookDispatcher } from "./webhook.js";

const request = {
  trigger: { id: "liquidation-review", predicate: {} },
  observation: {
    chain: "solana",
    source: "webhook",
    sourceId: "0",
    signature: "tx-3",
    slot: 77n,
    blockTime: null,
    programId: "Treasury",
    sourceVerified: true,
    receivedAt: new Date(0).toISOString(),
  },
  dedupeKey: "liquidation-review:tx-3:0",
} satisfies WakeRequest;

it("accepts a bracketed IPv6 loopback endpoint over plain HTTP", () => {
  assert.doesNotThrow(() => createWebhookDispatcher({ url: "http://[::1]:4000/wake" }));
  assert.doesNotThrow(() => createOpenClawDispatcher({ gatewayUrl: "http://[::1]:4000", token: "hook-token" }));
  assert.doesNotThrow(() => createHermesDispatcher({ gatewayUrl: "http://[::1]:4000", route: "review", secret: "secret" }));
});

it("rejects plain HTTP for a non-loopback host", () => {
  assert.throws(() => createWebhookDispatcher({ url: "http://10.0.0.1/wake" }), /HTTPS unless it targets loopback/);
  assert.throws(() => createOpenClawDispatcher({ gatewayUrl: "http://agent.example", token: "hook-token" }), /HTTPS unless it targets loopback/);
  assert.throws(
    () => createHermesDispatcher({ gatewayUrl: "http://agent.example", route: "review", secret: "secret" }),
    /HTTPS unless it targets loopback/,
  );
});

it("rejects an empty webhook bearer token or HMAC secret", () => {
  assert.throws(() => createWebhookDispatcher({ url: "https://agent.example/wake", bearerToken: "" }), /bearer token cannot be empty/);
  assert.throws(() => createWebhookDispatcher({ url: "https://agent.example/wake", hmacSecret: "" }), /HMAC secret cannot be empty/);
});

it("refuses redirects for every outbound dispatcher", async () => {
  const seen: Array<RequestInit | undefined> = [];
  const capture = async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init);
    return new Response(null, { status: 204 });
  };

  const dispatchers = [
    createWebhookDispatcher({ url: "https://agent.example/wake", fetch: capture }),
    createOpenClawDispatcher({ gatewayUrl: "https://agent.example", token: "hook-token", fetch: capture }),
    createHermesDispatcher({ gatewayUrl: "https://agent.example", route: "review", secret: "secret", fetch: capture }),
  ];

  await Promise.all(dispatchers.map((dispatcher) => dispatcher.wake(request)));

  assert.deepEqual(seen.map((init) => init?.redirect), ["error", "error", "error"]);
});
