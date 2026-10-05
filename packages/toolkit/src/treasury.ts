export type TreasuryChain = "solana" | "bitcoin" | "ethereum";

export interface TreasuryAsset {
  chain: TreasuryChain;
  /** Explicit cluster/chain, e.g. mainnet-beta, devnet, mainnet, or sepolia. */
  network: string;
  /** Native ticker or token identifier (mint / contract address). */
  assetId: string;
}

export interface TreasuryDestination {
  chain: TreasuryChain;
  network: string;
  address: string;
}

export const treasuryAssetKey = ({ chain, network, assetId }: TreasuryAsset): string =>
  `${chain}:${network}:${assetId}`;

export const treasuryDestinationKey = ({ chain, network, address }: TreasuryDestination): string =>
  `${chain}:${network}:${address}`;

export interface TreasuryPolicy {
  /** Fully-qualified keys from treasuryDestinationKey(). */
  allowedDestinations: readonly string[];
  /** Fully-qualified keys from treasuryAssetKey(). */
  allowedAssets: readonly string[];
  /** Caps are denominated in the asset's smallest indivisible unit. */
  maxSingleTransfer: bigint;
  maxDailyTransfer: bigint;
  requireHumanApproval: true;
}

export interface TreasuryProposal extends TreasuryDestination, TreasuryAsset {
  id: string;
  /** Integer base units (lamports, satoshis, wei, or token base units); never a float. */
  amount: bigint;
  rationale: string;
  createdAt: number;
  status: "pending-review" | "approved" | "rejected";
  reviewer?: string;
}

/**
 * A chain-neutral, in-memory proposal and review ledger. It deliberately has no
 * wallet, key, signing, RPC, or broadcast API. A reviewed proposal still needs
 * chain-specific validation and a separately secured signer before execution.
 */
export class TreasuryReviewQueue {
  private readonly proposals = new Map<string, TreasuryProposal>();

  constructor(private readonly policy: TreasuryPolicy) {
    if (policy.requireHumanApproval !== true) throw new Error("Human approval must remain enabled");
    if (policy.maxSingleTransfer <= 0n || policy.maxDailyTransfer <= 0n) throw new Error("Treasury limits must be positive");
  }

  propose(input: Omit<TreasuryProposal, "id" | "createdAt" | "status" | "reviewer">): TreasuryProposal {
    const destinationKey = treasuryDestinationKey(input);
    const assetKey = treasuryAssetKey(input);
    if (!this.policy.allowedDestinations.includes(destinationKey)) throw new Error("Destination is not allowlisted for this chain and network");
    if (!this.policy.allowedAssets.includes(assetKey)) throw new Error("Asset is not allowlisted for this chain and network");
    if (!input.network.trim() || !input.address.trim() || !input.assetId.trim()) throw new Error("Chain, network, asset, and destination are required");
    if (input.amount <= 0n || input.amount > this.policy.maxSingleTransfer) throw new Error("Amount is outside the single-transfer limit");
    if (!input.rationale.trim()) throw new Error("A rationale is required");

    const today = new Date().toISOString().slice(0, 10);
    // Base units are incomparable across assets; aggregate daily caps per exact asset.
    const alreadyCommitted = [...this.proposals.values()]
      .filter((proposal) =>
        proposal.status !== "rejected" &&
        treasuryAssetKey(proposal) === assetKey &&
        new Date(proposal.createdAt).toISOString().slice(0, 10) === today,
      )
      .reduce((total, proposal) => total + proposal.amount, 0n);
    if (alreadyCommitted + input.amount > this.policy.maxDailyTransfer) throw new Error("Proposal exceeds the daily treasury review limit for this asset");

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
