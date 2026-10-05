# @agent-hooks/agent-runtime

Provider-neutral proposal and operator-approval primitives for Agent Hooks. This package is deliberately outside the transaction trust boundary: it can validate an agent's plan and bind an operator decision to its exact content, but it cannot sign, submit, or authorize a Solana transaction.

Use the runtime in the off-chain control path:

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
