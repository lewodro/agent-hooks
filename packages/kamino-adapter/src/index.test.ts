import assert from "node:assert/strict";
import test from "node:test";

import { PublicKey } from "@solana/web3.js";

import { KaminoAdapter, KAMINO_PROGRAM_ID } from "./index.js";

test("Kamino adapter exposes its configured market and protocol identity without RPC", () => {
  const marketAddress = PublicKey.default;
  const adapter = new KaminoAdapter({ rpcEndpoint: "https://rpc.invalid", marketAddress });
  assert.equal(adapter.kind, "kamino");
  assert.ok(adapter.programId().equals(KAMINO_PROGRAM_ID));
});
