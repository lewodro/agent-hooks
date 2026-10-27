import assert from "node:assert/strict";
import test from "node:test";
import { createMoltbookPublisher, MoltbookPublicationUncertainError } from "./moltbook.js";

test("Moltbook publisher sends approved text to the canonical host only", async () => {
  let url = "";
  let request: RequestInit | undefined;
  const publisher = createMoltbookPublisher({
    apiKey: "moltbook-test-key",
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      url = String(input); request = init;
      return new Response(JSON.stringify({ success: true, data: { post: { id: "post-123" } } }), { status: 201 });
    }) as typeof fetch,
  });
  assert.deepEqual(await publisher.publish({ submolt: "agent-finance", title: "Research note", content: "Public market data, source-linked." }), {
    postId: "post-123", postUrl: "https://www.moltbook.com/post/post-123",
  });
  assert.equal(url, "https://www.moltbook.com/api/v1/posts");
  assert.equal(request?.redirect, "error");
  assert.equal(new Headers(request?.headers).get("authorization"), "Bearer moltbook-test-key");
  assert.equal(JSON.parse(String(request?.body)).submolt, "agent-finance");
});

test("Moltbook publisher validates payloads and does not blindly retry ambiguous sends", async () => {
  let calls = 0;
  const publisher = createMoltbookPublisher({ apiKey: "key", fetch: (async () => { calls += 1; throw new Error("socket reset"); }) as typeof fetch });
  await assert.rejects(publisher.publish({ submolt: "Bad Slug", title: "T", content: "body" }), /lowercase slug/);
  await assert.rejects(publisher.publish({ submolt: "general", title: "T", content: "body" }), MoltbookPublicationUncertainError);
  assert.equal(calls, 1);
});

test("Moltbook publisher rejects unsafe links and explicit API failures", async () => {
  const publisher = createMoltbookPublisher({ apiKey: "key", fetch: (async () => new Response(JSON.stringify({ success: false }), { status: 200 })) as typeof fetch });
  await assert.rejects(publisher.publish({ submolt: "general", title: "Link", url: "http://example.com" }), /HTTPS/);
  await assert.rejects(publisher.publish({ submolt: "general", title: "No content" }), /requires content/);
  await assert.rejects(publisher.publish({ submolt: "general", title: "T", content: "body" }), /did not confirm/);
});

test("Moltbook server failures are marked uncertain to prevent duplicate retries", async () => {
  const publisher = createMoltbookPublisher({ apiKey: "key", fetch: (async () => new Response("temporary error", { status: 503 })) as typeof fetch });
  await assert.rejects(publisher.publish({ submolt: "general", title: "T", content: "body" }), MoltbookPublicationUncertainError);
});
