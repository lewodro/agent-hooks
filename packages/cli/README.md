# @agent-hooks/cli

Command-line tools for creating hook templates, deterministic simulations, receipt inspection, and non-signing agent proposals.

```
npm i -g @agent-hooks/cli
```

## Commands

```
agent-hooks list                            print the standard hook library
agent-hooks create hook --name MyHook       scaffold a hook source file
agent-hooks create composition              prompt-driven composition.ts
agent-hooks simulate --pool SOL-USDC        run the deterministic simulator
agent-hooks action                          write .github/workflows/agent-hooks-hook-ci.yml
agent-hooks deploy --cluster mainnet        print an Anchor deploy plan (does not broadcast)
agent-hooks agent plan --objective "Review SOL-USDC liquidation hooks"
agent-hooks agent plan --objective "Review SOL-USDC liquidation hooks" --fingerprint
agent-hooks agent plan --objective "Review SOL-USDC liquidation hooks" --json
```

`agent-hooks deploy` is plan-only by design — actually running `anchor deploy` requires the operator to confirm the keypair pubkey and balance.

`--fingerprint` prints the SHA-256 identity of the canonical proposal body. Persist that value with an authenticated operator approval before an application-owned transaction service considers a mutation. The CLI never signs, sends, or approves transactions.
