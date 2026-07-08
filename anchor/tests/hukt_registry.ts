import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { HuktRegistry } from "../target/types/hukt_registry";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";

describe("hukt_registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.HuktRegistry as Program<HuktRegistry>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // A fake hook program id to register/attest against.
  const hookProgram = Keypair.generate().publicKey;

  const registryPda = (pid: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("hook-registry"), pid.toBuffer()],
      program.programId
    )[0];
  const attestationPda = (pid: PublicKey, attestor: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("attestation"), pid.toBuffer(), attestor.toBuffer()],
      program.programId
    )[0];

  async function fund(pubkey: PublicKey, lamports: number) {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pubkey, lamports })
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);
  }

  async function expectError(promise: Promise<unknown>, code: string) {
    let threw = false;
    let actual = "";
    try {
      await promise;
    } catch (e: any) {
      threw = true;
      actual = e?.error?.errorCode?.code ?? `${e?.message ?? String(e)}`;
    }
    expect(threw, `expected error ${code}`).to.eq(true);
    expect(actual, `error should be ${code}`).to.include(code);
  }

  it("registers a hook", async () => {
    await program.methods
      .registerHook(hookProgram, { whitelist: {} }, {
        name: "Whitelist Hook",
        uri: "https://hukt.fun/hooks/whitelist",
        version: 1,
      })
      .accountsStrict({
        authority: payer.publicKey,
        entry: registryPda(hookProgram),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const entry = await program.account.hookRegistryEntry.fetch(registryPda(hookProgram));
    expect(entry.programId.toBase58()).to.eq(hookProgram.toBase58());
    expect(entry.safetyScore).to.eq(0);
    expect(entry.attestationCount).to.eq(0);
    expect(entry.revoked).to.eq(false);
    expect(entry.name).to.eq("Whitelist Hook");
  });

  it("rejects a duplicate registration", async () => {
    await expectError(
      program.methods
        .registerHook(hookProgram, { whitelist: {} }, {
          name: "dup",
          uri: "https://hukt.fun",
          version: 1,
        })
        .accountsStrict({
          authority: payer.publicKey,
          entry: registryPda(hookProgram),
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "already in use"
    );
  });

  it("rejects metadata that is too long", async () => {
    const otherHook = Keypair.generate().publicKey;
    await expectError(
      program.methods
        .registerHook(otherHook, { royalty: {} }, {
          name: "x".repeat(33),
          uri: "https://hukt.fun",
          version: 1,
        })
        .accountsStrict({
          authority: payer.publicKey,
          entry: registryPda(otherHook),
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "MetadataTooLong"
    );
  });

  const attestor1 = Keypair.generate();
  const bond = 0.05 * LAMPORTS_PER_SOL;

  it("accepts a bonded Safe attestation and raises the safety score", async () => {
    await fund(attestor1.publicKey, 0.5 * LAMPORTS_PER_SOL);
    await program.methods
      .attestHook(hookProgram, { safe: {} }, new anchor.BN(bond))
      .accountsStrict({
        attestor: attestor1.publicKey,
        entry: registryPda(hookProgram),
        attestation: attestationPda(hookProgram, attestor1.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([attestor1])
      .rpc();

    const entry = await program.account.hookRegistryEntry.fetch(registryPda(hookProgram));
    expect(entry.safetyScore).to.eq(10);
    expect(entry.attestationCount).to.eq(1);
    expect(entry.totalBond.toNumber()).to.eq(bond);

    const att = await program.account.attestation.fetch(
      attestationPda(hookProgram, attestor1.publicKey)
    );
    expect(att.bondAmount.toNumber()).to.eq(bond);
    expect(att.slashed).to.eq(false);
  });

  it("rejects a bond below the minimum", async () => {
    const attestor2 = Keypair.generate();
    await fund(attestor2.publicKey, 0.1 * LAMPORTS_PER_SOL);
    await expectError(
      program.methods
        .attestHook(hookProgram, { unsafe: {} }, new anchor.BN(100))
        .accountsStrict({
          attestor: attestor2.publicKey,
          entry: registryPda(hookProgram),
          attestation: attestationPda(hookProgram, attestor2.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([attestor2])
        .rpc(),
      "InsufficientBond"
    );
  });

  it("rejects a slash from a non-authority", async () => {
    const intruder = Keypair.generate();
    await fund(intruder.publicKey, 0.1 * LAMPORTS_PER_SOL);
    await expectError(
      program.methods
        .slashAttestor(hookProgram, attestor1.publicKey, { falseAttestation: {} })
        .accountsStrict({
          authority: intruder.publicKey,
          entry: registryPda(hookProgram),
          attestation: attestationPda(hookProgram, attestor1.publicKey),
        })
        .signers([intruder])
        .rpc(),
      "Unauthorized"
    );
  });

  it("slashes an attestor: seizes the bond and penalizes the score", async () => {
    const authBefore = await connection.getBalance(payer.publicKey);
    await program.methods
      .slashAttestor(hookProgram, attestor1.publicKey, { falseAttestation: {} })
      .accountsStrict({
        authority: payer.publicKey,
        entry: registryPda(hookProgram),
        attestation: attestationPda(hookProgram, attestor1.publicKey),
      })
      .rpc();

    const att = await program.account.attestation.fetch(
      attestationPda(hookProgram, attestor1.publicKey)
    );
    expect(att.slashed).to.eq(true);
    expect(att.bondAmount.toNumber()).to.eq(0);

    const entry = await program.account.hookRegistryEntry.fetch(registryPda(hookProgram));
    expect(entry.safetyScore).to.eq(10 - 25); // SAFE_SCORE_DELTA - SLASH_PENALTY
    expect(entry.totalBond.toNumber()).to.eq(0);

    const authAfter = await connection.getBalance(payer.publicKey);
    expect(authAfter).to.be.greaterThan(authBefore); // received the seized bond
  });

  it("rejects a double slash", async () => {
    await expectError(
      program.methods
        .slashAttestor(hookProgram, attestor1.publicKey, { maliciousHook: {} })
        .accountsStrict({
          authority: payer.publicKey,
          entry: registryPda(hookProgram),
          attestation: attestationPda(hookProgram, attestor1.publicKey),
        })
        .rpc(),
      "AlreadySlashed"
    );
  });

  it("revokes a hook and then blocks further attestations", async () => {
    await program.methods
      .revokeHook(hookProgram, { vulnerability: {} })
      .accountsStrict({ authority: payer.publicKey, entry: registryPda(hookProgram) })
      .rpc();
    const entry = await program.account.hookRegistryEntry.fetch(registryPda(hookProgram));
    expect(entry.revoked).to.eq(true);

    const attestor3 = Keypair.generate();
    await fund(attestor3.publicKey, 0.5 * LAMPORTS_PER_SOL);
    await expectError(
      program.methods
        .attestHook(hookProgram, { safe: {} }, new anchor.BN(bond))
        .accountsStrict({
          attestor: attestor3.publicKey,
          entry: registryPda(hookProgram),
          attestation: attestationPda(hookProgram, attestor3.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([attestor3])
        .rpc(),
      "HookRevoked"
    );
  });

  it("rejects a double revoke", async () => {
    await expectError(
      program.methods
        .revokeHook(hookProgram, { deprecated: {} })
        .accountsStrict({ authority: payer.publicKey, entry: registryPda(hookProgram) })
        .rpc(),
      "AlreadyRevoked"
    );
  });
});
