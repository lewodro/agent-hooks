# @agent-hooks/marginfi-adapter

Wraps `@mrgnlabs/marginfi-client-v2` and produces a normalised `LifecycleEvent` for the Agent Hooks runtime.

```ts
import { MarginfiAdapter } from "@agent-hooks/marginfi-adapter";

const adapter = new MarginfiAdapter({ rpcEndpoint: "https://api.mainnet-beta.solana.com" });
const snapshot = await adapter.snapshotPool(groupPubkey);
const event = await adapter.syntheticEvent({ accountPubkey, kind: "beforeBorrow" });
```

The adapter is read-only — it never signs transactions. Operators wire their own signer when they pass the event into the executor.
