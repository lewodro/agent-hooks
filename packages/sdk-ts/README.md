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
