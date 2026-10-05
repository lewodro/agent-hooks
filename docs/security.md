# Security and trust boundaries

Agent Hooks is a development prototype. The runtime and simulator contain deterministic host-side hook evaluation. The composition registry's `HookRan.decision` value is a placeholder emitted as `Accept` for every flag-eligible entry; do not treat it as an evaluated hook result. A separate `agent-hooks-policy` example enforces slippage and cooldown only when the configured executor integrates it through CPI.

## Transaction authority

- `agent-runtime` creates and validates proposals. It does not have wallet or transaction-signing code.
- `agent-brain` stores observations behind an application-provided `ExperienceStore`; deployments are responsible for protecting the store and validating its data.
- `ExecutorClient` accepts an RPC endpoint and signer. Any application that constructs it can submit transactions with that signer, so keep it outside model prompts and agent tools that do not need transaction authority.
- The CLI `deploy` command prints a generic plan and does not deploy, sign, or verify an operator-approved keypair. Operators must independently inspect the program ID, cluster, wallet, and balance before any deployment.
- X access should use a separate read/post identity. Never share an X credential or Solana key with the on-chain executor. X content is untrusted evidence and must not directly authorize a composition change.
- `apps/x-agent-bot/agent_x.py` loads per-profile X credentials from an ignored env file, drafts from explicitly supplied context, and is dry-run by default. Interactive posting requires confirmation; unattended posting requires both `--auto-post` and `X_AGENT_AUTOPUBLISH=true`. Its ignored local history limits a single local profile installation to one recorded post per UTC day, but is not a distributed quota. OAuth 1.0a and OAuth 2.0 user-context tokens are supported; app-only bearer tokens are not write authority. The script has no transaction-signing permission.
- `@agent-hooks/toolkit/treasury` models allowlisted proposals for Solana, Bitcoin, and Ethereum with network-qualified destinations/assets and base-unit caps. It deliberately has no key, wallet, RPC, or transaction broadcast implementation. A human approval in this in-memory queue is not authenticated approval and cannot be treated as sufficient authorization to transfer funds.

## Current on-chain checks

The Anchor prototype verifies the event kind range, composition-to-pool binding, adapter equality, payload size (256 bytes maximum), pool authority for composition updates, hook count (maximum eight), and distinct priorities. It counts entries whose lifecycle flag matches the event and emits receipts.

The current `run_composition` path does not CPI into hook programs, read published listing flags as an execution allowlist, or apply hook side effects. `publish_hook` records a program, author, declared flags, and manifest URI for discovery. It does not yet guarantee that a listed program is safe or that its manifest matches executable behavior. Reassess these boundaries after CPI execution is implemented.

The policy-hook example validates the configured executor program account and requires the configured executor PDA to sign. It computes slippage from caller-supplied `quoted_out` and `minimum_out`; the trusted executor must pass the same values to the actual operation and bind `action_hash` to that operation. A malicious or incorrect executor can lie about quotes or ignore policy unless it actually propagates the CPI failure. Review the integration and upgrade authority before relying on it.

## Requirements before production use

1. Integrate the policy gate into a real downstream execution program and test quote binding, CPI rejection, slot cooldown, and full-transaction rollback. Separately implement CPI invocation for registered composition hooks.
2. Bind each execution to a specific pool authority and composition version, and enforce published-hook capability flags on-chain.
3. Add adversarial integration tests for malformed event data, stale or manipulated oracle inputs, reentrancy/CPI edge cases, duplicate or reordered hooks, and rejected hooks.
4. Have the program and each production hook reviewed independently; verify deployed program IDs and upgrade authorities.
5. Keep agent proposal, social data, memory-store, RPC, X posting, and transaction-signing permissions separate. Require simulation plus explicit operator approval for composition mutations until the full execution path is audited.
