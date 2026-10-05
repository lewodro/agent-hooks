import assert from "node:assert/strict";
import test from "node:test";

import { SolanaHookEngine, type SolanaLifecycleEvent } from "./solana.js";

const event: SolanaLifecycleEvent = {
  signature: "signature",
  slot: 123,
  timestamp: 1_700_000_000_000,
  kind: "beforeBorrow",
  programId: "lending-program",
  data: { amount: 100 },
};

test("hook failures and malformed effects fail closed", () => {
  const failureEngine = new SolanaHookEngine([{
    id: "throws",
    programId: "guard",
    priority: 1,
    events: ["beforeBorrow"],
    evaluate: () => {
      throw new Error("oracle unavailable");
    },
  }]);
  assert.deepEqual(failureEngine.run(event), {
    accepted: false,
    receipts: [{ hookId: "throws", programId: "guard", decision: { kind: "reject", reason: "hook evaluation failed" }, skipped: false }],
    rejection: { hookId: "throws", reason: "hook evaluation failed" },
  });

  const invalidEffectEngine = new SolanaHookEngine([{
    id: "invalid-effect",
    programId: "guard",
    priority: 1,
    events: ["beforeBorrow"],
    evaluate: () => ({ kind: "accept-with", effects: [{ kind: "delay", slots: -1 }] }),
  }]);
  assert.equal(invalidEffectEngine.run(event).accepted, false);
});

test("hook engine validates lifecycle event provenance shape", () => {
  const engine = new SolanaHookEngine([{
    id: "accept",
    programId: "guard",
    priority: 1,
    events: ["beforeBorrow"],
    evaluate: () => ({ kind: "accept" }),
  }]);
  assert.throws(() => engine.run({ ...event, slot: -1 }), /slot/);
  assert.throws(() => engine.run({ ...event, data: [] as unknown as Readonly<Record<string, unknown>> }), /data/);
});
