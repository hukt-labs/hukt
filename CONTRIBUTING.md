# Contributing

Thanks for your interest in HUKT. The project is a monorepo with three parts:
the on-chain Anchor programs (`anchor/`), the shared Rust libraries (`libs/`),
and the TypeScript SDK and CLI (`sdk/`).

## Development

Rust programs and libraries:

```bash
# on-chain programs (needs the Solana toolchain + Anchor 0.31.1)
cd anchor && anchor build && anchor test

# shared libraries (plain cargo)
cd libs/hook-library && cargo test
cd libs/hook-registry && cargo test
```

TypeScript SDK:

```bash
cd sdk && npm install
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
```

## Ground rules

- Keep the preset ordering in `state.rs`, `meta.rs`, and `hooks.rs` in lockstep.
  The `ExtraAccountMetaList` the program writes and the accounts the handler
  reads must always agree; there is a test for every preset.
- A transfer hook is verification-only. Do not add logic that assumes the hook
  can move, mint, or burn tokens. Value-moving policies verify a condition that
  a marketplace/escrow or the Token-2022 `TransferFee` extension settles.
- Run `cargo fmt`, `cargo clippy`, and the SDK test suite before opening a PR.
- New presets need: a `HookPreset` variant, its extra-account layout in
  `meta.rs`, a validator in `hooks.rs`, a distinct `HookError`, and a test.

## Reporting issues

Open a GitHub issue with a minimal reproduction. For anything that looks like a
vulnerability in the hook or registry programs, please describe the impact and
the account/instruction path rather than posting a working exploit.
