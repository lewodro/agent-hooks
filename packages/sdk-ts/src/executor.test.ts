import assert from "node:assert/strict";
import test from "node:test";

import { Keypair } from "@solana/web3.js";

import {
  assertConfiguredExecutorProgramId,
  DEFAULT_AGENT_HOOKS_EXECUTOR_ID,
} from "./executor.js";

test("executor clients reject the undeployed placeholder program ID", () => {
  assert.throws(
    () => assertConfiguredExecutorProgramId(DEFAULT_AGENT_HOOKS_EXECUTOR_ID),
    /must be configured explicitly/,
  );
  assert.doesNotThrow(() => assertConfiguredExecutorProgramId(Keypair.generate().publicKey));
});
