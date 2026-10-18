export type TokenLaunchNetwork = "devnet" | "mainnet-beta";
export type TokenLaunchReviewStatus = "pending_review" | "approved" | "rejected";

export interface TokenLaunchRequest {
  name: string;
  symbol: string;
  decimals: number;
  /** Exact integer base units; transported as a decimal string, never a JSON number. */
  initialSupply: bigint;
  network: TokenLaunchNetwork;
  metadataUri: string;
}

export interface TokenLaunchProposal extends Omit<TokenLaunchRequest, "initialSupply" | "metadataUri"> {
  id: string;
  initialSupply: bigint;
  metadataUri: string;
  status: TokenLaunchReviewStatus;
  fingerprint: string;
  createdAt: number;
  reviewer: string | null;
  reviewedAt: number | null;
}

export interface TokenLaunchProposalClientOptions {
  serviceUrl: string;
  agentToken: string;
  fetch?: typeof globalThis.fetch;
}

/** Agent-facing API client. It can submit a reviewed launch request, but cannot approve or broadcast it. */
export function createTokenLaunchProposalClient(options: TokenLaunchProposalClientOptions) {
  const endpoint = proposalEndpoint(options.serviceUrl);
  if (!options.agentToken.trim()) throw new Error("trigger service agent token is required");
  const send = options.fetch ?? globalThis.fetch;

  return {
    async propose(request: TokenLaunchRequest): Promise<TokenLaunchProposal> {
      validateTokenLaunchRequest(request);
      const response = await send(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: request.name.trim(),
          symbol: request.symbol,
          decimals: request.decimals,
          initial_supply: request.initialSupply.toString(),
          network: request.network,
          metadata_uri: request.metadataUri,
        }),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`token launch proposal failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
      const body = await response.json() as TokenLaunchProposalWire;
      return {
        id: body.id,
        name: body.name,
        symbol: body.symbol,
        decimals: body.decimals,
        initialSupply: BigInt(body.initial_supply),
        network: body.network,
        metadataUri: body.metadata_uri,
        status: body.status,
        fingerprint: body.fingerprint,
        createdAt: body.created_at,
        reviewer: body.reviewer,
        reviewedAt: body.reviewed_at,
      };
    },
  };
}

export function validateTokenLaunchRequest(request: TokenLaunchRequest): void {
  if (!request.name.trim() || request.name.trim().length > 32) throw new Error("token name must contain 1-32 characters");
  if (!/^[A-Z0-9]{2,10}$/.test(request.symbol)) throw new Error("token symbol must contain 2-10 uppercase ASCII letters or digits");
  if (!Number.isInteger(request.decimals) || request.decimals < 0 || request.decimals > 9) throw new Error("token decimals must be between 0 and 9");
  if (typeof request.initialSupply !== "bigint" || request.initialSupply <= 0n || request.initialSupply > 18_446_744_073_709_551_615n) {
    throw new Error("initialSupply must be a positive u64 bigint in base units");
  }
  if (request.network !== "devnet" && request.network !== "mainnet-beta") throw new Error("network must be devnet or mainnet-beta");
  let metadata: URL;
  try {
    metadata = new URL(request.metadataUri);
  } catch {
    throw new Error("metadataUri must be an HTTPS URL");
  }
  if (metadata.protocol !== "https:" || metadata.username || metadata.password || request.metadataUri.length > 2_048 || /\s|[\u0000-\u001f\u007f]/.test(request.metadataUri)) {
    throw new Error("metadataUri must be a bounded HTTPS URL without embedded credentials");
  }
}

interface TokenLaunchProposalWire {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  initial_supply: string;
  network: TokenLaunchNetwork;
  metadata_uri: string;
  status: TokenLaunchReviewStatus;
  fingerprint: string;
  created_at: number;
  reviewer: string | null;
  reviewed_at: number | null;
}

function proposalEndpoint(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))) {
    throw new Error("trigger service URL must use HTTPS except for loopback and cannot embed credentials");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/token-launch-proposals`;
  return url.toString();
}
