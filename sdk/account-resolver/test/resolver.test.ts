import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type AccountInfo,
  type Commitment,
  type Connection,
} from "@solana/web3.js";
import {
  ExtraAccountMetaLayout,
  getExtraAccountMetaAddress,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  AccountType,
  ACCOUNT_SIZE,
  ExtensionType,
  type ExtraAccountMeta,
} from "@solana/spl-token";
import { resolveExtraAccounts, resolveHook } from "../src/index";

// --- fixtures ---------------------------------------------------------------

const key = (): PublicKey => Keypair.generate().publicKey;

const HOOK_PROGRAM = key();
const MINT = key();
const FROM = key();
const TO = key();
const AUTHORITY = key();
const FROM_OWNER = key();
const TO_OWNER = key();
const GATEKEEPER = key();
const CREATOR = key();
const AMOUNT = 123_456_789n;

const EXECUTE_DISCRIMINATOR = [105, 37, 101, 197, 75, 251, 102, 26];
const EXTRA_ACCOUNT_META_SPAN = 35; // u8 discriminator + 32 addressConfig + 2 bools

// --- seed packing (mirrors spl-token unpackSeeds wire format) ---------------

type SeedSpec =
  | { kind: "literal"; bytes: Uint8Array }
  | { kind: "instructionData"; index: number; length: number }
  | { kind: "accountKey"; index: number }
  | { kind: "accountData"; accountIndex: number; dataIndex: number; length: number };

function lit(s: string): SeedSpec {
  return { kind: "literal", bytes: new TextEncoder().encode(s) };
}

function packSeeds(seeds: SeedSpec[]): Uint8Array {
  const out: number[] = [];
  for (const s of seeds) {
    switch (s.kind) {
      case "literal":
        out.push(1, s.bytes.length, ...s.bytes);
        break;
      case "instructionData":
        out.push(2, s.index, s.length);
        break;
      case "accountKey":
        out.push(3, s.index);
        break;
      case "accountData":
        out.push(4, s.accountIndex, s.dataIndex, s.length);
        break;
    }
  }
  if (out.length > 32) throw new Error("seeds exceed the 32-byte addressConfig");
  const buf = new Uint8Array(32);
  buf.set(out, 0);
  return buf;
}

// --- ExtraAccountMeta builders ----------------------------------------------

function literalPubkeyMeta(pk: PublicKey, isSigner = false, isWritable = false): ExtraAccountMeta {
  const cfg = new Uint8Array(32);
  cfg.set(pk.toBuffer(), 0);
  return { discriminator: 0, addressConfig: cfg, isSigner, isWritable };
}

function thisPdaMeta(seeds: SeedSpec[], isSigner = false, isWritable = false): ExtraAccountMeta {
  return { discriminator: 1, addressConfig: packSeeds(seeds), isSigner, isWritable };
}

function externalPdaMeta(
  programIndex: number,
  seeds: SeedSpec[],
  isSigner = false,
  isWritable = false,
): ExtraAccountMeta {
  return { discriminator: (1 << 7) + programIndex, addressConfig: packSeeds(seeds), isSigner, isWritable };
}

// --- account crafting -------------------------------------------------------

function acc(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
  return { data, owner, lamports: 1, executable: false, rentEpoch: 0 };
}

/** Craft the raw bytes of a validation account: u64 disc, u32 length, u32 count, N metas. */
function craftValidationData(metas: ExtraAccountMeta[]): Buffer {
  const listLen = 4 + EXTRA_ACCOUNT_META_SPAN * metas.length;
  const buf = Buffer.alloc(8 + 4 + listLen);
  Buffer.from(EXECUTE_DISCRIMINATOR).copy(buf, 0);
  buf.writeUInt32LE(listLen, 8);
  buf.writeUInt32LE(metas.length, 12);
  let off = 16;
  for (const m of metas) {
    ExtraAccountMetaLayout.encode(m, buf, off);
    off += EXTRA_ACCOUNT_META_SPAN;
  }
  return buf;
}

