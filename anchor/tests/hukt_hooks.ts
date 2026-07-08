import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { HuktHooks } from "../target/types/hukt_hooks";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createAssociatedTokenAccountIdempotent,
  mintTo,
  createTransferCheckedWithTransferHookInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";

// Preset bitmask (must match state::HookPreset discriminants).
const P = {
  Royalty: 1 << 0,
  Whitelist: 1 << 1,
  Blacklist: 1 << 2,
  Vesting: 1 << 3,
  AntiBot: 1 << 4,
  KYCGate: 1 << 5,
  FeeOnTransfer: 1 << 6,
  Soulbound: 1 << 7,
};

const DECIMALS = 0;

describe("hukt_hooks", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.HuktHooks as Program<HuktHooks>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const enc = (s: string) => Buffer.from(s);
  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const hookConfigPda = (mint: PublicKey) => pda([enc("hook-config"), mint.toBuffer()]);
  const extraMetasPda = (mint: PublicKey) => pda([enc("extra-account-metas"), mint.toBuffer()]);

  async function createHookMint(): Promise<PublicKey> {
    const mint = Keypair.generate();
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mint.publicKey,
        payer.publicKey,
        program.programId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        DECIMALS,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(connection, tx, [payer, mint]);
    return mint.publicKey;
  }

  async function initConfig(
    mint: PublicKey,
    mask: number,
    opts: { cooldownSecs?: number; perWalletLimit?: number; gatekeeper?: PublicKey } = {}
  ) {
    await program.methods
      .initHookConfig({
        presetsMask: mask,
        cooldownSecs: new anchor.BN(opts.cooldownSecs ?? 0),
        perWalletLimit: new anchor.BN(opts.perWalletLimit ?? 0),
        gatekeeper: opts.gatekeeper ?? PublicKey.default,
      })
      .accountsStrict({
        authority: payer.publicKey,
        hookConfig: hookConfigPda(mint),
        mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .initializeExtraAccountMetaList(mask)
      .accountsStrict({
        payer: payer.publicKey,
        extraAccountMetaList: extraMetasPda(mint),
        mint,
        hookConfig: hookConfigPda(mint),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async function makeHolder(
    mint: PublicKey,
    amount: number
  ): Promise<{ owner: Keypair; ata: PublicKey }> {
    const owner = Keypair.generate();
    const ata = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      mint,
      owner.publicKey,
      {},
      TOKEN_2022_PROGRAM_ID
    );
    if (amount > 0) {
      await mintTo(connection, payer, mint, ata, payer, amount, [], {}, TOKEN_2022_PROGRAM_ID);
    }
    return { owner, ata };
  }

  async function doTransfer(
    mint: PublicKey,
    source: PublicKey,
    dest: PublicKey,
    owner: Keypair,
    amount: number
  ) {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection,
      source,
      mint,
      dest,
      owner.publicKey,
      BigInt(amount),
      DECIMALS,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(connection, tx, [payer, owner]);
  }

  async function expectRevert(promise: Promise<unknown>, code: string) {
    let threw = false;
    let text = "";
    try {
      await promise;
    } catch (e: any) {
      threw = true;
      const logs = e?.logs ? e.logs.join("\n") : "";
      text = `${logs}\n${e?.message ?? String(e)}`;
    }
    expect(threw, `expected transfer to revert with ${code}`).to.eq(true);
    expect(text, `revert reason should mention ${code}`).to.include(code);
  }

  async function balance(ata: PublicKey): Promise<bigint> {
    const res = await connection.getTokenAccountBalance(ata);
    return BigInt(res.value.amount);
  }

  it("Royalty: reverts without receipt, reverts on underpayment, passes when paid", async () => {
    const mint = await createHookMint();
    await initConfig(mint, P.Royalty);
    const sender = await makeHolder(mint, 10_000);
    const recipient = await makeHolder(mint, 0);
    await program.methods
      .initRoyaltyConfig(payer.publicKey, 500, true) // 5% enforced
      .accountsStrict({
        authority: payer.publicKey,
        royaltyConfig: pda([enc("royalty"), mint.toBuffer()]),
        mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // No receipt.
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 1_000),
      "RoyaltyUnpaid"
    );

    const receiptPda = pda([enc("royalty-receipt"), mint.toBuffer(), sender.owner.publicKey.toBuffer()]);
    const setReceipt = (amountPaid: number) =>
      program.methods
        .setRoyaltyReceipt(sender.owner.publicKey, new anchor.BN(amountPaid))
        .accountsStrict({
          authority: payer.publicKey,
          receipt: receiptPda,
          mint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

    // Underpaid: expected royalty on 1000 @5% = 50, paid 1.
    await setReceipt(1);
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 1_000),
      "RoyaltyUnpaid"
    );

    // Paid enough.
    await setReceipt(100);
    await doTransfer(mint, sender.ata, recipient.ata, sender.owner, 1_000);
    expect(await balance(recipient.ata)).to.eq(1_000n);
  });

  it("Whitelist: reverts when absent, reverts when disallowed, passes when allowed", async () => {
    const mint = await createHookMint();
    await initConfig(mint, P.Whitelist);
    const sender = await makeHolder(mint, 10_000);
    const recipient = await makeHolder(mint, 0);
    const entryPda = pda([enc("whitelist"), recipient.owner.publicKey.toBuffer()]);
    const setEntry = (allowed: boolean) =>
      program.methods
        .setWhitelistEntry(recipient.owner.publicKey, allowed)
        .accountsStrict({
          authority: payer.publicKey,
          entry: entryPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 500),
      "NotWhitelisted"
    );
    await setEntry(false);
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 500),
      "NotWhitelisted"
    );
    await setEntry(true);
    await doTransfer(mint, sender.ata, recipient.ata, sender.owner, 500);
    expect(await balance(recipient.ata)).to.eq(500n);
  });

  it("Blacklist: passes when clear, reverts when blocked, passes after unblock", async () => {
    const mint = await createHookMint();
    await initConfig(mint, P.Blacklist);
    const sender = await makeHolder(mint, 10_000);
    const recipient = await makeHolder(mint, 0);
    const entryPda = pda([enc("blacklist"), sender.owner.publicKey.toBuffer()]);
    const setEntry = (blocked: boolean) =>
      program.methods
        .setBlacklistEntry(sender.owner.publicKey, blocked)
        .accountsStrict({
          authority: payer.publicKey,
          entry: entryPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

    // No entry => allowed.
    await doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100);
    await setEntry(true);
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100),
      "Blacklisted"
    );
    await setEntry(false);
    await doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100);
    expect(await balance(recipient.ata)).to.eq(200n);
  });

  it("Vesting: passes without schedule, reverts while locked, passes after unlock", async () => {
    const mint = await createHookMint();
    await initConfig(mint, P.Vesting);
    const sender = await makeHolder(mint, 10_000);
    const recipient = await makeHolder(mint, 0);
    const vestingPda = pda([
      enc("vesting"),
      mint.toBuffer(),
      sender.owner.publicKey.toBuffer(),
    ]);
    const setUnlock = (unlockTs: number) =>
      program.methods
        .initVesting(sender.owner.publicKey, new anchor.BN(unlockTs))
        .accountsStrict({
          authority: payer.publicKey,
          vesting: vestingPda,
          mint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

    // No schedule => allowed.
    await doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100);

    // Locked far in the future.
    await setUnlock(Math.floor(Date.now() / 1000) + 3600);
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100),
      "StillLocked"
    );

    // Unlocked in the past.
    await setUnlock(1);
    await doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100);
    expect(await balance(recipient.ata)).to.eq(200n);
  });

  it("AntiBot: first transfer passes, immediate repeat hits cooldown, over-limit rejected", async () => {
    const mint = await createHookMint();
    await initConfig(mint, P.AntiBot, { cooldownSecs: 3600, perWalletLimit: 1_000 });
    const sender = await makeHolder(mint, 10_000);
    const recipient = await makeHolder(mint, 0);

    const cooldownPda = (owner: PublicKey) =>
      pda([enc("cooldown"), mint.toBuffer(), owner.toBuffer()]);
    const initCooldown = (owner: PublicKey) =>
      program.methods
        .initCooldown(owner)
        .accountsStrict({
          authority: payer.publicKey,
          cooldown: cooldownPda(owner),
          mint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

    await initCooldown(sender.owner.publicKey);
    await doTransfer(mint, sender.ata, recipient.ata, sender.owner, 500);
    expect(await balance(recipient.ata)).to.eq(500n);

    // Immediate repeat within the 1h cooldown.
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 500),
      "CooldownActive"
    );

    // Fresh sender, amount above the per-wallet limit.
    const sender2 = await makeHolder(mint, 10_000);
    await initCooldown(sender2.owner.publicKey);
    await expectRevert(
      doTransfer(mint, sender2.ata, recipient.ata, sender2.owner, 5_000),
      "LimitExceeded"
    );
  });

  it("KYCGate: reverts without attestation, passes when attested, reverts once revoked", async () => {
    const mint = await createHookMint();
    await initConfig(mint, P.KYCGate, { gatekeeper: program.programId });
    const sender = await makeHolder(mint, 10_000);
    const recipient = await makeHolder(mint, 0);
    const attestationPda = pda([enc("kyc"), recipient.owner.publicKey.toBuffer()]);

    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100),
      "KycInvalid"
    );

    await program.methods
      .initKycAttestation(recipient.owner.publicKey, new anchor.BN(Math.floor(Date.now() / 1000) + 3600))
      .accountsStrict({
        authority: payer.publicKey,
        attestation: attestationPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100);
    expect(await balance(recipient.ata)).to.eq(100n);

    await program.methods
      .revokeKycAttestation(recipient.owner.publicKey)
      .accountsStrict({ authority: payer.publicKey, attestation: attestationPda })
      .rpc();
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100),
      "KycInvalid"
    );
  });

  it("FeeOnTransfer: records fee on valid transfer, rejects below-min and paused", async () => {
    const mint = await createHookMint();
    await initConfig(mint, P.FeeOnTransfer);
    const sender = await makeHolder(mint, 100_000);
    const recipient = await makeHolder(mint, 0);
    const feeConfigPda = pda([enc("fee-config"), mint.toBuffer()]);
    const feeVaultPda = pda([enc("fee-vault"), mint.toBuffer()]);
    const setFeeConfig = (feeBps: number, minTransfer: number, paused: boolean) =>
      program.methods
        .initFeeConfig(feeBps, new anchor.BN(minTransfer), paused)
        .accountsStrict({
          authority: payer.publicKey,
          feeConfig: feeConfigPda,
          feeVault: feeVaultPda,
          mint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

    await setFeeConfig(100, 10, false); // 1%, min 10
    await doTransfer(mint, sender.ata, recipient.ata, sender.owner, 1_000);
    expect(await balance(recipient.ata)).to.eq(1_000n);
    const vault = await program.account.feeVault.fetch(feeVaultPda);
    expect(vault.totalFeesRecorded.toNumber()).to.eq(10); // 1% of 1000
    expect(vault.transferCount.toNumber()).to.eq(1);

    // Below minimum transfer.
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 5),
      "FeePolicyViolation"
    );

    // Paused.
    await setFeeConfig(100, 10, true);
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 1_000),
      "FeePolicyViolation"
    );
  });

  it("Soulbound: reverts by default, passes with exception, reverts when exception disabled", async () => {
    const mint = await createHookMint();
    await initConfig(mint, P.Soulbound);
    const sender = await makeHolder(mint, 10_000);
    const recipient = await makeHolder(mint, 0);
    const exceptionPda = pda([enc("soulbound-exc"), sender.owner.publicKey.toBuffer()]);
    const setException = (allowed: boolean) =>
      program.methods
        .setSoulboundException(sender.owner.publicKey, allowed)
        .accountsStrict({
          authority: payer.publicKey,
          exception: exceptionPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100),
      "TransferNotAllowed"
    );
    await setException(true);
    await doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100);
    expect(await balance(recipient.ata)).to.eq(100n);
    await setException(false);
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100),
      "TransferNotAllowed"
    );
  });

  it("Composed (Whitelist + Blacklist): enforces both preset checks in one hook", async () => {
    const mint = await createHookMint();
    await initConfig(mint, P.Whitelist | P.Blacklist);
    const sender = await makeHolder(mint, 10_000);
    const recipient = await makeHolder(mint, 0);

    // Recipient not whitelisted yet -> revert.
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100),
      "NotWhitelisted"
    );

    // Whitelist recipient; still passes blacklist (sender clear).
    await program.methods
      .setWhitelistEntry(recipient.owner.publicKey, true)
      .accountsStrict({
        authority: payer.publicKey,
        entry: pda([enc("whitelist"), recipient.owner.publicKey.toBuffer()]),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100);
    expect(await balance(recipient.ata)).to.eq(100n);

    // Blacklist the sender -> revert even though recipient is whitelisted.
    await program.methods
      .setBlacklistEntry(sender.owner.publicKey, true)
      .accountsStrict({
        authority: payer.publicKey,
        entry: pda([enc("blacklist"), sender.owner.publicKey.toBuffer()]),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await expectRevert(
      doTransfer(mint, sender.ata, recipient.ata, sender.owner, 100),
      "Blacklisted"
    );
  });
});
