# Documentation

Start with the page that matches what you want to build. The framework is modular: most integrations use one TypeScript package, and the Rust runtime is available when you need deterministic server-side hook evaluation.

## Choose a path

| Goal | Start here | What you will connect |
| --- | --- | --- |
| Connect a hosted or local model | [Model integration](model-integration.md) | Provider-owned planner → bounded proposal parser → policy → simulation and review |
| Wake an idle finance agent on an event | [Trigger Hooks](trigger-hooks.md) | Solana observer/indexer → rule match → OpenClaw, Hermes, or generic webhook |
| Research tokens and create market alerts | [Toolkit guide](../packages/toolkit/README.md#financial-market-research) | CoinGecko/DEX Screener snapshots → deterministic, freshness-bounded review alerts |
| Store attributed events and outcomes | [Agent Brain](../packages/agent-brain/README.md) | Application-owned event collectors → memory store → agent retrieval |
| Write a deterministic protocol hook | [Hooks specification](hooks-spec.md) | Lifecycle event → bounded Rust/TypeScript hook → host or protocol enforcement |
| Build the AAE connection | [AAE integration boundary](integrations/aae.md) | AAE Rust event sink/outbox → signed Agent Hooks notification |
| Understand package boundaries | [Architecture](architecture.md) | Runtime, adapters, model control plane, Anchor examples, and current limits |

## Safety and release

- [Security and trust boundaries](security.md) describes what the code does and does not authorize.
- [Deployment status](deployment.md) records the program-ID and release requirements.
- [First agent: Harbor](first-agent.md) is a project-level design and rollout proposal, not a single ready-to-run agent service.

## Package references

- [`@agent-hooks/agent-runtime`](../packages/agent-runtime/README.md): parse and validate model-authored proposals; bind review to proposal content.
- [`@agent-hooks/trigger-hooks`](../packages/trigger-hooks/README.md): observe normalized Solana signals and dispatch agent wake-ups.
- [`@agent-hooks/toolkit`](../packages/toolkit/README.md): market and social research, hook simulation, treasury review, and reusable agent workflows.
- [`hook-runtime`](../packages/hook-runtime/README.md): deterministic Rust event validation, composition evaluation, trace, and simulation.
- [`agent-hooks`](../packages/cli/README.md): command-line scaffolding, simulation, proposal, receipt, and deployment-plan commands.

Every page labels prototype and integration boundaries where relevant. An adapter or example is not evidence of a deployed listener, verified chain source, durable production queue, or signing service.
