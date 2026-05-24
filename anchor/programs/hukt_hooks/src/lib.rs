//! HUKT -- Token-2022 transfer hook program suite.
//!
//! Token-2022 CPIs into `transfer_hook` (mapped to the SPL Execute
//! discriminator via `#[interface]`) on every transfer of a mint whose
//! transfer-hook extension points here. The hook is verification-only: it can
//! revert a transfer but never moves tokens itself.
//!
//! A per-mint `HookConfig` PDA records which of the eight presets (Royalty,
//! Whitelist, Blacklist, Vesting, AntiBot, KYCGate, FeeOnTransfer, Soulbound)
//! are active. `initialize_extra_account_meta_list` writes the matching
//! ExtraAccountMetaList TLV so wallets/DEXs can auto-resolve the extra accounts.
//! See docs/hook-spec.md sections 5 and 8.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

pub mod errors;
pub mod hooks;
pub mod meta;
pub mod state;

use errors::HookError;
use state::*;

declare_id!("4q7Tgd9A1XfTB2i6WLUjmFXNocw6GrshZwcKgarGV9aC");

#[program]
pub mod hukt_hooks {
    use super::*;

    /// Create the per-mint `HookConfig` PDA that records the active preset mask
    /// and shared policy parameters. Called once per mint before the meta list.
    pub fn init_hook_config(ctx: Context<InitHookConfig>, params: HookConfigParams) -> Result<()> {
        let config = &mut ctx.accounts.hook_config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.presets_mask = params.presets_mask;
        config.cooldown_secs = params.cooldown_secs;
        config.per_wallet_limit = params.per_wallet_limit;
        config.gatekeeper = params.gatekeeper;
        config.bump = ctx.bumps.hook_config;
        Ok(())
    }

