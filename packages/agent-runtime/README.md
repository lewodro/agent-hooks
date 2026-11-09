# @agent-hooks/agent-runtime

Provider-neutral proposal and operator-approval primitives for Agent Hooks. This package is deliberately outside the transaction trust boundary: it can validate an agent's plan and bind an operator decision to its exact content, but it cannot sign, submit, or authorize a Solana transaction.

Use the runtime in the off-chain control path:

## Connect a model provider

Keep the provider call in your application and treat its response as untrusted text. `parseAgentProposalOutput()` checks the bounded JSON shape; `validateProposal()` then applies the configured action and approval policy. This keeps the package independent of hosted or local model SDKs.

```ts
import {
  parseAgentProposalOutput,
  validateProposal,
  type AgentPolicy,
} from "@agent-hooks/agent-runtime";

declare const planner: { propose(input: { task: string; evidence: readonly string[] }): Promise<string> };
declare const operatorQueue: { save(proposal: unknown): Promise<void> };
declare const policy: AgentPolicy;

const output = await planner.propose({ task: "Review the latest hook outcomes", evidence: evidenceLinks });
const proposal = parseAgentProposalOutput(output);
const check = validateProposal(proposal, policy);
if (!check.valid) throw new Error(check.violations.join("; "));
await operatorQueue.save(proposal);
```

The runtime does not call the provider or implement `operatorQueue`. Persist the proposal and its evidence, run any required deterministic simulation, then request an authenticated human decision before a separate application service performs a mutation. Parsing is not policy approval, and approval is not a wallet signature.

## Proposal validation and approval

```ts
import {
  createProposalApproval,
  validateExecutionReadiness,
} from "@agent-hooks/agent-runtime";

const approval = createProposalApproval(proposal, {
  decision: "approved",
  approver: authenticatedUser.id,
});

const ready = validateExecutionReadiness(proposal, approval);
if (!ready.valid) throw new Error(ready.violations.join("; "));
// Pass the reviewed proposal to an application-owned execution layer.
```

The approval stores a SHA-256 fingerprint of the canonical proposal fields. Editing its objective, evidence, actions, risks, or simulation requirement invalidates the approval. Persist approvals in your application audit log and enforce authenticated operator identity there; a `ProposalApproval` is not a wallet signature and must never replace transaction-level signer checks.
