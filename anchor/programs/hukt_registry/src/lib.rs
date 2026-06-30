//! HUKT hook registry -- on-chain directory of transfer-hook programs with a
//! bonded attestation and slashing market.
//!
//! Anyone can `register_hook` a program with its preset + metadata. Attestors
//! `attest_hook` by posting a native-SOL bond alongside a Safe/Unsafe verdict,
//! which moves the entry's `safety_score`. The registry authority can
//! `slash_attestor` (seizing the bond, penalizing the score) and `revoke_hook`.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("HkTcGxnRqmyBqrmMb63cad7sfJjzUo5jY4Y3ErQWBrGv");

pub const HOOK_REGISTRY_SEED: &[u8] = b"hook-registry";
pub const ATTESTATION_SEED: &[u8] = b"attestation";

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_URI_LEN: usize = 96;

/// Minimum bond (lamports) an attestor must post: 0.001 SOL.
pub const MIN_BOND: u64 = 1_000_000;

/// Safety-score movement per verdict / slash.
pub const SAFE_SCORE_DELTA: i32 = 10;
pub const UNSAFE_SCORE_DELTA: i32 = 15;
pub const SLASH_PENALTY: i32 = 25;

#[program]
pub mod hukt_registry {
    use super::*;

    /// Register a transfer-hook program in the registry.
    pub fn register_hook(
        ctx: Context<RegisterHook>,
        program_id: Pubkey,
        preset: HookPreset,
        metadata: RegistryMetadata,
    ) -> Result<()> {
        require!(
            metadata.name.len() <= MAX_NAME_LEN,
            RegistryError::MetadataTooLong
        );
        require!(
            metadata.uri.len() <= MAX_URI_LEN,
            RegistryError::MetadataTooLong
        );
        let entry = &mut ctx.accounts.entry;
        entry.authority = ctx.accounts.authority.key();
        entry.program_id = program_id;
        entry.preset = preset;
        entry.name = metadata.name;
        entry.uri = metadata.uri;
        entry.version = metadata.version;
        entry.safety_score = 0;
        entry.attestation_count = 0;
        entry.total_bond = 0;
        entry.revoked = false;
        entry.revoke_reason = 0;
        entry.bump = ctx.bumps.entry;
        Ok(())
    }

    /// Post a bonded attestation for a registered hook.
    pub fn attest_hook(
        ctx: Context<AttestHook>,
        program_id: Pubkey,
        verdict: AttestationVerdict,
        bond_amount: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.entry.revoked, RegistryError::HookRevoked);
        require!(bond_amount >= MIN_BOND, RegistryError::InsufficientBond);

        // Lock the bond in the attestation PDA (on top of its rent).
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.attestor.to_account_info(),
                    to: ctx.accounts.attestation.to_account_info(),
                },
            ),
            bond_amount,
        )?;

        let attestation = &mut ctx.accounts.attestation;
        attestation.attestor = ctx.accounts.attestor.key();
        attestation.program_id = program_id;
        attestation.verdict = verdict;
        attestation.bond_amount = bond_amount;
        attestation.slashed = false;
        attestation.slash_reason = 0;
        attestation.created_ts = Clock::get()?.unix_timestamp;
        attestation.bump = ctx.bumps.attestation;

        let delta: i32 = match verdict {
            AttestationVerdict::Safe => SAFE_SCORE_DELTA,
            AttestationVerdict::Unsafe => -UNSAFE_SCORE_DELTA,
            AttestationVerdict::NeedsReview => 0,
        };
        let entry = &mut ctx.accounts.entry;
        entry.attestation_count = entry
            .attestation_count
            .checked_add(1)
            .ok_or(RegistryError::ArithmeticOverflow)?;
        entry.total_bond = entry
            .total_bond
            .checked_add(bond_amount)
            .ok_or(RegistryError::ArithmeticOverflow)?;
        entry.safety_score = entry
            .safety_score
            .checked_add(delta)
            .ok_or(RegistryError::ArithmeticOverflow)?;
        Ok(())
    }

    /// Slash a false/malicious attestor: seize the bond to the registry
    /// authority, mark the attestation slashed, and penalize the hook's score.
    pub fn slash_attestor(
        ctx: Context<SlashAttestor>,
        _program_id: Pubkey,
        _attestor: Pubkey,
        reason: SlashReason,
    ) -> Result<()> {
        require!(
            !ctx.accounts.attestation.slashed,
            RegistryError::AlreadySlashed
        );
        let bond = ctx.accounts.attestation.bond_amount;

        // Redirect the bonded lamports out of the program-owned attestation PDA
        // into the authority. The PDA keeps its rent-exempt minimum.
        let attestation_ai = ctx.accounts.attestation.to_account_info();
        let authority_ai = ctx.accounts.authority.to_account_info();
        let new_attestation_lamports = attestation_ai
            .lamports()
            .checked_sub(bond)
            .ok_or(RegistryError::ArithmeticOverflow)?;
        let new_authority_lamports = authority_ai
            .lamports()
            .checked_add(bond)
            .ok_or(RegistryError::ArithmeticOverflow)?;
        **attestation_ai.try_borrow_mut_lamports()? = new_attestation_lamports;
        **authority_ai.try_borrow_mut_lamports()? = new_authority_lamports;

        let attestation = &mut ctx.accounts.attestation;
        attestation.slashed = true;
        attestation.slash_reason = (reason as u8).saturating_add(1);
        attestation.bond_amount = 0;

        let entry = &mut ctx.accounts.entry;
        entry.total_bond = entry.total_bond.saturating_sub(bond);
        entry.safety_score = entry
            .safety_score
            .checked_sub(SLASH_PENALTY)
            .ok_or(RegistryError::ArithmeticOverflow)?;
        Ok(())
    }

    /// Revoke a registered hook (marks the entry, stores the reason).
    pub fn revoke_hook(
        ctx: Context<RevokeHook>,
        _program_id: Pubkey,
        reason: RevokeReason,
    ) -> Result<()> {
        require!(!ctx.accounts.entry.revoked, RegistryError::AlreadyRevoked);
        let entry = &mut ctx.accounts.entry;
        entry.revoked = true;
        entry.revoke_reason = (reason as u8).saturating_add(1);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(program_id: Pubkey)]