    /// Write the ExtraAccountMetaList TLV for this mint from its `HookConfig`.
    ///
    /// hook-spec section 3.4: implemented as a plain Anchor instruction (option
    /// a). The deployer/CLI calls it directly; the Execute path below keeps the
    /// interface discriminator that Token-2022 actually CPIs.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
        presets_mask: u8,
    ) -> Result<()> {
        require_eq!(
            ctx.accounts.hook_config.presets_mask,
            presets_mask,
            HookError::PresetMismatch
        );
        let metas = meta::build_extra_metas(&ctx.accounts.hook_config)?;
        require_eq!(
            metas.len(),
            meta::meta_count(presets_mask),
            HookError::PresetMismatch
        );
        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;
        Ok(())
    }

    /// Rewrite the ExtraAccountMetaList TLV after a config change (reallocates
    /// the PDA to the new size first).
    pub fn update_extra_account_meta_list(
        ctx: Context<UpdateExtraAccountMetaList>,
        presets_mask: u8,
    ) -> Result<()> {
        require_eq!(
            ctx.accounts.hook_config.presets_mask,
            presets_mask,
            HookError::PresetMismatch
        );
        let metas = meta::build_extra_metas(&ctx.accounts.hook_config)?;
        let new_size = ExtraAccountMetaList::size_of(metas.len())?;

        // The validation PDA is a raw (UncheckedAccount) TLV buffer, so Anchor's
        // `realloc` constraint cannot apply -- resize and re-fund it by hand,
        // then rewrite the TLV from scratch.
        let account = ctx.accounts.extra_account_meta_list.to_account_info();
        let rent = Rent::get()?;
        let new_min = rent.minimum_balance(new_size);
        let current = account.lamports();
        if new_min > current {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: account.clone(),
                    },
                ),
                new_min - current,
            )?;
        } else if new_min < current {
            let refund = current - new_min;
            **account.try_borrow_mut_lamports()? -= refund;
            **ctx
                .accounts
                .payer
                .to_account_info()
                .try_borrow_mut_lamports()? += refund;
        }

        account.realloc(new_size, false)?;
        let mut data = account.try_borrow_mut_data()?;
        for byte in data.iter_mut() {
            *byte = 0;
        }
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;
        Ok(())
    }

    /// Token-2022 Execute entrypoint. `#[interface]` overrides Anchor's default
    /// discriminator with the SPL Execute discriminator so the CPI routes here.
    #[interface(spl_transfer_hook_interface::execute)]
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        hooks::run_transfer_hook(
            ctx.program_id,
            &ctx.accounts.source_token.to_account_info(),
            amount,
            &ctx.accounts.hook_config,
            ctx.remaining_accounts,
        )
    }

    // --- Preset state admin instructions (let tests exercise pass/fail on localnet) ---

    /// Royalty: create/update the recipient whitelist entry for a wallet.
    pub fn set_whitelist_entry(
        ctx: Context<SetWhitelistEntry>,
        owner: Pubkey,
        allowed: bool,
    ) -> Result<()> {
        let entry = &mut ctx.accounts.entry;
        entry.authority = ctx.accounts.authority.key();
        entry.owner = owner;
        entry.allowed = allowed;
        entry.bump = ctx.bumps.entry;
        Ok(())
    }

    /// Blacklist: create/update the sender block entry for a wallet.
    pub fn set_blacklist_entry(
        ctx: Context<SetBlacklistEntry>,
        owner: Pubkey,
        blocked: bool,
    ) -> Result<()> {
        let entry = &mut ctx.accounts.entry;
        entry.authority = ctx.accounts.authority.key();
        entry.owner = owner;
        entry.blocked = blocked;
        entry.bump = ctx.bumps.entry;
        Ok(())
    }

    /// Vesting: set the unlock timestamp for `(mint, owner)`.
    pub fn init_vesting(ctx: Context<InitVesting>, owner: Pubkey, unlock_ts: i64) -> Result<()> {
        let vesting = &mut ctx.accounts.vesting;
        vesting.authority = ctx.accounts.authority.key();
        vesting.mint = ctx.accounts.mint.key();
        vesting.owner = owner;
        vesting.unlock_ts = unlock_ts;
        vesting.bump = ctx.bumps.vesting;
        Ok(())
    }

    /// AntiBot: register the cooldown-tracking account for `(mint, owner)`.
    pub fn init_cooldown(ctx: Context<InitCooldown>, owner: Pubkey) -> Result<()> {
        let cooldown = &mut ctx.accounts.cooldown;
        cooldown.authority = ctx.accounts.authority.key();
        cooldown.mint = ctx.accounts.mint.key();
        cooldown.owner = owner;
        cooldown.last_ts = 0;
        cooldown.accumulated = 0;
        cooldown.bump = ctx.bumps.cooldown;
        Ok(())
    }

    /// KYCGate: issue an attestation for a subject wallet (gatekeeper = HUKT in
    /// this demo, so the account is HUKT-owned).
    pub fn init_kyc_attestation(
        ctx: Context<InitKycAttestation>,
        subject: Pubkey,
        expiry: i64,
    ) -> Result<()> {
        let attestation = &mut ctx.accounts.attestation;
        attestation.authority = ctx.accounts.authority.key();
        attestation.subject = subject;
        attestation.expiry = expiry;
        attestation.revoked = false;
        attestation.bump = ctx.bumps.attestation;
        Ok(())
    }

    /// KYCGate: revoke a previously issued attestation.
    pub fn revoke_kyc_attestation(
        ctx: Context<RevokeKycAttestation>,
        _subject: Pubkey,
    ) -> Result<()> {
        ctx.accounts.attestation.revoked = true;
        Ok(())
    }

    /// Soulbound: allow a specific sender to move otherwise-bound tokens.
    pub fn set_soulbound_exception(
        ctx: Context<SetSoulboundException>,
        owner: Pubkey,
        allowed: bool,
    ) -> Result<()> {
        let exception = &mut ctx.accounts.exception;
        exception.authority = ctx.accounts.authority.key();
        exception.owner = owner;
        exception.allowed = allowed;
        exception.bump = ctx.bumps.exception;
        Ok(())
    }

    /// Royalty: configure the per-mint royalty policy.
    pub fn init_royalty_config(
        ctx: Context<InitRoyaltyConfig>,
        creator: Pubkey,
        royalty_bps: u16,
        enforced: bool,
    ) -> Result<()> {
        let config = &mut ctx.accounts.royalty_config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.creator = creator;
        config.royalty_bps = royalty_bps;
        config.enforced = enforced;
        config.bump = ctx.bumps.royalty_config;
        Ok(())
    }

    /// Royalty: record a paid-royalty receipt for `(mint, subject)`. Stands in
    /// for the marketplace/escrow that actually collected the royalty.
    pub fn set_royalty_receipt(
        ctx: Context<SetRoyaltyReceipt>,
        subject: Pubkey,
        amount_paid: u64,
    ) -> Result<()> {
        let receipt = &mut ctx.accounts.receipt;
        receipt.authority = ctx.accounts.authority.key();
        receipt.mint = ctx.accounts.mint.key();
        receipt.subject = subject;
        receipt.amount_paid = amount_paid;
        receipt.bump = ctx.bumps.receipt;
        Ok(())
    }

    /// FeeOnTransfer: configure the fee policy and its accounting vault.
    pub fn init_fee_config(
        ctx: Context<InitFeeConfig>,
        fee_bps: u16,
        min_transfer: u64,
        paused: bool,
    ) -> Result<()> {
        let config = &mut ctx.accounts.fee_config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.fee_bps = fee_bps;
        config.min_transfer = min_transfer;
        config.paused = paused;
        config.bump = ctx.bumps.fee_config;

        let vault = &mut ctx.accounts.fee_vault;
        vault.authority = ctx.accounts.authority.key();
        vault.mint = ctx.accounts.mint.key();
        vault.total_fees_recorded = 0;
        vault.transfer_count = 0;
        vault.bump = ctx.bumps.fee_vault;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitHookConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + HookConfig::INIT_SPACE,
        seeds = [HOOK_CONFIG_SEED, mint.key().as_ref()],
        bump
    )]
    pub hook_config: Account<'info, HookConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(presets_mask: u8)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: ExtraAccountMetaList PDA. Created here owned by this program; its
    /// TLV data is written in the handler and validated by seeds.
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(meta::meta_count(presets_mask))?,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [HOOK_CONFIG_SEED, mint.key().as_ref()],
        bump = hook_config.bump,
    )]
    pub hook_config: Account<'info, HookConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: ExtraAccountMetaList PDA, validated by seeds; resized and its TLV
    /// rewritten by the handler.
    #[account(
        mut,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [HOOK_CONFIG_SEED, mint.key().as_ref()],
        bump = hook_config.bump,
    )]
    pub hook_config: Account<'info, HookConfig>,
    pub system_program: Program<'info, System>,
}

