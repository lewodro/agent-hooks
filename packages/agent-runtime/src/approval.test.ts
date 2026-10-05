import assert from "node:assert/strict";
import test from "node:test";

import {
  createProposalApproval,
  proposalFingerprint,
  validateExecutionReadiness,
} from "./approval.js";
import { createSimulationProposal } from "./proposal.js";

function mutatingProposal() {
  const proposal = createSimulationProposal("Install the conservative borrow guard", new Date("2026-10-05T00:00:00.000Z"));
  proposal.actions = [{
    kind: "install-composition",
    summary: "Install guard after a simulation review.",
    risk: "high",
    requiresHumanApproval: true,
  }];
  proposal.simulationRequired = true;
  return proposal;
}

test("mutations require a matching approved operator record", () => {
  const proposal = mutatingProposal();
  assert.deepEqual(validateExecutionReadiness(proposal), {
    valid: false,
    violations: ["mutating proposal requires a content-bound operator approval"],
  });

  const approval = createProposalApproval(proposal, {
    decision: "approved",
    approver: "operator:miro",
    decidedAt: "2026-10-05T01:00:00.000Z",
  });
  assert.equal(approval.proposalFingerprint, proposalFingerprint(proposal));
  assert.deepEqual(validateExecutionReadiness(proposal, approval), { valid: true, violations: [] });
});

test("an approval cannot be replayed after a proposal change or rejection", () => {
  const proposal = mutatingProposal();
  const approval = createProposalApproval(proposal, { decision: "approved", approver: "operator:miro" });
  proposal.objective = "Install an unrestricted guard";
  assert.deepEqual(validateExecutionReadiness(proposal, approval), {
    valid: false,
    violations: ["approval does not match the current proposal content"],
  });

  const rejected = createProposalApproval(mutatingProposal(), {
    decision: "rejected",
    approver: "operator:miro",
  });
  assert.deepEqual(validateExecutionReadiness(mutatingProposal(), rejected), {
    valid: false,
    violations: ["proposal was rejected by the operator"],
  });
});
