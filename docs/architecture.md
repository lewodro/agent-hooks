# Architecture

AGENT HOOKS is four rings: adapters, runtime, executor, and an approval-bound agent control plane.

```mermaid
%%{init: { "theme": "base", "themeVariables": {
  "primaryColor": "#3D2817",
  "primaryTextColor": "#F0EAD6",
  "primaryBorderColor": "#D4AF37",
  "lineColor": "#D4AF37",
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
      AG[Agent Runtime]
      POLICY[Policy + human approval]
    end
    A1 & A2 & A3 -- LifecycleEvent --> RT
    RT -- run_composition --> EX
    EX --- PDA1
    EX --- PDA2
    EX --- PDA3
    AG -- proposal only --> POLICY
    POLICY -- approved composition --> RT
```

## Adapters at the rim

Each adapter is a small TypeScript package that wraps the protocol's existing SDK and emits a normalised `LifecycleEvent`. The shape is identical across adapters so a Composition built against Marginfi can be replayed against Kamino without code changes (only configuration changes).

## Runtime in the middle

`packages/hook-runtime` (Rust) and `packages/sdk-ts/simulator.ts` (TypeScript) implement the same decision tree. The Composition is an ordered list of hook entries plus their priority and flags bitmap. The runtime checks each hook's flags against the event kind, runs the eligible ones in priority order, and either accumulates side effects or short-circuits on the first reject.

## Executor at the core

`packages/anchor-program/programs/agent-hooks-executor` is the Anchor 0.31 program. Compositions live in PDAs keyed by `(pool, slot_index)`, so a pool can have up to eight slot indices and each slot can carry up to eight hooks. Pool authorities install and update Compositions. The executor emits `CompositionExecuted` events that the indexer in `apps/explorer` reads.

## Why hook flags live in PDAs, not in the program address

Uniswap v4 encodes hook flags in the contract address. That works on EVM because addresses are arbitrary. On Solana, addresses are ed25519-derived — forcing brute-force keypair search to embed bits would be hostile to hook authors. AGENT HOOKS stores the flag bitmap in a PDA the executor reads at install time, achieving the same guarantee without keypair gymnastics.

## Agent control plane

`packages/agent-runtime` gives AI agents a deliberately narrow integration surface: they can generate versioned proposals, attach assumptions and evidence, and request deterministic simulations. Policies reject unapproved or unsimulated mutations. The runtime has no wallet, private-key, transaction-submission, or deployment capability; an operator must separately review and execute any resulting composition change.