pub struct RegisterHook<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + HookRegistryEntry::INIT_SPACE,
        seeds = [HOOK_REGISTRY_SEED, program_id.as_ref()],
        bump
    )]
    pub entry: Account<'info, HookRegistryEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(program_id: Pubkey)]
pub struct AttestHook<'info> {
    #[account(mut)]
    pub attestor: Signer<'info>,
    #[account(
        mut,
        seeds = [HOOK_REGISTRY_SEED, program_id.as_ref()],
        bump = entry.bump,
    )]
    pub entry: Account<'info, HookRegistryEntry>,
    #[account(
        init,
        payer = attestor,
        space = 8 + Attestation::INIT_SPACE,
        seeds = [ATTESTATION_SEED, program_id.as_ref(), attestor.key().as_ref()],
        bump
    )]
    pub attestation: Account<'info, Attestation>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(program_id: Pubkey, attestor: Pubkey)]
pub struct SlashAttestor<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [HOOK_REGISTRY_SEED, program_id.as_ref()],
        bump = entry.bump,
        has_one = authority @ RegistryError::Unauthorized,
    )]
    pub entry: Account<'info, HookRegistryEntry>,
    #[account(
        mut,
        seeds = [ATTESTATION_SEED, program_id.as_ref(), attestor.as_ref()],
        bump = attestation.bump,
    )]
    pub attestation: Account<'info, Attestation>,
}

#[derive(Accounts)]
#[instruction(program_id: Pubkey)]
pub struct RevokeHook<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [HOOK_REGISTRY_SEED, program_id.as_ref()],
        bump = entry.bump,
        has_one = authority @ RegistryError::Unauthorized,
    )]
    pub entry: Account<'info, HookRegistryEntry>,
}

/// The eight hook presets HUKT recognizes (mirrors the hook program's set).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum HookPreset {
    Royalty,
    Whitelist,
    Blacklist,
    Vesting,
    AntiBot,
    KYCGate,
    FeeOnTransfer,
    Soulbound,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum AttestationVerdict {
    Safe,
    Unsafe,
    NeedsReview,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SlashReason {
    FalseAttestation,
    MaliciousHook,
    Inactivity,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RevokeReason {
    Deprecated,
    Vulnerability,
    AuthorRequest,
    RegistryDecision,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegistryMetadata {
    pub name: String,
    pub uri: String,
    pub version: u32,
}

#[account]
#[derive(InitSpace)]
pub struct HookRegistryEntry {
    pub authority: Pubkey,
    pub program_id: Pubkey,
    pub preset: HookPreset,
    #[max_len(32)]
    pub name: String,
    #[max_len(96)]
    pub uri: String,
    pub version: u32,
    /// Aggregate attestation score; may go negative under Unsafe verdicts.
    pub safety_score: i32,
    pub attestation_count: u32,
    pub total_bond: u64,
    pub revoked: bool,
    /// 0 = active; otherwise `RevokeReason as u8 + 1`.
    pub revoke_reason: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Attestation {
    pub attestor: Pubkey,
    pub program_id: Pubkey,
    pub verdict: AttestationVerdict,
    pub bond_amount: u64,
    pub slashed: bool,
    /// 0 = not slashed; otherwise `SlashReason as u8 + 1`.
    pub slash_reason: u8,
    pub created_ts: i64,
    pub bump: u8,
}

#[error_code]
pub enum RegistryError {
    #[msg("Hook entry is already revoked")]
    AlreadyRevoked,
    #[msg("Hook entry has been revoked")]
    HookRevoked,
    #[msg("Attestation has already been slashed")]
    AlreadySlashed,
    #[msg("Bond is below the minimum")]
    InsufficientBond,
    #[msg("Metadata field exceeds its maximum length")]
    MetadataTooLong,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Signer is not the registry authority")]
    Unauthorized,
}
