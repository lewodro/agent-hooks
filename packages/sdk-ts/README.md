# @agent-hooks/sdk

TypeScript SDK for the Agent Hooks hook framework.

```
npm install @agent-hooks/sdk
```

## Surface

```ts
import {
  Composition,            // priority-sorted list of hooks
  ExecutorClient,         // Anchor client for the on-chain program
  simulate,               // deterministic in-process simulator
  dynamicLtv,             // typed helpers, one per standard hook
  timeTriggerLiq,
  whitelistBorrow,
  antiMevLiq,
  autoHedge,
  reputationRate,
} from "@agent-hooks/sdk";
```

## Build a composition

```ts
const composition = new Composition()
  .add(dynamicLtv({
    programId: "HookDLTV1111111111111111111111111111111111",
    priority: 10,
    baseLtvBps: 7_500,
    sensitivity: 50,
    volFloorBps: 1_000,
    minLtvBps: 2_500,
  }))
  .add(antiMevLiq({
    programId: "HookAMEV1111111111111111111111111111111111",
    priority: 20,
    minDelaySlots: 3,
  }));
```

The builder matches the current Anchor registry limits: a composition holds at most eight hooks, each uses a unique `u16` priority, every hook declares at least one lifecycle bit, and registry slot indexes are `0` through `7`. Invalid entries fail locally before a transaction is built. The registry is still an eligibility-receipt prototype and does not CPI into listed hook programs.

`ExecutorClient` requires an explicit, non-placeholder program ID. Configure it from deployment-specific configuration and independently verify its upgrade authority and IDL before using it to construct transaction instructions.

## Simulate

```ts
const report = simulate(composition, events);
```

The simulator mirrors the on-chain executor's decision tree. The output is suitable for CI gating or for the browser-side Hook Designer.

## Install on-chain

```ts
const client = new ExecutorClient({
  rpcEndpoint: "https://api.mainnet-beta.solana.com",
  payer,
  idl,
});
await client.registerPool({ market, adapter: "marginfi", authority: pool });
await client.installComposition({ market, authority: pool, slotIndex: 0, composition });
```
