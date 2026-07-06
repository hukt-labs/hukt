# Transfer hook specification

This document specifies the on-chain interface `hukt_hooks` implements and the
offchain resolution `@hukt/account-resolver` performs. It follows the SPL
Token-2022 transfer-hook interface; the concrete values below (discriminators,
seeds, account order, per-preset accounts) match the program in
`anchor/programs/hukt_hooks`.

## Dependency stack

The program is built on a single internally-consistent version set. Do not mix
it with the newer Anchor 1.x / interface-crate stack.

```toml
[dependencies]
anchor-lang = { version = "0.31.1", features = ["init-if-needed", "interface-instructions"] }
anchor-spl  = { version = "0.31.1", features = ["token_2022", "token_2022_extensions"] }
spl-transfer-hook-interface = "0.10.0"
spl-tlv-account-resolution  = "0.10.0"
```

`spl-token-2022` is not a direct dependency: `anchor-spl 0.31.1` provides it
transitively, and extension types are reached through
`anchor_spl::token_2022::spl_token_2022::...`. A direct major pin would
duplicate-link the crate and break the build.

## Instruction discriminators

Token-2022 CPIs into the hook using the SPL Execute discriminator, not an
Anchor-derived one. `#[interface(spl_transfer_hook_interface::execute)]` on
`transfer_hook` overrides Anchor's default so the CPI routes correctly.

| Instruction | Discriminator (first 8 bytes) |
| --- | --- |
| `Execute` | `[105, 37, 101, 197, 75, 251, 102, 26]` (`692565c54bfb661a`) |
| `InitializeExtraAccountMetaList` | `[43, 34, 13, 49, 167, 88, 235, 235]` |
| `UpdateExtraAccountMetaList` | `[157, 105, 42, 146, 102, 85, 241, 174]` |

## Execute account order

Token-2022 always passes these five accounts first, then appends the resolved
extra accounts in the exact order the `ExtraAccountMetaList` declares:

| Index | Account |
| --- | --- |
| 0 | source token account |
| 1 | mint |
| 2 | destination token account |
| 3 | authority (source owner / delegate) |
| 4 | validation PDA (`ExtraAccountMetaList`) |
| 5 | `HookConfig` PDA (always present) |
| 6.. | per-preset accounts |

`HookConfig` at index 5 lets the handler read the active preset mask before it
walks the rest, so it knows which checks to run without a separate lookup.

## PDAs

All PDAs are derived under the hook program id.

| PDA | Seeds |
| --- | --- |
| Validation list | `[b"extra-account-metas", mint]` |
| Hook config | `[b"hook-config", mint]` |
| Whitelist entry | `[b"whitelist", destination_owner]` |
| Blacklist entry | `[b"blacklist", source_owner]` |
| Vesting state | `[b"vesting", mint, source_owner]` |
| Cooldown state | `[b"cooldown", mint, source_owner]` |
| KYC attestation | `[b"kyc", destination_owner]` (owned by the gatekeeper) |
| Soulbound exception | `[b"soulbound-exc", source_owner]` |
| Royalty config | `[b"royalty", mint]` |
| Royalty receipt | `[b"royalty-receipt", mint, source_owner]` |
| Fee config | `[b"fee-config", mint]` |
| Fee vault | `[b"fee-vault", mint]` |

Per-owner PDAs seed from the token accounts' stored owner (the SPL owner field
at data offset 32), encoded as an `AccountData { account_index, 32, 32 }` seed.
Because Token-2022 reconstructs these from the TLV, a caller cannot substitute a
different PDA to dodge a check.

## The eight presets

Presets are composable on one mint via `HookConfig.presets_mask`, a bitmask over
the `HookPreset` enum. The bit position is the enum discriminant, and the
ordering is load-bearing: `meta::PRESET_ORDER`, `meta::build_extra_metas`, and
`hooks::run_transfer_hook` iterate it in lockstep.

| Bit | Preset | Extra accounts | Check |
| --- | --- | --- | --- |
| 0 | Royalty | config, receipt | receipt covers `amount * bps / 10000` |
| 1 | Whitelist | entry | destination owner is allowed |
| 2 | Blacklist | entry | source owner is not blocked |
| 3 | Vesting | state, clock | `now >= unlock_ts` |
| 4 | AntiBot | cooldown (writable), clock | cooldown elapsed and within per-wallet limit |
| 5 | KYCGate | gatekeeper program, attestation | valid, unrevoked, unexpired attestation |
| 6 | FeeOnTransfer | config, vault (writable) | policy satisfied; records the owed fee |
| 7 | Soulbound | exception | transfer only via an allowed exception |

`meta_count(mask)` sizes the validation PDA from the mask alone (before the
config is deserialized) and must equal `build_extra_metas(config).len()`;
`initialize_extra_account_meta_list` asserts this so the on-chain list can never
drift from what the handler consumes.

### Verification-only

A transfer hook has no signing authority over the tokens being moved. It can
only return an error and revert. The Royalty and FeeOnTransfer presets therefore
*verify* a condition (a royalty receipt exists and covers the amount; a fee
policy is satisfied and the vault counter is updated) while the actual value
movement is performed by an approved marketplace/escrow or by the Token-2022
`TransferFee` extension. HUKT copy never claims a hook moves funds.

### The transferring gate

Before any preset runs, `assert_transferring` reads the source account's
`TransferHookAccount` extension and rejects the call unless `transferring` is
true. Token-2022 sets that flag only for the duration of a real transfer CPI, so
a direct `Execute` call cannot poison writable state PDAs (AntiBot cooldown,
FeeOnTransfer vault) outside a genuine transfer.

## Offchain resolution

`@hukt/account-resolver` reconstructs the extra accounts a transfer needs:

1. Read the mint's TransferHook extension to find the hook program id.
2. Derive the validation PDA `[b"extra-account-metas", mint]`.
3. Decode its TLV into `ExtraAccountMeta`s.
4. Resolve each meta against the Execute account order (0 source, 1 mint,
   2 destination, 3 authority, 4 validation, 5+ extras), so `AccountKey`,
   `AccountData`, and external-PDA seeds reference the same indices the program
   sees, and later seeds can reference earlier-resolved extras.

Resolved metas are de-escalated: an extra can never raise the signer/writable
privilege a pubkey already holds among the base accounts.

## Registry

`hukt_registry` is a bonded attestation market. Seeds:
`[b"hook-registry", program_id]` for an entry and
`[b"attestation", program_id, attestor]` for an attestation.

- `register_hook` creates an entry (`safety_score = 0`).
- `attest_hook` locks a bond (`>= 0.001 SOL`) and moves the score: `Safe +10`,
  `Unsafe -15`, `NeedsReview 0`.
- `slash_attestor` (authority-gated) seizes a false attestor's bond and applies
  a `-25` penalty.
- `revoke_hook` (authority-gated) marks an entry revoked with a reason.

The safety score is a signed `i32` and may go negative, so a hook that accrues
Unsafe verdicts and slashes reads as dangerous rather than merely unattested.
See `docs/security.md` for the threat model.
