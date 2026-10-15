import assert from "node:assert/strict";
import { it } from "node:test";
import { createOpenClawDispatcher } from "./openclaw.js";
import type { WakeRequest } from "./index.js";

const request = {
  trigger: { id: "whale", predicate: {} },
  observation: { chain: "solana", source: "webhook", sourceId: "0", signature: "tx-1", slot: 42n, blockTime: null, programId: "Program", sourceVerified: true, receivedAt: new Date(0).toISOString() },
  dedupeKey: "whale:tx-1:0",
} satisfies WakeRequest;

it("posts an authenticated OpenClaw wake payload", async () => {
  let captured: { url?: string; init: RequestInit | undefined } = { init: undefined };
  const dispatcher = createOpenClawDispatcher({
    gatewayUrl: "https://claw.example",
    token: "hook-token",
    agentId: "risk-agent",
    fetch: async (url, init) => {
      captured = { url: String(url), init };
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  await dispatcher.wake(request);
  assert.equal(captured.url, "https://claw.example/hooks/wake");
  assert.equal((captured.init?.headers as Record<string, string>).authorization, "Bearer hook-token");
  assert.match(String(captured.init?.body), /risk-agent/);
  assert.match(String(captured.init?.body), /do not sign or broadcast automatically/);
});

it("rejects plaintext non-loopback gateways", () => {
  assert.throws(() => createOpenClawDispatcher({ gatewayUrl: "http://claw.example", token: "token" }));
});
