/** A provider-neutral contract for LLM/agent planning. It never signs or broadcasts. */
export type AgentActionKind = "simulate" | "install-composition" | "update-composition" | "deploy";
export type RiskLevel = "low" | "medium" | "high";

export interface AgentAction {
  kind: AgentActionKind;
  summary: string;
  risk: RiskLevel;
  requiresHumanApproval: boolean;
}

export interface AgentProposal {
  schemaVersion: "1.0";
  id: string;
  createdAt: string;
  objective: string;
  assumptions: string[];
  evidence: string[];
  actions: AgentAction[];
  simulationRequired: boolean;
}

export interface AgentPolicy {
  allowedActions: readonly AgentActionKind[];
  requireApprovalFor: readonly RiskLevel[];
  requireSimulationBeforeMutation: boolean;
}

export interface PolicyCheck {
  valid: boolean;
  violations: string[];
}

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  allowedActions: ["simulate", "install-composition", "update-composition"],
  requireApprovalFor: ["medium", "high"],
  requireSimulationBeforeMutation: true,
};

const MUTATING_ACTIONS = new Set<AgentActionKind>([
  "install-composition",
  "update-composition",
  "deploy",
]);

export function validateProposal(proposal: AgentProposal, policy: AgentPolicy = DEFAULT_AGENT_POLICY): PolicyCheck {
  const violations: string[] = [];
  if (proposal.schemaVersion !== "1.0") violations.push("unsupported proposal schema");
  if (!proposal.id.trim()) violations.push("proposal id is required");
  if (!proposal.objective.trim()) violations.push("proposal objective is required");
  if (proposal.actions.length === 0) violations.push("proposal must contain at least one action");

  const needsSimulation = proposal.actions.some((action) => MUTATING_ACTIONS.has(action.kind));
  if (policy.requireSimulationBeforeMutation && needsSimulation && !proposal.simulationRequired) {
    violations.push("mutating proposals must require a simulation");
  }

  for (const action of proposal.actions) {
    if (!policy.allowedActions.includes(action.kind)) violations.push(`action '${action.kind}' is not allowed`);
    if (policy.requireApprovalFor.includes(action.risk) && !action.requiresHumanApproval) {
      violations.push(`action '${action.kind}' at ${action.risk} risk requires human approval`);
    }
  }
  return { valid: violations.length === 0, violations };
}

export function createSimulationProposal(objective: string, now = new Date()): AgentProposal {
  return {
    schemaVersion: "1.0",
    id: `proposal-${now.toISOString().replace(/[:.]/g, "-")}`,
    createdAt: now.toISOString(),
    objective,
    assumptions: ["Inputs are snapshots and may be stale; no transaction will be sent."],
    evidence: [],
    actions: [{
      kind: "simulate",
      summary: "Run the composition against the supplied lifecycle events.",
      risk: "low",
      requiresHumanApproval: false,
    }],
    simulationRequired: false,
  };
}
