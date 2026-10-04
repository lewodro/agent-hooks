# agent-hooks-cli

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
```

`agent-hooks deploy` is plan-only by design — actually running `anchor deploy` requires the operator to confirm the keypair pubkey and balance.
