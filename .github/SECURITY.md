# Security policy

## Reporting

If you find a vulnerability in the hook executor, the runtime, or any of the adapters, do not open a public issue. Email `security@agent-hooks.dev` with the following:

- Affected component and commit hash.
- Reproduction steps or a proof-of-concept.
- Suggested severity (low / medium / high / critical).

We acknowledge reports within 72 hours and aim to ship a fix or an advisory within 14 days for high / critical findings.

## Scope

In scope:

- The Anchor program in `packages/anchor-program/programs/agent-hooks-executor`.
- The Rust runtime in `packages/hook-runtime`.
- The standard hooks in `packages/hook-library`.
- The TypeScript SDK in `packages/sdk-ts`.

Out of scope:

- Third-party adapters' upstream SDKs (`@mrgnlabs/marginfi-client-v2`, `@kamino-finance/klend-sdk`, `@solendprotocol/solend-sdk`). Report those upstream.
- Compromised RPC endpoints. The hook executor reads on-chain state; clients are responsible for choosing trustworthy RPC providers.
- The VS Code extension's webview rendering (no privileged context).

## Deploy gates

The executor program is not deployed automatically. `agent-hooks deploy` prints the plan; the actual `anchor deploy --provider.cluster mainnet` is operator-driven and requires the deployer to confirm the keypair pubkey and balance.
