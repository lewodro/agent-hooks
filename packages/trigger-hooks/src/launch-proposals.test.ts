import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTokenLaunchProposalClient, validateTokenLaunchRequest } from "./launch-proposals.js";

const request = {
  name: "Example Finance Token",
  symbol: "EFT",
  decimals: 6,
  initialSupply: 9_007_199_254_740_993n,
  network: "devnet" as const,
  metadataUri: "https://example.com/token.json",
};

describe("token launch proposal client", () => {
  it("sends exact base-unit supply to the role-protected Rust API", async () => {
    let sentBody = "";
    let sentAuthorization = "";
    const client = createTokenLaunchProposalClient({
      serviceUrl: "http://127.0.0.1:8787",
      agentToken: "agent-secret",
      fetch: async (input, init) => {
        assert.equal(String(input), "http://127.0.0.1:8787/v1/token-launch-proposals");
        sentBody = String(init?.body);
        sentAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({
          id: "fingerprint",
          name: request.name,
          symbol: request.symbol,
          decimals: request.decimals,
          initial_supply: request.initialSupply.toString(),
          network: request.network,
          metadata_uri: request.metadataUri,
          status: "pending_review",
          fingerprint: "fingerprint",
          created_at: 1_700_000_000,
          reviewer: null,
          reviewed_at: null,
        }, { status: 202 });
      },
    });

    const proposal = await client.propose(request);
    assert.equal(JSON.parse(sentBody).initial_supply, request.initialSupply.toString());
    assert.equal(sentAuthorization, "Bearer agent-secret");
    assert.equal(proposal.initialSupply, request.initialSupply);
    assert.equal(proposal.status, "pending_review");
  });

  it("rejects malformed and unsafe requests before network delivery", () => {
    assert.throws(() => validateTokenLaunchRequest({ ...request, symbol: "bad" }), /uppercase/);
    assert.throws(() => validateTokenLaunchRequest({ ...request, metadataUri: "http://example.com/token.json" }), /HTTPS/);
    assert.throws(() => validateTokenLaunchRequest({ ...request, initialSupply: 0n }), /positive u64/);
  });
});
