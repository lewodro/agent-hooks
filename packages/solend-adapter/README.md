# @agent-hooks/solend-adapter

Wraps `@solendprotocol/solend-sdk`'s `SolendMarket` and produces a normalised `LifecycleEvent` for the Agent Hooks runtime.

```ts
import { SolendAdapter } from "@agent-hooks/solend-adapter";

const adapter = new SolendAdapter({ rpcEndpoint: "https://api.mainnet-beta.solana.com" });
const snapshot = await adapter.snapshotPool(solendMarket);
```
