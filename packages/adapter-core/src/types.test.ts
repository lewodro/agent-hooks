import assert from "node:assert/strict";
import test from "node:test";

import { computeUtilisationBps } from "./types.js";

test("utilisation basis points are rounded and bounded", () => {
  assert.equal(computeUtilisationBps(100, 75), 7_500);
  assert.equal(computeUtilisationBps(100, 140), 10_000);
  assert.equal(computeUtilisationBps(0, 0), 0);
  assert.equal(computeUtilisationBps(0, 1), 10_000);
});

test("invalid USD totals fail closed", () => {
  assert.throws(() => computeUtilisationBps(-1, 1), /assets/);
  assert.throws(() => computeUtilisationBps(1, Number.NaN), /liabilities/);
});
