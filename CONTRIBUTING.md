# Contributing

AGENT HOOKS is open source under Apache-2.0. PRs are welcome.

## Local setup

```
rustup install 1.79.0
cargo --version              # 1.79.0
node --version               # 20.x or later
pnpm --version               # 9.x
anchor --version             # 0.31.0
solana --version             # 1.18.x
```

Then:

```
pnpm install
cargo build --workspace
anchor build
```

## Project shape

The repo is a Rust + TypeScript monorepo plus the Anchor program for the on-chain executor:

```
packages/
  hook-runtime/        Rust crate — lifecycle types, Composition, Simulator
  hook-library/        Rust crate — the six standard hooks
  anchor-program/      Anchor 0.31 program (the on-chain executor)
  marginfi-adapter/    TS package — wraps @mrgnlabs/marginfi-client-v2
  kamino-adapter/      TS package — wraps @kamino-finance/klend-sdk
  solend-adapter/      TS package — wraps @solendprotocol/solend-sdk
  sdk-ts/              TS package — Composition builder + executor client + simulator
  cli/                 @agent-hooks/cli (npm)
  vscode-extension/    VS Code extension
```

## Writing a new hook

Adding a hook means writing a Rust crate under `packages/hook-library` and registering it in the SDK helpers.

1. Add the crate and a struct that implements `agent_hooks_runtime::Hook`.
2. Declare the flag bitmap in the constructor.
3. Add unit tests under `#[cfg(test)] mod tests`.
4. Mirror the hook in `packages/sdk-ts/src/hooks.ts` so SDK users get a typed helper.
5. Update the CLI `list` command and `examples/` if applicable.

## Testing

```
cargo test --workspace --exclude agent-hooks-executor
pnpm --filter @agent-hooks/sdk run typecheck
pnpm --filter @agent-hooks/sdk run test
```

The executor's mocha tests need a localnet validator and live under `packages/anchor-program/tests/`:

```
anchor test
```

## Commit messages

Plain English. Short. Imperative or descriptive — both are fine. Don't prefix with `feat:` / `fix:` / `chore:`; the changelog is hand-maintained.

## PR review

Two reviewers from the core authors. CI must pass. New hooks need at least one unit test that covers the rejection path and one that covers the side-effect path.

## Security disclosures

See `.github/SECURITY.md`. Do not open public issues for vulnerabilities.
