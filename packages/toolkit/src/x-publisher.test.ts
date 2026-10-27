import assert from "node:assert/strict";
import test from "node:test";
import { createXApiPublisher } from "./x-publisher.js";

test("X publisher creates a post with the user token and returns the platform ID", async () => {
  let requestUrl = "";
  let request: RequestInit | undefined;
  const publisher = createXApiPublisher({
    userAccessToken: "user-token",
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      requestUrl = String(input); request = init;
      return new Response(JSON.stringify({ data: { id: "123" } }), { status: 201 });
    }) as typeof fetch,
  });
  assert.deepEqual(await publisher.publish("A factual update with cited evidence."), { postId: "123" });
  assert.equal(requestUrl, "https://api.x.com/2/tweets");
  assert.equal(request?.method, "POST");
  assert.equal(request?.redirect, "error");
  assert.equal(new Headers(request?.headers).get("authorization"), "Bearer user-token");
  assert.deepEqual(JSON.parse(String(request?.body)), { text: "A factual update with cited evidence." });
});

test("X publisher bounds text and treats an unidentifiable success as uncertain", async () => {
  const publisher = createXApiPublisher({ userAccessToken: "token", fetch: (async () => new Response(JSON.stringify({ data: {} }), { status: 201 })) as typeof fetch });
  await assert.rejects(publisher.publish("  "), /1-4000/);
  await assert.rejects(publisher.publish("Post"), /outcome is uncertain/);
});
