import assert from "node:assert/strict";
import test from "node:test";

import { createSimulationProposal, validateProposal } from "./proposal.js";

test("simulation proposals satisfy the default policy", () => {
  const proposal = createSimulationProposal("Assess LTV guardrails", new Date("2026-10-04T00:00:00.000Z"));
  assert.deepEqual(validateProposal(proposal), { valid: true, violations: [] });
});

test("a mutating proposal must require simulation and approval", () => {
  const proposal = createSimulationProposal("Install a composition");
  proposal.actions = [{ kind: "install-composition", summary: "Install", risk: "high", requiresHumanApproval: false }];
  const result = validateProposal(proposal);
  assert.equal(result.valid, false);
  assert.equal(result.violations.length, 2);
});
