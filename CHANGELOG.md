# Changelog

All notable changes to HUKT are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `HookKind::from_slug` in `libs/hook-library`, the inverse of `slug`, so the
  CLI and SDK can parse preset names without panicking on unknown input.
- A chain-free worked example, `examples/simulate-presets.ts`, that composes
  four presets, previews the required extra accounts, and simulates transfers.

## [0.1.0]

First public cut of the framework.

### On-chain

- `hukt_hooks`: eight composable presets (Royalty, Whitelist, Blacklist,
  Vesting, AntiBot, KYCGate, FeeOnTransfer, Soulbound) behind a single Execute
  entrypoint driven by a per-mint `HookConfig` mask.
- `initialize_extra_account_meta_list` / `update_extra_account_meta_list` write
  and resize the `ExtraAccountMetaList` TLV from the active preset set.
- `assert_transferring` gates Execute so a direct call cannot poison writable
  state PDAs outside a live Token-2022 transfer.
- `hukt_registry`: bonded attestation market with Safe/Unsafe/NeedsReview
  verdicts, a safety score, and authority slashing and revocation.
- `hukt_hooks` deployed to devnet as the reference hook
  (`4q7Tgd9A1XfTB2i6WLUjmFXNocw6GrshZwcKgarGV9aC`); `hukt_registry` builds and is
  tested, with its devnet deployment pending.

### Shared Rust libraries

- `hook-library`: preset taxonomy, slugs, and the basis-point royalty math.
- `hook-registry`: risk-flag taxonomy and the malicious-pattern scoring
  attestors apply.

### TypeScript SDK

- `@hukt/account-resolver`: reads a mint's `ExtraAccountMetaList` and
  reconstructs the exact ordered extra accounts a transfer needs.
- `@hukt/composability-adapter`: appends resolved accounts to an existing
  instruction.
- `@hukt/hook-builder`: composes presets into a deployment spec and simulates
  the outcome with no chain access.
- `@hukt/resolver` and the `hukt` CLI: one-line integration surface.

### Tooling

- Localnet integration tests for every preset and composed masks.
- CI running `cargo fmt`, `cargo clippy`, the shared-library tests, and the SDK
  typecheck and test suites.

[Unreleased]: https://github.com/hukt-labs/hukt/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hukt-labs/hukt/releases/tag/v0.1.0
