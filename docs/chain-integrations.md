# Chain integration map

Agent Hooks is built for crypto-native agents, but chain support is adapter-specific. The current code must not be read as a multi-chain listener or execution service.

| Network | In-repository capability | Current boundary |
| --- | --- | --- |
| Solana | RPC log observation, normalized finance alerts, Anchor policy example, wallet-reviewed SPL mint proposal | Protocol decoding and durable production delivery remain host work. |
| Ethereum / EVM | No native listener or EVM contract hook in this repository | A host would need an EVM log reader, finality/reorg handling, and a chain-specific event adapter. |
| Bitcoin | No native listener, script watcher, or transaction builder | A host would need a Bitcoin node/indexer adapter and UTXO-specific policy/execution design. |

## Agent integration path

1. Read chain data through a node or indexer you operate or trust.
2. Verify source identity, canonical inclusion/finality, and decoded account/contract/script fields before marking evidence as verified.
3. Normalize the observation through a chain-specific adapter; do not map an EVM block or Bitcoin height into a Solana slot field.
4. Match a bounded trigger and wake the agent through an explicitly configured dispatcher.
5. Treat model output as an untrusted proposal; run deterministic policy, simulation, limits, and operator review before any signer service acts.

Future adapters should preserve chain-native identifiers and finality semantics, expose replay-safe cursors, and never pass private keys or unrestricted signers to an agent process. See the [architecture](architecture.md) and [security boundaries](security.md) before adding a chain package.
