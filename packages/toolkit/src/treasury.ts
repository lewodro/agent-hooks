export interface TreasuryPolicy {
  allowedDestinations: readonly string[];
  allowedMints: readonly string[];
  maxSingleTransfer: bigint;
  maxDailyTransfer: bigint;
  requireHumanApproval: true;
}

export interface TreasuryProposal {
  id: string;
  destination: string;
  mint: string;
  amount: bigint;
  rationale: string;
  createdAt: number;
  status: "pending-review" | "approved" | "rejected";
  reviewer?: string;
}

/** A policy-bound proposal queue. It deliberately has no wallet, key, or signing API. */
export class TreasuryReviewQueue {
  private readonly proposals = new Map<string, TreasuryProposal>();

  constructor(private readonly policy: TreasuryPolicy) {
    if (policy.requireHumanApproval !== true) throw new Error("Human approval must remain enabled");
    if (policy.maxSingleTransfer <= 0n || policy.maxDailyTransfer <= 0n) throw new Error("Treasury limits must be positive");
  }

  propose(input: Omit<TreasuryProposal, "id" | "createdAt" | "status" | "reviewer">): TreasuryProposal {
    if (!input.destination || !this.policy.allowedDestinations.includes(input.destination)) throw new Error("Destination is not allowlisted");
    if (!input.mint || !this.policy.allowedMints.includes(input.mint)) throw new Error("Asset mint is not allowlisted");
    if (input.amount <= 0n || input.amount > this.policy.maxSingleTransfer) throw new Error("Amount is outside the single-transfer limit");
    const today = new Date().toISOString().slice(0, 10);
    const alreadyCommitted = [...this.proposals.values()]
      .filter((proposal) => proposal.status !== "rejected" && new Date(proposal.createdAt).toISOString().slice(0, 10) === today)
      .reduce((total, proposal) => total + proposal.amount, 0n);
    if (alreadyCommitted + input.amount > this.policy.maxDailyTransfer) throw new Error("Proposal exceeds the daily treasury review limit");
    if (!input.rationale.trim()) throw new Error("A rationale is required");
    const proposal: TreasuryProposal = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      status: "pending-review",
    };
    this.proposals.set(proposal.id, proposal);
    return structuredClone(proposal);
  }

  review(id: string, decision: "approve" | "reject", reviewer: string): TreasuryProposal {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== "pending-review") throw new Error(`Pending treasury proposal ${id} not found`);
    if (!reviewer.trim()) throw new Error("Reviewer identity is required");
    proposal.status = decision === "approve" ? "approved" : "rejected";
    proposal.reviewer = reviewer;
    return structuredClone(proposal);
  }

  get(id: string): TreasuryProposal | undefined {
    const proposal = this.proposals.get(id);
    return proposal ? structuredClone(proposal) : undefined;
  }
}
