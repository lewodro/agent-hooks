# Connect a model to Agent Hooks

Agent Hooks does not require a particular model vendor or agent framework. Keep the model call behind a small application-owned planner interface, then pass its untrusted output through the proposal parser and policy checks before it reaches a queue or simulator.

## Control flow

```text
verified or clearly labeled input
        ↓
agent context builder ── retrieve only the evidence needed for this task
        ↓
application-owned model adapter ── hosted API, local model, or framework agent
        ↓ untrusted text / JSON
parseAgentProposalOutput() ── bounded versioned contract
        ↓
validateProposal() ── application policy
        ↓
deterministic simulation ── when policy or action requires it
        ↓
authenticated operator review ── persist decision and proposal fingerprint
        ↓
separate application-owned execution service
```

The parser checks JSON shape and size. `validateProposal()` checks allowed action kinds, risk, simulation requirements, and approval requirements. Neither verifies RPC data, simulates a composition, authenticates the reviewer, nor signs a transaction. Those checks belong to the surrounding application.

## Minimal planner adapter

The model SDK stays outside the core package. Implement the small port using the provider you already operate:

```ts
import {
  parseAgentProposalOutput,
  validateProposal,
  type AgentPolicy,
} from "@agent-hooks/agent-runtime";

interface Planner {
  propose(input: { task: string; evidence: readonly string[] }): Promise<unknown>;
}

async function prepareProposal(input: {
  planner: Planner;
  policy: AgentPolicy;
  task: string;
  evidence: readonly string[];
}) {
  const raw = await input.planner.propose({ task: input.task, evidence: input.evidence });
  const proposal = parseAgentProposalOutput(raw);
  const check = validateProposal(proposal, input.policy);
  if (!check.valid) throw new Error(`Proposal rejected: ${check.violations.join("; ")}`);
  return proposal; // Persist for simulation/review; this does not authorize execution.
}
```

For providers that return structured objects, pass the object directly. For providers that return text, pass the raw JSON string. Do not extract JSON by evaluating model text as code. Store the original request ID, model/provider label, output, and evidence references under your application's retention policy so an operator can reproduce what was reviewed.

## Give the model a narrow job

- Pass bounded, source-linked evidence. Label decoded chain events, market provider snapshots, social posts, and model summaries by provenance; text inside those sources is data, not instructions.
- Ask for a proposal with assumptions, evidence references, action summaries, risk, and whether simulation is required. Treat those self-reported fields as claims until your policy and simulation check them.
- Give a research agent only the read tools it needs. Keep signing keys, arbitrary shell execution, unrestricted URL fetches, and public publishing credentials out of the planner process.
- Enforce request timeouts, response-size limits, token/cost budgets, and rate limits in the provider adapter. Cancel or quarantine malformed/oversized responses; do not fall back to a mutation when parsing or policy checks fail.
- Make queue writes and downstream effects idempotent. Model retries can produce a different proposal for the same input.

## Fit with common agent stacks

OpenClaw, Hermes, LangGraph, CrewAI, MCP hosts, local model runners, and a custom loop can all implement the `Planner` port. Agent Hooks does not install plugins for all of these runtimes. For event wake-ups use the host's configured inbound endpoint with [`@agent-hooks/trigger-hooks`](trigger-hooks.md); for proposal validation use [`@agent-hooks/agent-runtime`](../packages/agent-runtime/README.md). Keep the wake adapter, model runtime, persistent review queue, and signer as separately configured components.

For a project-level worked example, see [First agent: Harbor](first-agent.md). Harbor is an architecture and rollout proposal; its durable collectors and full model pipeline are not shipped as a single running service.