/** SPL token account bytes with `mint` at offset 0 and `owner` at offset 32. */
function tokenAccount(mint: PublicKey, owner: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  return acc(data, TOKEN_2022_PROGRAM_ID);
}

/** Craft an extended Token-2022 mint carrying a TransferHook extension. */
function hookMint(hookProgramId: PublicKey): AccountInfo<Buffer> {
  const tlv = Buffer.alloc(4 + 64); // [type u16][len u16][authority 32][programId 32]
  tlv.writeUInt16LE(ExtensionType.TransferHook, 0);
  tlv.writeUInt16LE(64, 2);
  key().toBuffer().copy(tlv, 4); // hook update authority
  hookProgramId.toBuffer().copy(tlv, 36);

  const data = Buffer.alloc(ACCOUNT_SIZE + 1 + tlv.length);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: key(),
      supply: 1_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  data.writeUInt8(AccountType.Mint, ACCOUNT_SIZE);
  tlv.copy(data, ACCOUNT_SIZE + 1);
  return acc(data, TOKEN_2022_PROGRAM_ID);
}

function connectionWith(entries: Array<[PublicKey, AccountInfo<Buffer>]>): Connection {
  const map = new Map(entries.map(([pk, a]) => [pk.toBase58(), a] as const));
  return {
    getAccountInfo: async (pk: PublicKey, _commitment?: Commitment) => map.get(pk.toBase58()) ?? null,
  } as unknown as Connection;
}

/** Validation account + source/destination token accounts wired into a connection. */
function setup(metas: ExtraAccountMeta[]): { conn: Connection; validationPda: PublicKey } {
  const validationPda = getExtraAccountMetaAddress(MINT, HOOK_PROGRAM);
  return {
    validationPda,
    conn: connectionWith([
      [validationPda, acc(craftValidationData(metas), HOOK_PROGRAM)],
      [FROM, tokenAccount(MINT, FROM_OWNER)],
      [TO, tokenAccount(MINT, TO_OWNER)],
    ]),
  };
}

