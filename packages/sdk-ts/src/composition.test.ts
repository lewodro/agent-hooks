import assert from "node:assert/strict";
import test from "node:test";

import {
  Composition,
  flagsFrom,
  HOOK_FLAGS,
  validateCompositionSlotIndex,
} from "./composition.js";

function spec(priority = 10) {
  return {
    name: `hook-${priority}`,
    programId: `program-${priority}`,
    priority,
    flags: flagsFrom(["BeforeBorrow", "MayReject"]),
  };
}

test("composition enforces Anchor-compatible priorities and lifecycle bits", () => {
  const composition = new Composition().add(spec(65535)).add(spec(2));
  assert.deepEqual(composition.hooks().map((entry) => entry.priority), [2, 65535]);
  assert.throws(() => composition.add(spec(2)), /already used/);
  assert.throws(() => composition.add(spec(65536)), /between 0 and 65535/);
  assert.throws(
    () => composition.add({ ...spec(3), flags: { bits: HOOK_FLAGS.MayReject } }),
    /lifecycle flag/,
  );
  assert.throws(
    () => composition.add({ ...spec(4), flags: { bits: 1 << 15 } }),
    /unsupported bits/,
  );
});

test("composition slot indexes cannot overflow the one-byte PDA seed", () => {
  assert.doesNotThrow(() => validateCompositionSlotIndex(0));
  assert.doesNotThrow(() => validateCompositionSlotIndex(7));
  assert.throws(() => validateCompositionSlotIndex(8), /between 0 and 7/);
  assert.throws(() => validateCompositionSlotIndex(256), /between 0 and 7/);
  assert.throws(() => validateCompositionSlotIndex(1.5), /integer/);
});
