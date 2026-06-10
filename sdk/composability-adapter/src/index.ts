// @hukt/composability-adapter -- lets existing integrators (DEXs, lending)
// handle transfer-hook tokens safely by appending the hook's resolved extra
// accounts to their instruction account lists. The extra accounts come from
// @hukt/account-resolver; this package only wires them into an instruction.

import { TransactionInstruction, type AccountMeta } from "@solana/web3.js";

export interface InstructionAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * Append a hook's resolved extra accounts to a plain account-meta list (the
 * serializable {pubkey,isSigner,isWritable} shape). Pure and non-mutating.
 * Use wrapTransferInstruction for a web3.js TransactionInstruction.
 */
export function injectExtraAccounts(
  accounts: InstructionAccountMeta[],
  extraAccounts: InstructionAccountMeta[],
): InstructionAccountMeta[] {
  return [...accounts, ...extraAccounts];
}

/**
 * Return a NEW transfer instruction with the hook's resolved extra accounts
 * appended to the base instruction's keys, in order. The input instruction is
 * never mutated; programId and data are carried over unchanged. Passing an
 * empty extras list yields an equivalent instruction (a no-op copy).
 *
 * The extra accounts must already be resolved -- see
 * @hukt/account-resolver resolveExtraAccounts / resolveHook.
 */
export function wrapTransferInstruction(
  baseIx: TransactionInstruction,
  resolvedExtras: AccountMeta[],
): TransactionInstruction {
  return new TransactionInstruction({
    programId: baseIx.programId,
    keys: [...baseIx.keys, ...resolvedExtras],
    data: baseIx.data,
  });
}

export type { AccountMeta } from "@solana/web3.js";
