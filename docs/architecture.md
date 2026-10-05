# Architecture

Agent Hooks separates protocol adaptation, deterministic execution, experience memory, and agent planning. This lets agents learn from live feedback without coupling hook evaluation to a model provider.

```mermaid
%%{init: { "theme": "base", "themeVariables": {
  "primaryColor": "#0D1322",
  "primaryTextColor": "#E7F0FF",
  "primaryBorderColor": "#00FF66",
  "lineColor": "#00E5FF",
  "secondaryColor": "#1E293B",
  "tertiaryColor": "#050811",
  "fontFamily": "Space Mono, monospace"
}} }%%
flowchart TB
    subgraph rim [Adapters · rim]
      A1[Marginfi v2]
      A2[Kamino Lend]
      A3[Solend]
    end
    subgraph middle [Runtime · middle]
      RT[Composition · ExecutionTrace · Simulator]
    end
    subgraph core [Executor · core]
      EX{{Anchor 0.31 program}}
      PDA1[(Pool PDA)]
      PDA2[(Composition PDA)]
      PDA3[(HookListing PDA)]
    end
    subgraph control [Agent control plane · off-chain]
      BRAIN[agent-brain · experience store]
      AG[Agent planner]
      POLICY[Policy + human approval]
    end
    A1 & A2 & A3 -- LifecycleEvent --> RT
    RT -- run_composition --> EX
    EX --- PDA1
    EX --- PDA2
    EX --- PDA3
    EX -- receipt + outcome --> BRAIN
    BRAIN -- retrieved experience --> AG
    AG -- proposal only --> POLICY
    POLICY -- approved composition --> RT
```

## Adapters at the rim

Each adapter is a small TypeScript package that wraps the protocol's existing SDK and emits a normalised `LifecycleEvent`. The shape is identical across adapters so a Composition built against Marginfi can be replayed against Kamino without code changes (only configuration changes).

## Runtime in the middle

`packages/hook-runtime` (Rust) and `packages/sdk-ts/simulator.ts` (TypeScript) implement the same decision tree. The Composition is an ordered list of hook entries plus their priority and flags bitmap. The runtime checks each hook's flags against the event kind, runs the eligible ones in priority order, and either accumulates side effects or short-circuits on the first reject.

## Executor at the core

`packages/anchor-program/programs/agent-hooks-executor` is the Anchor 0.31 program. Compositions live in PDAs keyed by `(pool, slot_index)`, so a pool can have up to eight slot indices and each slot can carry up to eight hooks. Pool authorities install and update Compositions. The executor emits `CompositionExecuted` events for external indexers to consume.

## Why hook flags live in PDAs, not in the program address

Uniswap v4 encodes hook flags in the contract address. That works on EVM because addresses are arbitrary. On Solana, addresses are ed25519-derived — forcing brute-force keypair search to embed bits would be hostile to hook authors. AGENT HOOKS stores the flag bitmap in a PDA the executor reads at install time, achieving the same guarantee without keypair gymnastics.

## Agent control plane

`packages/agent-runtime` gives AI agents a deliberately narrow integration surface: they can generate versioned proposals, attach assumptions and evidence, and request deterministic simulations. Policies reject unapproved or unsimulated mutations. The runtime has no wallet, private-key, transaction-submission, or deployment capability; an operator must separately review and execute any resulting composition change.

## Continuous experience loop

`LifecycleEvent` is the shared boundary between adapters, simulations, and the brain. An execution receipt and any later outcome feedback are stored with the event, hook IDs, and composition ID using `AgentBrain.observe()`. Later, `AgentBrain.recall()` returns prior experiences by adapter, event kind, or composition so a planner can form its next proposal. A store implementation may use an append-only database and optional similarity search; the package itself does not train a model or infer causality from correlation.
