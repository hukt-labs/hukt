# Security

Two surfaces matter: the transfer hook itself (which sits in the path of every
transfer of an adopting mint) and the registry that tells integrators whether a
hook is safe to trust. This document describes the defenses each implements.

## 1. Hook invariants and defenses

### Verification-only

A transfer hook has no signing authority over the tokens being moved, so it
cannot transfer, mint, or burn. It can only return an error and revert the
transfer. HUKT never claims otherwise: the Royalty and FeeOnTransfer presets
*verify* a condition (a royalty receipt exists and covers the amount; a fee
policy is satisfied and the accounting vault is updated) while the actual value
movement is performed by an approved marketplace/escrow or by the Token-2022
`TransferFee` extension. Copy and README must not overstate this.

### The "transferring" gate

`assert_transferring` reads the source account's `TransferHookAccount`
extension and rejects the call unless `transferring` is true. Token-2022 sets
that flag only for the duration of a real transfer CPI. Without this gate, a
caller could invoke `Execute` directly to poison writable state PDAs (for
example, advancing an AntiBot cooldown or inflating a FeeVault counter) outside
a genuine transfer. Every preset runs behind this gate.

### Writable accounts are program-owned PDAs only

Only two presets take a writable extra account -- AntiBot's cooldown state and
FeeOnTransfer's accounting vault -- and both are HUKT-owned PDAs derived from
the mint (and, for cooldown, the sender). The hook re-checks `is_writable` and
loads them owner-scoped before writing. It never writes to an account it does
not own, which is exactly the "unexpected write" pattern attestors scan for.

### Deterministic, spoof-resistant account derivation

Per-recipient and per-sender PDAs are seeded from the *token accounts' stored
owners* (`AccountData{account_index, 32, 32}` -- offset 32 is the SPL owner
field), not from a caller-supplied account. Whitelist keys off the destination
owner, Blacklist/Vesting/AntiBot/Soulbound off the source owner, and KYC off the
destination owner via an external-PDA derive owned by the configured gatekeeper.
Because Token-2022 reconstructs these from the `ExtraAccountMetaList` TLV, a
caller cannot substitute a different PDA to dodge a check.

### Config integrity and arithmetic safety

`initialize_extra_account_meta_list` requires the caller's `presets_mask` to
equal the stored `HookConfig` mask and requires the built meta list length to
equal `meta_count(mask)`, so the on-chain account list can never drift from what
the handler consumes. All bps/amount math uses `checked_mul`/`checked_add` (and
`saturating_sub` on decrements), returning `MathOverflow` rather than wrapping.

### Failure reasons are distinct

Every preset maps its failure to a distinct `HookError` variant
(`NotWhitelisted`, `Blacklisted`, `StillLocked`, `CooldownActive`, `KycInvalid`,
`RoyaltyUnpaid`, `FeePolicyViolation`, `TransferNotAllowed`, ...), so wallets and
DEXs can show a precise reason instead of an opaque revert.

## 2. Registry attestation and slashing

The registry (`hukt_registry`) is a bonded attestation market that lets
integrators price the risk of a hook.

### State machine

```
register_hook  -> entry { safety_score = 0, attestation_count = 0, revoked = false }
attest_hook    -> lock bond (>= MIN_BOND) in the attestation PDA;
                  Safe: score += 10 | Unsafe: score -= 15 | NeedsReview: score += 0
slash_attestor -> seize the attestation's bond to the registry authority,
                  mark it slashed, score -= 25
revoke_hook    -> mark the entry revoked with a reason; further attestation is refused
```

- **Bond.** `attest_hook` transfers `bond_amount` (minimum `MIN_BOND` = 0.001
  SOL) from the attestor into the attestation PDA via a system-program CPI, on
  top of the PDA's rent. Skin in the game is a prerequisite to move a score.
- **Slash.** `slash_attestor` redirects exactly the bonded lamports out of the
  program-owned attestation PDA into the authority (the PDA retains its
  rent-exempt minimum), sets `slashed = true`, zeroes `bond_amount`, and
  subtracts a `SLASH_PENALTY` from the hook's score. A slash cannot be repeated
  (`AlreadySlashed`).
- **Admin gating.** `slash_attestor` and `revoke_hook` are guarded by
  `has_one = authority`; only the registry authority can slash or revoke.
- **Safety score** is a signed `i32` and may go negative, so a hook that
  accrues Unsafe verdicts and slashes reads as dangerous rather than merely
  unattested.

### Verdicts and reasons

`AttestationVerdict` is `Safe | Unsafe | NeedsReview`. `SlashReason` is
`FalseAttestation | MaliciousHook | Inactivity`. `RevokeReason` is
`Deprecated | Vulnerability | AuthorRequest | RegistryDecision`. Reason codes
are stored as `enum as u8 + 1` (0 means active/not-slashed) so state is
unambiguous.

## 3. Registry threat model

- **Malicious hook patterns.** Attestors scan a deployed hook for the three
  dangerous behaviors the shared `hook-registry` types enumerate: transfers that
  can be permanently blocked (freezing funds), balances that can be redirected
  (drain), and writes to accounts outside the resolved `ExtraAccountMetaList`.
  The first two mark a hook Malicious; the third marks it Caution.
- **Sybil / lazy attestation.** Because every verdict requires a locked bond and
  a false Safe verdict is slashable (`FalseAttestation`), spamming favorable
  attestations is costly and reversible.
- **Resolver as a safety check.** The offchain resolver reconstructs exactly the
  accounts the hook declared. An integrator that sees a transfer requiring an
  account the resolver did not derive should treat it as a red flag -- the hook
  is trying to reach outside its declared set.
- **Authority centralization.** Slash/revoke are currently authority-gated,
  which is a trust assumption to decentralize (multisig, then a governance
  process) as the registry matures. It is stated here rather than hidden.

## 4. Deployment safety

No build or test step sends a mainnet or devnet transaction. `anchor build`
and `cargo build-sbf` only compile; `anchor test` runs against an ephemeral
local validator with a throwaway keypair. A real deployment happens only under
an explicit, user-provided deploy keypair with an approved cluster and verified
balance -- never an auto-generated key and never the machine's default CLI
keypair.
