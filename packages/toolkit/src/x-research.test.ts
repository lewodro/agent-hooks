import assert from "node:assert/strict";
import test from "node:test";
import { createXResearchClient } from "./x-research.js";

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test("X research reads a public profile and bounded recent timeline with provenance", async () => {
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const replies = [
    json({ data: { id: "2244994945", username: "XDevelopers", name: "X Developers", description: "Platform news", public_metrics: { followers_count: 3000, following_count: 20, tweet_count: 500 } } }),
    json({ data: [{ id: "123456", text: "Hello X", created_at: "2026-10-27T12:00:00.000Z", public_metrics: { like_count: 4, retweet_count: 2, reply_count: 1 } }] }),
  ];
  const client = createXResearchClient({
    bearerToken: "test-token", now: () => new Date("2026-10-27T12:01:00.000Z"),
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ url: new URL(String(input)), init });
      return replies.shift()!;
    }) as typeof fetch,
  });
  const result = await client.researchProfile("@XDevelopers", 15);
  assert.equal(result.profile.followers, 3000);
  assert.equal(result.profile.profileUrl, "https://x.com/XDevelopers");
  assert.equal(result.posts[0]?.url, "https://x.com/XDevelopers/status/123456");
  assert.equal(result.posts[0]?.likeCount, 4);
  assert.equal(result.observedAt, "2026-10-27T12:01:00.000Z");
  assert.equal(result.source, "x-api-v2");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url.hostname, "api.x.com");
  assert.equal(requests[0]?.init?.redirect, "error");
  assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer test-token");
  assert.equal(requests[1]?.url.searchParams.get("max_results"), "15");
  assert.equal(requests[1]?.url.searchParams.get("exclude"), "replies,retweets");
});

test("X research bounds profile handles, timeline size, and timeout", async () => {
  const fetch = (async () => json({})) as typeof globalThis.fetch;
  const client = createXResearchClient({ bearerToken: "token", fetch });
  await assert.rejects(client.researchProfile("https://evil.example"), /X handle/);
  await assert.rejects(client.researchProfile("person", 4), /limit/);
  await assert.rejects(client.researchProfile("person", 101), /limit/);
  assert.throws(() => createXResearchClient({ bearerToken: "token", timeoutMs: 31_000 }), /timeoutMs/);
  assert.throws(() => createXResearchClient({ bearerToken: " " }), /bearer token/);
});

test("X research rejects malformed provider metrics and API errors without parsing fake values", async () => {
  const malformedReplies = [
    json({ data: { id: "1", username: "user", name: "User", public_metrics: { followers_count: -1 } } }),
    json({ data: [] }),
  ];
  const malformed = createXResearchClient({ bearerToken: "token", fetch: (async () => malformedReplies.shift()!) as typeof fetch });
  await assert.rejects(malformed.researchProfile("user"), /metric followers_count/);
  const unavailable = createXResearchClient({ bearerToken: "token", fetch: (async () => new Response("rate limited", { status: 429 })) as typeof fetch });
  await assert.rejects(unavailable.researchProfile("user"), /X API request failed \(429\)/);
});
