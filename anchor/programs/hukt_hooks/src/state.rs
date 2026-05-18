//! On-chain state for the HUKT transfer-hook program.
//!
//! One `HookConfig` PDA per mint records which of the eight presets are active
//! (a bitmask) plus the shared per-mint policy parameters. Each preset then
//! reads or writes its own small PDA(s); those account layouts live here too.

use anchor_lang::prelude::*;

// --- PDA seed prefixes (shared by Anchor contexts and the ExtraAccountMeta builder) ---
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";
pub const HOOK_CONFIG_SEED: &[u8] = b"hook-config";
pub const WHITELIST_SEED: &[u8] = b"whitelist";
pub const BLACKLIST_SEED: &[u8] = b"blacklist";
pub const VESTING_SEED: &[u8] = b"vesting";
pub const COOLDOWN_SEED: &[u8] = b"cooldown";
pub const KYC_SEED: &[u8] = b"kyc";
pub const SOULBOUND_EXC_SEED: &[u8] = b"soulbound-exc";
pub const ROYALTY_SEED: &[u8] = b"royalty";
pub const ROYALTY_RECEIPT_SEED: &[u8] = b"royalty-receipt";
pub const FEE_CONFIG_SEED: &[u8] = b"fee-config";
pub const FEE_VAULT_SEED: &[u8] = b"fee-vault";

/// The eight composable hook presets. The discriminant doubles as the bit
/// position inside `HookConfig::presets_mask`, so ordering here is load-bearing
/// and must stay in sync with `meta::PRESET_ORDER`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum HookPreset {
    Royalty = 0,
    Whitelist = 1,
    Blacklist = 2,
    Vesting = 3,
    AntiBot = 4,
    KYCGate = 5,
    FeeOnTransfer = 6,
    Soulbound = 7,
}

impl HookPreset {
    /// Single-bit mask for this preset inside `HookConfig::presets_mask`.
    pub const fn bit(self) -> u8 {
        1u8 << (self as u8)
    }
}

/// True when `preset` is enabled in `mask`.
pub fn mask_has(mask: u8, preset: HookPreset) -> bool {
    mask & preset.bit() != 0
}

/// Instruction payload for `init_hook_config`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct HookConfigParams {
    /// Bitmask over `HookPreset` of the presets this mint enforces.
    pub presets_mask: u8,
    /// AntiBot: minimum seconds between transfers from the same wallet.
    pub cooldown_secs: i64,
    /// AntiBot: maximum tokens a single wallet may move per transfer.
    pub per_wallet_limit: u64,
    /// KYCGate: program that owns the recipient's attestation PDA.
    pub gatekeeper: Pubkey,
}

/// Per-mint hook configuration. Always resolved as the first extra account
/// (list index 5) so `transfer_hook` can read the active preset mask + params.
#[account]
#[derive(InitSpace)]
pub struct HookConfig {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub presets_mask: u8,
    pub cooldown_secs: i64,
    pub per_wallet_limit: u64,
    pub gatekeeper: Pubkey,
    pub bump: u8,
}

/// Whitelist entry keyed by the recipient's wallet (global across mints, per
/// hook-spec section 8: seed `[b"whitelist", destination_owner]`).
#[account]
#[derive(InitSpace)]
pub struct WhitelistEntry {
    pub authority: Pubkey,
    pub owner: Pubkey,
    pub allowed: bool,
    pub bump: u8,
}

/// Blacklist entry keyed by the sender's wallet. Presence + `blocked` reverts.
#[account]
#[derive(InitSpace)]
pub struct BlacklistEntry {
    pub authority: Pubkey,
    pub owner: Pubkey,
    pub blocked: bool,
    pub bump: u8,
}

/// Vesting/lockup state keyed by `[b"vesting", mint, source_owner]`.
#[account]
#[derive(InitSpace)]
pub struct VestingState {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub unlock_ts: i64,
    pub bump: u8,
}

/// Anti-bot cooldown state keyed by `[b"cooldown", mint, source_owner]`.
/// The hook holds this account writable and updates it during a transfer.
#[account]
#[derive(InitSpace)]
pub struct CooldownState {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub last_ts: i64,
    pub accumulated: u64,
    pub bump: u8,
}

/// KYC attestation for a subject wallet. In this demo the gatekeeper program is
/// HUKT itself, so the account is HUKT-owned; a third-party gatekeeper would own
/// an identically-shaped account (the hook deserializes it owner-agnostically).
#[account]
#[derive(InitSpace)]
pub struct KycAttestation {
    pub authority: Pubkey,
    pub subject: Pubkey,
    pub expiry: i64,
    pub revoked: bool,
    pub bump: u8,
}

/// Royalty policy for a mint. `enforced` gates whether a receipt is required.
#[account]
#[derive(InitSpace)]
pub struct RoyaltyConfig {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub royalty_bps: u16,
    pub enforced: bool,
    pub bump: u8,
}

/// Proof that royalty was paid for a `(mint, source_owner)` pair. Written by an
/// approved marketplace/escrow; the hook only verifies its existence + amount.
#[account]
#[derive(InitSpace)]
pub struct RoyaltyReceipt {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub subject: Pubkey,
    pub amount_paid: u64,
    pub bump: u8,
}

/// Fee-on-transfer policy for a mint (read-only during a transfer).
#[account]
#[derive(InitSpace)]
pub struct FeeConfig {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub fee_bps: u16,
    pub min_transfer: u64,
    pub paused: bool,
    pub bump: u8,
}

/// Accounting vault the hook updates with the fee it *would* owe. Actual fee
/// movement is done by the Token-2022 TransferFee extension, not this hook.
#[account]
#[derive(InitSpace)]
pub struct FeeVault {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub total_fees_recorded: u64,
    pub transfer_count: u64,
    pub bump: u8,
}

/// Soulbound exception keyed by the sender's wallet. Absent/`allowed == false`
/// means the transfer is rejected.
#[account]
#[derive(InitSpace)]
pub struct SoulboundException {
    pub authority: Pubkey,
    pub owner: Pubkey,
    pub allowed: bool,
    pub bump: u8,
}
