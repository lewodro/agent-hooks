# Security and trust boundaries

Agent Hooks is a development prototype. The runtime and simulator contain real deterministic hook evaluation; the current Anchor program is an eligibility and receipt prototype. Do not treat its `HookRan.decision` value as an evaluated hook result: it is currently emitted as `Accept` for every flag-eligible entry.

## Transaction authority

- `agent-runtime` creates and validates proposals. It does not have wallet or transaction-signing code.
- `agent-brain` stores observations behind an application-provided `ExperienceStore`; deployments are responsible for protecting the store and validating its data.
- `ExecutorClient` accepts an RPC endpoint and signer. Any application that constructs it can submit transactions with that signer, so keep it outside model prompts and agent tools that do not need transaction authority.
- The CLI `deploy` command prints a generic plan and does not deploy, sign, or verify an operator-approved keypair. Operators must independently inspect the program ID, cluster, wallet, and balance before any deployment.
- X access should use a separate read/post identity. Never share an X credential or Solana key with the on-chain executor. X content is untrusted evidence and must not directly authorize a composition change.

## Current on-chain checks

The Anchor prototype verifies the event kind range, composition-to-pool binding, adapter equality, payload size (256 bytes maximum), pool authority for composition updates, hook count (maximum eight), and distinct priorities. It counts entries whose lifecycle flag matches the event and emits receipts.

The current `run_composition` path does not CPI into hook programs, read published listing flags as an execution allowlist, or apply hook side effects. `publish_hook` records a program, author, declared flags, and manifest URI for discovery. It does not yet guarantee that a listed program is safe or that its manifest matches executable behavior. Reassess these boundaries after CPI execution is implemented.

## Requirements before production use

1. Implement and test CPI invocation for each hook program, including account constraints, compute and stack limits, failure behavior, and side-effect validation.
2. Bind each execution to a specific pool authority and composition version, and enforce published-hook capability flags on-chain.
3. Add adversarial integration tests for malformed event data, stale or manipulated oracle inputs, reentrancy/CPI edge cases, duplicate or reordered hooks, and rejected hooks.
4. Have the program and each production hook reviewed independently; verify deployed program IDs and upgrade authorities.
5. Keep agent proposal, social-data, memory-store, RPC, and transaction-signing permissions separate. Require simulation plus explicit operator approval for composition mutations until the full execution path is audited.
