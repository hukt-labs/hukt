// @hukt/resolver -- one-line integration for Token-2022 transfer-hook tokens.
// hukt.resolve(mint) returns the extra accounts a transfer needs, so wallets,
// DEXs, and lending protocols can build a valid transfer instruction.

export const SDK_VERSION = "0.1.0";

export interface ResolvedAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface ResolveResult {
  mint: string;
  programId: string;
  extraAccounts: ResolvedAccount[];
}

export interface ResolverConfig {
  /** Public RPC endpoint (no API key -- keyed RPC stays server-side). */
  rpcUrl: string;
  /** HUKT indexer base URL for cached hook metadata. */
  apiUrl?: string;
}

/** The contract implemented by the network-backed resolver. */
export interface Resolver {
  resolve(mint: string): Promise<ResolveResult>;
}

/** Indexer endpoint that returns cached transfer-hook metadata for a mint. */
export function hookEndpoint(config: ResolverConfig, mint: string): string {
  const base = (config.apiUrl ?? "https://hukt.fun/api").replace(/\/+$/, "");
  return `${base}/hooks/${mint}`;
}
