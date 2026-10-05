import { createHash } from "node:crypto";

import {
  DEFAULT_AGENT_POLICY,
  type AgentPolicy,
  type AgentProposal,
  type PolicyCheck,
  validateProposal,
} from "./proposal.js";

export type ApprovalDecision = "approved" | "rejected";

/**
 * An application-recorded operator decision bound to the exact proposal body.
 * It is not a wallet signature, transaction authorization, or permission to sign.
 */
export interface ProposalApproval {
  readonly schemaVersion: "1.0";
  readonly proposalId: string;
  readonly proposalFingerprint: string;
  readonly decision: ApprovalDecision;
  readonly approver: string;
  readonly decidedAt: string;
  readonly note?: string;
}

export interface CreateApprovalInput {
  readonly decision: ApprovalDecision;
  /** An application-managed operator identity, such as an authenticated user ID. */
  readonly approver: string;
  readonly decidedAt?: string;
  readonly note?: string;
}

/** Returns a SHA-256 of the proposal's execution-relevant, canonical fields. */
export function proposalFingerprint(proposal: AgentProposal): string {
  const canonical = JSON.stringify({
    schemaVersion: proposal.schemaVersion,
    id: proposal.id,
    createdAt: proposal.createdAt,
    objective: proposal.objective,
    assumptions: proposal.assumptions,
    evidence: proposal.evidence,
    actions: proposal.actions.map((action) => ({
      kind: action.kind,
      summary: action.summary,
      risk: action.risk,
      requiresHumanApproval: action.requiresHumanApproval,
    })),
    simulationRequired: proposal.simulationRequired,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function createProposalApproval(
  proposal: AgentProposal,
  input: CreateApprovalInput,
  policy: AgentPolicy = DEFAULT_AGENT_POLICY,
): ProposalApproval {
  const proposalCheck = validateProposal(proposal, policy);
  if (!proposalCheck.valid) {
    throw new ProposalApprovalError("cannot approve an invalid proposal", proposalCheck.violations);
  }
  if (input.decision !== "approved" && input.decision !== "rejected") {
    throw new ProposalApprovalError("approval decision is invalid");
  }
  if (!input.approver.trim()) throw new ProposalApprovalError("approver is required");
  const decidedAt = input.decidedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(decidedAt))) {
    throw new ProposalApprovalError("approval decidedAt must be a valid date");
  }
  if (input.note !== undefined && input.note.length > 2_000) {
    throw new ProposalApprovalError("approval note exceeds 2000 characters");
  }
  return Object.freeze({
    schemaVersion: "1.0" as const,
    proposalId: proposal.id,
    proposalFingerprint: proposalFingerprint(proposal),
    decision: input.decision,
    approver: input.approver.trim(),
    decidedAt,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  });
}

/**
 * Check whether a proposal is safe to hand to an application-owned execution layer.
 * A successful result deliberately does not send, sign, or authorize a transaction.
 */
export function validateExecutionReadiness(
  proposal: AgentProposal,
  approval?: ProposalApproval,
  policy: AgentPolicy = DEFAULT_AGENT_POLICY,
): PolicyCheck {
  const base = validateProposal(proposal, policy);
  const violations = [...base.violations];
  const hasMutation = proposal.actions.some((action) =>
    action.kind === "install-composition" || action.kind === "update-composition" || action.kind === "deploy",
  );
  if (!hasMutation) return { valid: violations.length === 0, violations };

  if (!approval) {
    violations.push("mutating proposal requires a content-bound operator approval");
  } else if (approval.schemaVersion !== "1.0") {
    violations.push("unsupported approval schema");
  } else if (approval.proposalId !== proposal.id) {
    violations.push("approval does not belong to this proposal");
  } else if (approval.proposalFingerprint !== proposalFingerprint(proposal)) {
    violations.push("approval does not match the current proposal content");
  } else if (approval.decision !== "approved") {
    violations.push("proposal was rejected by the operator");
  } else if (!approval.approver.trim() || !Number.isFinite(Date.parse(approval.decidedAt))) {
    violations.push("approval identity or timestamp is invalid");
  }
  return { valid: violations.length === 0, violations };
}

export class ProposalApprovalError extends Error {
  constructor(message: string, public readonly violations: readonly string[] = []) {
    super(message);
    this.name = "ProposalApprovalError";
  }
}
