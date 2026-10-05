import assert from "node:assert/strict";
import test from "node:test";

import { MarginfiAdapter, MARGINFI_PROGRAM_ID } from "./index.js";

test("Marginfi adapter exposes the stable protocol identity without connecting", () => {
  const adapter = new MarginfiAdapter({ rpcEndpoint: "https://rpc.invalid" });
  assert.equal(adapter.kind, "marginfi");
  assert.ok(adapter.programId().equals(MARGINFI_PROGRAM_ID));
});
