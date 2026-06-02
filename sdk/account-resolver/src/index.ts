// @hukt/account-resolver -- offchain resolution of a transfer hook's
// ExtraAccountMetaList, following the spl-transfer-hook-interface spec. Wallets
// and DEXs use this to learn which extra accounts a transfer instruction needs.
//
// Public RPC only: this package never assumes a keyed endpoint. The caller
// passes any web3.js Connection (e.g. https://api.mainnet-beta.solana.com).

import {
  PublicKey,
  type AccountMeta,
  type Commitment,
  type Connection,
} from "@solana/web3.js";
import {
  createExecuteInstruction,
  getExtraAccountMetaAddress,
  getExtraAccountMetas,
  getMint,
  getTransferHook,
  resolveExtraAccountMeta,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

/** Seed prefix for a mint's ExtraAccountMetaList PDA: ["extra-account-metas", mint]. */
export const EXTRA_ACCOUNT_METAS_SEED = "extra-account-metas";

export interface ResolvedAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
  /** True when the account is derived from seeds rather than a fixed key. */
  derivedFromSeeds?: boolean;
}

export interface ResolvedHook {
  mint: string;
  programId: string;
  extraAccounts: ResolvedAccountMeta[];
}

/** The seeds that derive a mint's ExtraAccountMetaList PDA under the hook program. */
export function extraAccountMetasSeeds(mint: string): [string, string] {
  return [EXTRA_ACCOUNT_METAS_SEED, mint];
}

/** Derive a mint's ExtraAccountMetaList (validation) PDA under a hook program. */
export function getValidationPda(mint: PublicKey, hookProgramId: PublicKey): PublicKey {
  return getExtraAccountMetaAddress(mint, hookProgramId);
}

/**
 * Lower a runtime AccountMeta to its serializable form (base58 pubkey + flags),
 * suitable for JSON responses consumed by the web/service layers.
 */
export function toSerializableAccountMeta(meta: AccountMeta): ResolvedAccountMeta {
  return {
    pubkey: meta.pubkey.toBase58(),
    isSigner: meta.isSigner,
    isWritable: meta.isWritable,
  };
}

/**
 * The lowest privilege a pubkey already holds among the accounts resolved so
 * far cannot be raised by a later extra meta. Mirrors spl-token's de-escalation
 * so a resolved extra can never escalate a base account's signer/writable flags.
 */
function deEscalateAccountMeta(meta: AccountMeta, existing: AccountMeta[]): AccountMeta {
  const highest = existing
    .filter((x) => x.pubkey.equals(meta.pubkey))
    .reduce<{ isSigner: boolean; isWritable: boolean } | undefined>((acc, x) => {
      if (!acc) return { isSigner: x.isSigner, isWritable: x.isWritable };
      return {
        isSigner: acc.isSigner || x.isSigner,
        isWritable: acc.isWritable || x.isWritable,
      };
    }, undefined);
  if (highest) {
    if (!highest.isSigner && meta.isSigner) meta.isSigner = false;
    if (!highest.isWritable && meta.isWritable) meta.isWritable = false;
  }
  return meta;
}

/**
 * Resolve the extra accounts a transfer hook requires for one transfer.
 *
 * Reads the mint's ExtraAccountMetaList PDA, decodes each ExtraAccountMeta, and
 * resolves it against the on-chain Execute account order:
 *   0 source, 1 mint, 2 destination, 3 authority, 4 validation PDA, 5+ extras.
 * Seeding previousMetas in exactly this order lets AccountKey / AccountData /
 * external-PDA seeds reference the same indices the hook program sees, and lets
 * later seeds reference earlier-resolved extras (sequential resolution).
 *
 * Returns only the resolved extra accounts (index 5+). A full transfer also
 * appends the hook program id and the validation PDA -- see resolveHook, or use
 * spl-token's createTransferCheckedWithTransferHookInstruction for the whole ix.
 *
 * Fallback: if the mint has no ExtraAccountMetaList PDA under this hook program,
 * returns [].
 */