/// Execute account order: 0 source, 1 mint, 2 destination, 3 authority,
/// 4 validation, 5 HookConfig, then preset accounts via `remaining_accounts`.
#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: source authority/delegate; preset checks key off the token
    /// accounts' stored owners, not this account.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList validation PDA.
    #[account(
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(
        seeds = [HOOK_CONFIG_SEED, mint.key().as_ref()],
        bump = hook_config.bump,
    )]
    pub hook_config: Account<'info, HookConfig>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct SetWhitelistEntry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + WhitelistEntry::INIT_SPACE,
        seeds = [WHITELIST_SEED, owner.as_ref()],
        bump
    )]
    pub entry: Account<'info, WhitelistEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct SetBlacklistEntry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + BlacklistEntry::INIT_SPACE,
        seeds = [BLACKLIST_SEED, owner.as_ref()],
        bump
    )]
    pub entry: Account<'info, BlacklistEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct InitVesting<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + VestingState::INIT_SPACE,
        seeds = [VESTING_SEED, mint.key().as_ref(), owner.as_ref()],
        bump
    )]
    pub vesting: Account<'info, VestingState>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct InitCooldown<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + CooldownState::INIT_SPACE,
        seeds = [COOLDOWN_SEED, mint.key().as_ref(), owner.as_ref()],
        bump
    )]
    pub cooldown: Account<'info, CooldownState>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(subject: Pubkey)]
pub struct InitKycAttestation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + KycAttestation::INIT_SPACE,
        seeds = [KYC_SEED, subject.as_ref()],
        bump
    )]
    pub attestation: Account<'info, KycAttestation>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(subject: Pubkey)]
pub struct RevokeKycAttestation<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [KYC_SEED, subject.as_ref()],
        bump = attestation.bump,
        has_one = authority @ HookError::Unauthorized,
    )]
    pub attestation: Account<'info, KycAttestation>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct SetSoulboundException<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + SoulboundException::INIT_SPACE,
        seeds = [SOULBOUND_EXC_SEED, owner.as_ref()],
        bump
    )]
    pub exception: Account<'info, SoulboundException>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitRoyaltyConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + RoyaltyConfig::INIT_SPACE,
        seeds = [ROYALTY_SEED, mint.key().as_ref()],
        bump
    )]
    pub royalty_config: Account<'info, RoyaltyConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(subject: Pubkey)]
pub struct SetRoyaltyReceipt<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + RoyaltyReceipt::INIT_SPACE,
        seeds = [ROYALTY_RECEIPT_SEED, mint.key().as_ref(), subject.as_ref()],
        bump
    )]
    pub receipt: Account<'info, RoyaltyReceipt>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitFeeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + FeeConfig::INIT_SPACE,
        seeds = [FEE_CONFIG_SEED, mint.key().as_ref()],
        bump
    )]
    pub fee_config: Account<'info, FeeConfig>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + FeeVault::INIT_SPACE,
        seeds = [FEE_VAULT_SEED, mint.key().as_ref()],
        bump
    )]
    pub fee_vault: Account<'info, FeeVault>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}
