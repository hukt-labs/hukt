import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { injectExtraAccounts, wrapTransferInstruction } from "../src/index";

const key = (): PublicKey => Keypair.generate().publicKey;

function meta(pubkey: PublicKey, isSigner = false, isWritable = false): AccountMeta {
  return { pubkey, isSigner, isWritable };
}

function baseInstruction(keys: AccountMeta[], data = Buffer.from([1, 2, 3])): TransactionInstruction {
  return new TransactionInstruction({ programId: key(), keys, data });
}

describe("wrapTransferInstruction", () => {
  it("appends resolved extras after the base keys, preserving order", () => {
    const source = meta(key());
    const dest = meta(key());
    const extra1 = meta(key(), false, true);
    const extra2 = meta(key());
    const base = baseInstruction([source, dest]);

    const wrapped = wrapTransferInstruction(base, [extra1, extra2]);

    expect(wrapped.keys.map((k) => k.pubkey.toBase58())).toEqual([
      source.pubkey.toBase58(),
      dest.pubkey.toBase58(),
      extra1.pubkey.toBase58(),
      extra2.pubkey.toBase58(),
    ]);
    // Flags are carried through untouched.
    expect(wrapped.keys[2]!.isWritable).toBe(true);
  });

  it("is a no-op for an empty extras list (equivalent keys)", () => {
    const base = baseInstruction([meta(key()), meta(key())]);
    const wrapped = wrapTransferInstruction(base, []);
    expect(wrapped.keys).toHaveLength(2);
    expect(wrapped.keys.map((k) => k.pubkey.toBase58())).toEqual(base.keys.map((k) => k.pubkey.toBase58()));
  });

  it("does not mutate the input instruction", () => {
    const base = baseInstruction([meta(key()), meta(key())]);
    const originalKeys = base.keys;
    const beforeLen = base.keys.length;

    wrapTransferInstruction(base, [meta(key()), meta(key())]);

    expect(base.keys.length).toBe(beforeLen); // still 2
    expect(base.keys).toBe(originalKeys); // same array reference, untouched
  });

  it("returns a new instruction and carries over programId and data", () => {
    const base = baseInstruction([meta(key())], Buffer.from([9, 8, 7]));
    const wrapped = wrapTransferInstruction(base, [meta(key())]);

    expect(wrapped).not.toBe(base);
    expect(wrapped.programId.equals(base.programId)).toBe(true);
    expect([...wrapped.data]).toEqual([9, 8, 7]);
  });
});

describe("injectExtraAccounts", () => {
  it("appends plain account metas without mutating the inputs", () => {
    const accounts = [{ pubkey: "a", isSigner: false, isWritable: true }];
    const extras = [{ pubkey: "b", isSigner: false, isWritable: false }];
    const result = injectExtraAccounts(accounts, extras);

    expect(result.map((a) => a.pubkey)).toEqual(["a", "b"]);
    expect(accounts).toHaveLength(1); // input untouched
    expect(extras).toHaveLength(1);
  });
});