function pda(seeds: Array<Buffer | Uint8Array>, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function amountLE(amount: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(amount);
  return b;
}

function run(metas: ExtraAccountMeta[]) {
  const { conn } = setup(metas);
  return resolveExtraAccounts(conn, MINT, HOOK_PROGRAM, FROM, TO, AUTHORITY, AMOUNT);
}

// --- tests ------------------------------------------------------------------

describe("resolveExtraAccounts: 8-preset extra-account resolution", () => {
  it("royalty: [royalty, mint] config PDA + creator token account (both read-only)", async () => {
    const metas = [
      thisPdaMeta([lit("royalty"), { kind: "accountKey", index: 1 }]),
      literalPubkeyMeta(CREATOR),
    ];
    const resolved = await run(metas);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.pubkey.equals(pda([Buffer.from("royalty"), MINT.toBuffer()], HOOK_PROGRAM))).toBe(true);
    expect(resolved[0]!.isWritable).toBe(false);
    expect(resolved[1]!.pubkey.equals(CREATOR)).toBe(true);
  });

  it("whitelist: PDA keyed on the recipient owner (AccountData on destination index 2)", async () => {
    const metas = [thisPdaMeta([lit("whitelist"), { kind: "accountData", accountIndex: 2, dataIndex: 32, length: 32 }])];
    const resolved = await run(metas);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.pubkey.equals(pda([Buffer.from("whitelist"), TO_OWNER.toBuffer()], HOOK_PROGRAM))).toBe(true);
  });

  it("blacklist: PDA keyed on the sender owner (AccountData on source index 0)", async () => {
    const metas = [thisPdaMeta([lit("blacklist"), { kind: "accountData", accountIndex: 0, dataIndex: 32, length: 32 }])];
    const resolved = await run(metas);
    expect(resolved[0]!.pubkey.equals(pda([Buffer.from("blacklist"), FROM_OWNER.toBuffer()], HOOK_PROGRAM))).toBe(true);
  });

  it("vesting: PDA over [vesting, mint, amount] via Literal + AccountKey + InstructionData, plus Clock", async () => {
    const metas = [
      thisPdaMeta([lit("vesting"), { kind: "accountKey", index: 1 }, { kind: "instructionData", index: 8, length: 8 }]),
      literalPubkeyMeta(SYSVAR_CLOCK_PUBKEY),
    ];
    const resolved = await run(metas);
    expect(resolved).toHaveLength(2);
    const expected = pda([Buffer.from("vesting"), MINT.toBuffer(), amountLE(AMOUNT)], HOOK_PROGRAM);
    expect(resolved[0]!.pubkey.equals(expected)).toBe(true);
    expect(resolved[1]!.pubkey.equals(SYSVAR_CLOCK_PUBKEY)).toBe(true);
  });

  it("antibot: writable cooldown PDA (AccountData on source) + Clock", async () => {
    const metas = [
      thisPdaMeta(
        [lit("cooldown"), { kind: "accountKey", index: 1 }, { kind: "accountData", accountIndex: 0, dataIndex: 32, length: 32 }],
        false,
        true,
      ),
      literalPubkeyMeta(SYSVAR_CLOCK_PUBKEY),
    ];
    const resolved = await run(metas);
    const expected = pda([Buffer.from("cooldown"), MINT.toBuffer(), FROM_OWNER.toBuffer()], HOOK_PROGRAM);
    expect(resolved[0]!.pubkey.equals(expected)).toBe(true);
    expect(resolved[0]!.isWritable).toBe(true); // hook may update its own state PDA
  });

  it("kycgate: external gatekeeper PDA (disc 128+idx) referencing an earlier-resolved account", async () => {
    // index 5 = gatekeeper program (literal); the KYC attestation PDA is owned by it.
    const metas = [
      literalPubkeyMeta(GATEKEEPER),
      externalPdaMeta(5, [lit("kyc"), { kind: "accountData", accountIndex: 2, dataIndex: 32, length: 32 }]),
    ];
    const resolved = await run(metas);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.pubkey.equals(GATEKEEPER)).toBe(true);
    // Derived under the gatekeeper program (external), NOT the hook program.
    expect(resolved[1]!.pubkey.equals(pda([Buffer.from("kyc"), TO_OWNER.toBuffer()], GATEKEEPER))).toBe(true);
  });

  it("fee-on-transfer: read-only fee-config PDA + writable fee-vault PDA", async () => {
    const metas = [
      thisPdaMeta([lit("fee-config"), { kind: "accountKey", index: 1 }]),
      thisPdaMeta([lit("fee-vault"), { kind: "accountKey", index: 1 }], false, true),
    ];
    const resolved = await run(metas);
    expect(resolved[0]!.pubkey.equals(pda([Buffer.from("fee-config"), MINT.toBuffer()], HOOK_PROGRAM))).toBe(true);
    expect(resolved[0]!.isWritable).toBe(false);
    expect(resolved[1]!.pubkey.equals(pda([Buffer.from("fee-vault"), MINT.toBuffer()], HOOK_PROGRAM))).toBe(true);
    expect(resolved[1]!.isWritable).toBe(true);
  });

  it("soulbound: no extra accounts", async () => {
    const resolved = await run([]);
    expect(resolved).toEqual([]);
  });
});