export async function resolveExtraAccounts(
  connection: Connection,
  mint: PublicKey,
  hookProgramId: PublicKey,
  fromTokenAccount: PublicKey,
  toTokenAccount: PublicKey,
  authority: PublicKey,
  amount: bigint,
  commitment?: Commitment,
): Promise<AccountMeta[]> {
  const validationPda = getExtraAccountMetaAddress(mint, hookProgramId);
  const validationAccount = await connection.getAccountInfo(validationPda, commitment);
  if (validationAccount === null) return [];

  const metas = getExtraAccountMetas(validationAccount);
  if (metas.length === 0) return [];

  // Reuse spl-token's Execute builder so the base account order and the
  // instruction data (Execute discriminator + amount, LE u64) are byte-for-byte
  // what Token-2022 passes to the hook -- InstructionData seeds index into this.
  const executeIx = createExecuteInstruction(
    hookProgramId,
    fromTokenAccount,
    mint,
    toTokenAccount,
    authority,
    validationPda,
    amount,
  );
  const previousMetas: AccountMeta[] = executeIx.keys;

  const resolved: AccountMeta[] = [];
  for (const meta of metas) {
    const accountMeta = await resolveExtraAccountMeta(
      connection,
      meta,
      previousMetas,
      executeIx.data,
      hookProgramId,
    );
    const deEscalated = deEscalateAccountMeta(accountMeta, previousMetas);
    previousMetas.push(deEscalated);
    resolved.push(deEscalated);
  }
  return resolved;
}

export interface HookTransferContext {
  source: PublicKey;
  destination: PublicKey;
  authority: PublicKey;
  amount: bigint;
}

export interface ResolveHookOptions {
  /** Token program that owns the mint. Defaults to Token-2022. */
  tokenProgramId?: PublicKey;
  commitment?: Commitment;
  /**
   * Optional transfer context. Required only to resolve context-dependent
   * (AccountData / InstructionData) seeds into concrete extra accounts; without
   * it, extraAccounts is [] and the result is pure hook discovery.
   */
  transfer?: HookTransferContext;
}

export interface HookResolution {
  /** Hook program from the mint's TransferHook extension, or null if none. */
  hookProgramId: PublicKey | null;
  /** [b"extra-account-metas", mint] under the hook program; null when no hook. */
  validationPda: PublicKey | null;
  /** Resolved extra accounts (empty unless a transfer context was supplied). */
  extraAccounts: AccountMeta[];
}

/**
 * Discover a mint's transfer hook and, when a transfer context is supplied,
 * resolve its extra accounts. Reads the mint's TransferHook extension for the
 * hook program id; a mint with no hook (or a non-Token-2022 account) yields
 * { hookProgramId: null, validationPda: null, extraAccounts: [] }.
 */
export async function resolveHook(
  connection: Connection,
  mint: PublicKey,
  opts: ResolveHookOptions = {},
): Promise<HookResolution> {
  const tokenProgramId = opts.tokenProgramId ?? TOKEN_2022_PROGRAM_ID;

  let hookProgramId: PublicKey | null = null;
  try {
    const mintInfo = await getMint(connection, mint, opts.commitment, tokenProgramId);
    const hook = getTransferHook(mintInfo);
    // A hook program of all-zeroes is the "unset" sentinel -> treat as no hook.
    if (hook && !hook.programId.equals(PublicKey.default)) {
      hookProgramId = hook.programId;
    }
  } catch {
    // getMint throws for non-mint / non-Token-2022 accounts; that just means the
    // mint carries no transfer hook, which is a valid, expected answer here.
    hookProgramId = null;
  }

  if (hookProgramId === null) {
    return { hookProgramId: null, validationPda: null, extraAccounts: [] };
  }

  const validationPda = getExtraAccountMetaAddress(mint, hookProgramId);
  let extraAccounts: AccountMeta[] = [];
  if (opts.transfer) {
    const t = opts.transfer;
    extraAccounts = await resolveExtraAccounts(
      connection,
      mint,
      hookProgramId,
      t.source,
      t.destination,
      t.authority,
      t.amount,
      opts.commitment,
    );
  }
  return { hookProgramId, validationPda, extraAccounts };
}

export type { AccountMeta } from "@solana/web3.js";
