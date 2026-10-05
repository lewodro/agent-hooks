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
  /** Mutations remain operator-controlled even when a planner labels them low risk. */
  requireApprovalForMutations?: boolean;
  requireSimulationBeforeMutation: boolean;
}

export interface PolicyCheck {
  valid: boolean;
  violations: string[];
}

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  allowedActions: ["simulate", "install-composition", "update-composition"],
  requireApprovalFor: ["medium", "high"],
  requireApprovalForMutations: true,
  requireSimulationBeforeMutation: true,
};

const MUTATING_ACTIONS = new Set<AgentActionKind>([
  "install-composition",
  "update-composition",
  "deploy",
]);
const ACTION_KINDS = new Set<AgentActionKind>([
  "simulate",
  "install-composition",
  "update-composition",
  "deploy",
]);
const RISK_LEVELS = new Set<RiskLevel>(["low", "medium", "high"]);
const MAX_ACTIONS = 16;
const MAX_CONTEXT_ITEMS = 32;

export function validateProposal(proposal: AgentProposal, policy: AgentPolicy = DEFAULT_AGENT_POLICY): PolicyCheck {
  const violations: string[] = [];
  if (proposal.schemaVersion !== "1.0") violations.push("unsupported proposal schema");
  if (!proposal.id.trim()) violations.push("proposal id is required");
  if (!Number.isFinite(Date.parse(proposal.createdAt))) violations.push("proposal createdAt must be a valid date");
  if (!proposal.objective.trim()) violations.push("proposal objective is required");
  if (proposal.actions.length === 0) violations.push("proposal must contain at least one action");
  if (proposal.actions.length > MAX_ACTIONS) violations.push(`proposal exceeds ${MAX_ACTIONS} actions`);
  validateContextItems("assumptions", proposal.assumptions, violations);
  validateContextItems("evidence", proposal.evidence, violations);

  const needsSimulation = proposal.actions.some((action) => MUTATING_ACTIONS.has(action.kind));
  if (policy.requireSimulationBeforeMutation && needsSimulation && !proposal.simulationRequired) {
    violations.push("mutating proposals must require a simulation");
  }

  for (const action of proposal.actions) {
    if (!ACTION_KINDS.has(action.kind)) {
      violations.push(`action '${String(action.kind)}' has an unsupported kind`);
      continue;
    }
    if (!RISK_LEVELS.has(action.risk)) {
      violations.push(`action '${action.kind}' has an unsupported risk level`);
      continue;
    }
    if (!action.summary.trim()) violations.push(`action '${action.kind}' requires a summary`);
    if (!policy.allowedActions.includes(action.kind)) violations.push(`action '${action.kind}' is not allowed`);
    if ((policy.requireApprovalForMutations ?? true) && MUTATING_ACTIONS.has(action.kind) && !action.requiresHumanApproval) {
      violations.push(`mutating action '${action.kind}' requires human approval`);
    }
    if (policy.requireApprovalFor.includes(action.risk) && !action.requiresHumanApproval) {
      violations.push(`action '${action.kind}' at ${action.risk} risk requires human approval`);
    }
  }
  return { valid: violations.length === 0, violations };
}

function validateContextItems(label: "assumptions" | "evidence", values: readonly string[], violations: string[]): void {
  if (values.length > MAX_CONTEXT_ITEMS) violations.push(`${label} exceeds ${MAX_CONTEXT_ITEMS} items`);
  values.forEach((value, index) => {
    if (!value.trim()) violations.push(`${label}[${index}] must not be empty`);
    if (value.length > 2_000) violations.push(`${label}[${index}] exceeds 2000 characters`);
  });
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
