# @agent-hooks/kamino-adapter

Wraps `@kamino-finance/klend-sdk`'s `KaminoMarket` + `KaminoObligation` and produces a normalised `LifecycleEvent` for the Agent Hooks runtime.

```ts
import { KaminoAdapter } from "@agent-hooks/kamino-adapter";

const adapter = new KaminoAdapter({
  rpcEndpoint: "https://api.mainnet-beta.solana.com",
  marketAddress: kaminoMarket,
});
const snapshot = await adapter.snapshotPool(kaminoMarket);
```
