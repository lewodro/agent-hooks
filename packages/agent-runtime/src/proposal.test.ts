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
  assert.deepEqual(result.violations, [
    "mutating proposals must require a simulation",
    "mutating action 'install-composition' requires human approval",
    "action 'install-composition' at high risk requires human approval",
  ]);
});

test("mutations cannot bypass approval by self-labeling as low risk", () => {
  const proposal = createSimulationProposal("Install a composition");
  proposal.actions = [{
    kind: "install-composition",
    summary: "Install",
    risk: "low",
    requiresHumanApproval: false,
  }];
  proposal.simulationRequired = true;
  assert.deepEqual(validateProposal(proposal), {
    valid: false,
    violations: ["mutating action 'install-composition' requires human approval"],
  });
});

test("rejects malformed and oversized planner output", () => {
  const proposal = createSimulationProposal("Assess guardrails");
  proposal.createdAt = "not-a-date";
  proposal.actions = [{
    kind: "unknown" as "simulate",
    summary: "",
    risk: "unknown" as "low",
    requiresHumanApproval: false,
  }];
  proposal.assumptions = [""];
  proposal.evidence = ["x".repeat(2_001)];
  assert.deepEqual(validateProposal(proposal), {
    valid: false,
    violations: [
      "proposal createdAt must be a valid date",
      "assumptions[0] must not be empty",
      "evidence[0] exceeds 2000 characters",
      "action 'unknown' has an unsupported kind",
    ],
  });
});