describe("resolveExtraAccounts: mechanics", () => {
  it("returns [] when the mint has no ExtraAccountMetaList PDA", async () => {
    const conn = connectionWith([
      [FROM, tokenAccount(MINT, FROM_OWNER)],
      [TO, tokenAccount(MINT, TO_OWNER)],
    ]);
    const resolved = await resolveExtraAccounts(conn, MINT, HOOK_PROGRAM, FROM, TO, AUTHORITY, AMOUNT);
    expect(resolved).toEqual([]);
  });

  it("resolves a literal Clock sysvar (discriminator 0) without fetching it", async () => {
    const resolved = await run([literalPubkeyMeta(SYSVAR_CLOCK_PUBKEY)]);
    expect(resolved[0]!.pubkey.equals(SYSVAR_CLOCK_PUBKEY)).toBe(true);
  });

  it("de-escalates a resolved extra so it cannot raise a base account's privileges", async () => {
    // The mint sits at base index 1 as read-only; a writable/signer literal for it must be lowered.
    const resolved = await run([literalPubkeyMeta(MINT, true, true)]);
    expect(resolved[0]!.pubkey.equals(MINT)).toBe(true);
    expect(resolved[0]!.isSigner).toBe(false);
    expect(resolved[0]!.isWritable).toBe(false);
  });

  it("resolves multiple presets in order, sharing earlier-resolved accounts", async () => {
    const metas = [
      thisPdaMeta([lit("whitelist"), { kind: "accountData", accountIndex: 2, dataIndex: 32, length: 32 }]),
      thisPdaMeta([lit("vesting"), { kind: "accountKey", index: 1 }, { kind: "instructionData", index: 8, length: 8 }]),
      literalPubkeyMeta(SYSVAR_CLOCK_PUBKEY),
    ];
    const resolved = await run(metas);
    expect(resolved.map((m) => m.pubkey.toBase58())).toEqual([
      pda([Buffer.from("whitelist"), TO_OWNER.toBuffer()], HOOK_PROGRAM).toBase58(),
      pda([Buffer.from("vesting"), MINT.toBuffer(), amountLE(AMOUNT)], HOOK_PROGRAM).toBase58(),
      SYSVAR_CLOCK_PUBKEY.toBase58(),
    ]);
  });
});

describe("resolveHook", () => {
  it("returns a null hook for a missing / non-Token-2022 mint", async () => {
    const conn = connectionWith([]); // getMint sees no account and throws -> treated as no hook
    const res = await resolveHook(conn, MINT);
    expect(res.hookProgramId).toBeNull();
    expect(res.validationPda).toBeNull();
    expect(res.extraAccounts).toEqual([]);
  });

  it("discovers the hook program id and validation PDA from the mint's TransferHook extension", async () => {
    const conn = connectionWith([[MINT, hookMint(HOOK_PROGRAM)]]);
    const res = await resolveHook(conn, MINT);
    expect(res.hookProgramId?.equals(HOOK_PROGRAM)).toBe(true);
    expect(res.validationPda?.equals(getExtraAccountMetaAddress(MINT, HOOK_PROGRAM))).toBe(true);
    expect(res.extraAccounts).toEqual([]); // no transfer context -> discovery only
  });

  it("resolves extra accounts end-to-end when given a transfer context", async () => {
    const validationPda = getExtraAccountMetaAddress(MINT, HOOK_PROGRAM);
    const metas = [thisPdaMeta([lit("whitelist"), { kind: "accountData", accountIndex: 2, dataIndex: 32, length: 32 }])];
    const conn = connectionWith([
      [MINT, hookMint(HOOK_PROGRAM)],
      [validationPda, acc(craftValidationData(metas), HOOK_PROGRAM)],
      [FROM, tokenAccount(MINT, FROM_OWNER)],
      [TO, tokenAccount(MINT, TO_OWNER)],
    ]);
    const res = await resolveHook(conn, MINT, {
      transfer: { source: FROM, destination: TO, authority: AUTHORITY, amount: AMOUNT },
    });
    expect(res.hookProgramId?.equals(HOOK_PROGRAM)).toBe(true);
    expect(res.extraAccounts).toHaveLength(1);
    expect(res.extraAccounts[0]!.pubkey.equals(pda([Buffer.from("whitelist"), TO_OWNER.toBuffer()], HOOK_PROGRAM))).toBe(true);
  });
});
