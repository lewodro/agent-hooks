import assert from "node:assert/strict";
import test from "node:test";

import { DailyXWorkflow, XPublicationUncertainError } from "./x.js";
import type { XPublisher } from "./x.js";
import type { AgentExperience } from "./agents.js";

const source: AgentExperience = {
  id: "experience-1",
  event: { signature: "sig", slot: 1, timestamp: 1, kind: "borrow", programId: "protocol", data: {} },
  run: { accepted: true, receipts: [] },
  outcome: { label: "executed" },
  recordedAt: 1,
  tags: [],
};

function workflow(publisher?: XPublisher) {
  return new DailyXWorkflow({ write: async () => "Reviewed result from experience-1" }, publisher);
}

test("daily X workflow records approval and allows one active draft per UTC date", async () => {
  const x = workflow();
  const draft = await x.draft("2026-10-05", [source]);
  assert.match(draft.contentFingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(x.draft("2026-10-05", [source]), /already exists/);
  assert.throws(() => x.approve(draft.id, " "), /approver identity/);
  const approved = x.approve(draft.id, "operator:alice");
  assert.equal(approved.approvedBy, "operator:alice");
  assert.equal(approved.status, "approved");
});

test("concurrent publish calls are single-flight and retries use a stable idempotency key", async () => {
  let finish!: (value: { postId: string }) => void;
  let calls = 0;
  let suppliedKey = "";
  const publisher: XPublisher = {
    publish: async (_text, options) => {
      calls += 1;
      suppliedKey = options?.idempotencyKey ?? "";
      return await new Promise((resolve) => { finish = resolve; });
    },
  };
  const x = workflow(publisher);
  const draft = await x.draft("2026-10-05", [source]);
  x.approve(draft.id, "operator:alice");
  const pending = x.publish(draft.id);
  await assert.rejects(x.publish(draft.id), /status approved/);
  assert.equal(calls, 1);
  assert.equal(suppliedKey, draft.id);
  finish({ postId: "post-1" });
  assert.equal((await pending).status, "published");
});

test("ambiguous provider failures require reconciliation and cannot be blindly retried", async () => {
  let calls = 0;
  const x = workflow({
    publish: async () => {
      calls += 1;
      throw new Error("connection dropped after request");
    },
  });
  const draft = await x.draft("2026-10-05", [source]);
  x.approve(draft.id, "operator:alice");
  await assert.rejects(x.publish(draft.id), XPublicationUncertainError);
  assert.equal(x.get(draft.id)?.status, "publish-unknown");
  await assert.rejects(x.publish(draft.id), /status approved/);
  assert.equal(calls, 1);
});

test("X draft bounds and source IDs are checked before invoking the writer", async () => {
  let writes = 0;
  const x = new DailyXWorkflow({ async write() { writes += 1; return "ok"; } });
  await assert.rejects(x.draft("2026-02-30", []), /valid YYYY-MM-DD/);
  await assert.rejects(x.draft("2026-10-05", [source, source]), /unique/);
  assert.equal(writes, 0);
});
