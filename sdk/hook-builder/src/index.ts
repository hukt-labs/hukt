// @hukt/hook-builder -- compose verified presets into a single transfer-hook
// deployment spec (the logic behind the no-code Builder), plus a chain-free
// simulator and an extra-account preview. Extra accounts are described by seeds
// (per hook-spec section 8) because their real pubkeys need a mint at deploy.

export type PresetKind =
  | "royalty"
  | "whitelist"
  | "blacklist"
  | "vesting"
  | "antibot"
  | "kycgate"
  | "fee-on-transfer"
  | "soulbound";

export interface PresetConfig {
  kind: PresetKind;
  params: Record<string, string | number | boolean>;
}

/** Alias used by the Builder-facing API. */
export type HookPreset = PresetConfig;

export interface HookBuildSpec {
  presets: PresetConfig[];
  /** Pairs of chosen presets that cannot coexist on one mint. */
  conflicts: Array<[PresetKind, PresetKind]>;
}

const INCOMPATIBLE: ReadonlyArray<readonly [PresetKind, PresetKind]> = [
  ["soulbound", "royalty"],
  ["soulbound", "fee-on-transfer"],
  ["whitelist", "blacklist"],
];

/** Build a deployment spec from chosen presets, flagging incompatible pairs. */
export function buildSpec(presets: PresetConfig[]): HookBuildSpec {
  const chosen = new Set(presets.map((p) => p.kind));
  const conflicts = INCOMPATIBLE.filter(
    ([a, b]) => chosen.has(a) && chosen.has(b),
  ).map(([a, b]) => [a, b] as [PresetKind, PresetKind]);
  return { presets, conflicts };
}

// --- ExtraAccountMeta description model (serializable) -----------------------

/** A single seed used to derive a PDA extra account, mirroring the on-chain Seed enum. */
export type ExtraAccountSeed =
  | { type: "literal"; bytes: string } // utf8 literal, e.g. "whitelist"
  | { type: "account-key"; accountIndex: number } // pubkey of the account at index (1 = mint)
  | { type: "account-data"; accountIndex: number; offset: number; length: number } // slice of that account's data
  | { type: "instruction-data"; offset: number; length: number }; // slice of the Execute data (amount at offset 8)

/** How an extra account's address is obtained. */
export type ExtraAccountAddress =
  | { type: "pda"; owner: "hook" } // PDA of the hook program itself
  | { type: "pda"; owner: "account"; programIndex: number } // external PDA; program at this account index
  | { type: "sysvar"; name: "clock" }
  | { type: "provided"; role: string }; // a fixed pubkey supplied at deploy time

export interface AccountMetaDescriptor {
  /** Position in the Execute account list (5 = first extra account). */
  index: number;
  label: string;
  preset: PresetKind;
  isSigner: boolean;
  isWritable: boolean;
  address: ExtraAccountAddress;
  /** Seeds, present when address.type === "pda". */
  seeds: ExtraAccountSeed[];
  description: string;
}

export interface HookSpec extends HookBuildSpec {
  /** Ordered extra accounts the composed hook requires (index 5+). */
  extraAccounts: AccountMetaDescriptor[];
  /** Label -> account index in the Execute list, including the base accounts. */
  accountIndexMap: Record<string, number>;
  /** 5 base accounts (source, mint, destination, authority, validation) + extras. */
  totalAccounts: number;
  /** False if totalAccounts risks the ~64 account transaction limit (hook-spec 4.5). */
  withinTransactionLimit: boolean;
}

/** Solana locks at most 64 accounts per transaction without address lookup tables. */
const TRANSACTION_ACCOUNT_LIMIT = 64;
const BASE_ACCOUNT_COUNT = 5; // source, mint, destination, authority, validation

// --- per-preset extra-account requirements (hook-spec section 8) -------------

type PreIndexAddress =
  | { type: "pda"; owner: "hook" }
  | { type: "pda"; owner: "account"; programLabel: string } // resolved to a programIndex at compose time
  | { type: "sysvar"; name: "clock" }
  | { type: "provided"; role: string };

interface PresetAccountRequirement {
  label: string;
  preset: PresetKind;
  isSigner: boolean;
  isWritable: boolean;
  address: PreIndexAddress;
  seeds: ExtraAccountSeed[];
  description: string;
}

const literalSeed = (s: string): ExtraAccountSeed => ({ type: "literal", bytes: s });
const MINT_KEY_SEED: ExtraAccountSeed = { type: "account-key", accountIndex: 1 };
const SOURCE_OWNER_SEED: ExtraAccountSeed = { type: "account-data", accountIndex: 0, offset: 32, length: 32 };
const DEST_OWNER_SEED: ExtraAccountSeed = { type: "account-data", accountIndex: 2, offset: 32, length: 32 };

function requirementsFor(kind: PresetKind, params: PresetConfig["params"]): PresetAccountRequirement[] {
  switch (kind) {
    case "royalty":
      return [
        {
          label: "royalty-config",
          preset: kind,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "hook" },
          seeds: [literalSeed("royalty"), MINT_KEY_SEED],
          description: "Royalty policy config PDA (approved routes / receipt rules).",
        },
        {
          label: "creator-token-account",
          preset: kind,
          isSigner: false,
          isWritable: false,
          address: { type: "provided", role: "creator-token-account" },
          seeds: [],
          description: "Creator token account that must receive royalty. The hook verifies, it does not move funds.",
        },
      ];
    case "whitelist":
      return [
        {
          label: "whitelist",
          preset: kind,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "hook" },
          seeds: [literalSeed("whitelist"), DEST_OWNER_SEED],
          description: "Per-recipient whitelist PDA keyed on the destination owner.",
        },
      ];
    case "blacklist":
      return [
        {
          label: "blacklist",
          preset: kind,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "hook" },
          seeds: [literalSeed("blacklist"), SOURCE_OWNER_SEED],
          description: "Per-sender blacklist PDA keyed on the source owner.",
        },
      ];
    case "vesting":
      return [
        {
          label: "vesting",
          preset: kind,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "hook" },
          seeds: [literalSeed("vesting"), MINT_KEY_SEED, SOURCE_OWNER_SEED],
          description: "Vesting state PDA (mint + source owner); checked against the unlock schedule.",
        },
        clockRequirement(kind, "Clock sysvar for unlock-time checks."),
      ];
    case "antibot":
      return [
        {
          label: "cooldown",
          preset: kind,
          isSigner: false,
          isWritable: true, // the hook updates its own cooldown state PDA
          address: { type: "pda", owner: "hook" },
          seeds: [literalSeed("cooldown"), MINT_KEY_SEED, SOURCE_OWNER_SEED],
          description: "Per-sender cooldown/limit state PDA; updated on each transfer.",
        },
        clockRequirement(kind, "Clock sysvar for cooldown checks."),
      ];
    case "kycgate":
      return [
        {
          label: "kyc-gatekeeper",
          preset: kind,
          isSigner: false,
          isWritable: false,
          address: { type: "provided", role: "kyc-gatekeeper-program" },
          seeds: [],
          description: "External gatekeeper program that owns KYC attestations.",
        },
        {
          label: "kyc-attestation",
          preset: kind,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "account", programLabel: "kyc-gatekeeper" },
          seeds: [literalSeed("kyc"), DEST_OWNER_SEED],
          description: "KYC attestation PDA for the recipient, owned by the gatekeeper program.",
        },
      ];
    case "fee-on-transfer":
      return [
        {
          label: "fee-config",
          preset: kind,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "hook" },
          seeds: [literalSeed("fee-config"), MINT_KEY_SEED],
          description: "Fee policy config PDA. Native Token-2022 TransferFee moves the funds.",
        },
        {
          label: "fee-vault",
          preset: kind,
          isSigner: false,
          isWritable: true,
          address: { type: "pda", owner: "hook" },
          seeds: [literalSeed("fee-vault"), MINT_KEY_SEED],
          description: "Fee vault PDA for custom fee-policy accounting.",
        },
      ];
    case "soulbound":
      // Pure soulbound needs no extra accounts; a config PDA is added only when
      // the deployer opts into a conditional exception list.
      if (params["exceptions"] === true) {
        return [
          {
            label: "soulbound-config",
            preset: kind,
            isSigner: false,
            isWritable: false,
            address: { type: "pda", owner: "hook" },
            seeds: [literalSeed("soulbound"), MINT_KEY_SEED],
            description: "Soulbound exception config PDA (allowed transfer routes).",
          },
        ];
      }
      return [];
    default: {
      const unreachable: never = kind;
      throw new Error(`unknown preset ${String(unreachable)}`);
    }
  }
}

function clockRequirement(preset: PresetKind, description: string): PresetAccountRequirement {
  return {
    label: "clock",
    preset,
    isSigner: false,
    isWritable: false,
    address: { type: "sysvar", name: "clock" },
    seeds: [],
    description,
  };
}

// --- compose ----------------------------------------------------------------

/** Structural key for de-duplicating accounts that resolve to the same address. */
function dedupeKey(req: PresetAccountRequirement): string {
  return JSON.stringify({ address: req.address, seeds: req.seeds, isSigner: req.isSigner });
}

/**
 * Merge presets into a single deployment spec: concatenate each preset's extra
 * account requirements (hook-spec section 8), de-duplicate accounts that resolve
 * to the same address (e.g. a Clock shared by vesting and antibot), assign the
 * on-chain account indices, and resolve external-PDA program references.
 */
export function composeHookProgram(presets: HookPreset[]): HookSpec {
  const base = buildSpec(presets);

  const requirements: PresetAccountRequirement[] = [];
  for (const preset of presets) {
    requirements.push(...requirementsFor(preset.kind, preset.params));
  }

  // De-duplicate structurally identical accounts, escalating to writable if any
  // contributor needs write access. Order of first appearance is preserved.
  const byKey = new Map<string, PresetAccountRequirement>();
  const order: string[] = [];
  for (const req of requirements) {
    const key = dedupeKey(req);
    const existing = byKey.get(key);
    if (existing) {
      if (req.isWritable) existing.isWritable = true;
    } else {
      byKey.set(key, { ...req, seeds: [...req.seeds] });
      order.push(key);
    }
  }
  const deduped = order.map((key) => byKey.get(key) as PresetAccountRequirement);

  const accountIndexMap: Record<string, number> = {
    source: 0,
    mint: 1,
    destination: 2,
    authority: 3,
    validation: 4,
  };
  const labelIndex = new Map<string, number>();
  deduped.forEach((req, i) => {
    const index = BASE_ACCOUNT_COUNT + i;
    labelIndex.set(req.label, index);
    accountIndexMap[req.label] = index;
  });

  const extraAccounts: AccountMetaDescriptor[] = deduped.map((req, i) => ({
    index: BASE_ACCOUNT_COUNT + i,
    label: req.label,
    preset: req.preset,
    isSigner: req.isSigner,
    isWritable: req.isWritable,
    address: resolveAddress(req.address, labelIndex, accountIndexMap),
    seeds: req.seeds,
    description: req.description,
  }));

  const totalAccounts = BASE_ACCOUNT_COUNT + extraAccounts.length;
  return {
    ...base,
    extraAccounts,
    accountIndexMap,
    totalAccounts,
    withinTransactionLimit: totalAccounts <= TRANSACTION_ACCOUNT_LIMIT,
  };
}

function resolveAddress(
  address: PreIndexAddress,
  labelIndex: Map<string, number>,
  accountIndexMap: Record<string, number>,
): ExtraAccountAddress {
  if (address.type === "pda" && address.owner === "account") {
    const programIndex = labelIndex.get(address.programLabel) ?? accountIndexMap[address.programLabel];
    if (programIndex === undefined) {
      throw new Error(`external PDA references unknown account "${address.programLabel}"`);
    }
    return { type: "pda", owner: "account", programIndex };
  }
  return address;
}

/**
 * The ordered extra-account descriptors the spec requires. Serializable: seeds
 * are described symbolically because real pubkeys need a mint at deploy time.
 */
export function previewExtraAccounts(spec: HookSpec): AccountMetaDescriptor[] {
  return spec.extraAccounts.map((a) => ({ ...a, seeds: [...a.seeds] }));
}

// --- simulate ---------------------------------------------------------------

export interface ScenarioConditions {
  senderBlacklisted: boolean;
  recipientWhitelisted: boolean;
  recipientKyced: boolean;
  vestingUnlocked: boolean;
  cooldownElapsed: boolean;
  withinPerWalletLimit: boolean;
  /** Transfer flows through an approved royalty-paying route (marketplace/escrow). */
  royaltyPaid: boolean;
  feePolicySatisfied: boolean;
  /** Sender/recipient is on the soulbound exception list. */
  soulboundExempt: boolean;
  amount: bigint;
}

export interface TransferScenario {
  name: string;
  kind: "wallet-to-wallet" | "dex-swap" | "cex-deposit" | "contract";
  conditions?: Partial<ScenarioConditions>;
}

export interface PresetOutcome {
  preset: PresetKind;
  pass: boolean;
  reason: string;
}

export interface ScenarioOutcome {
  name: string;
  kind: TransferScenario["kind"];
  willPass: boolean;
  revertReasons: string[];
  /** Labels of the extra accounts the transfer must attach. */
  requiredAccounts: string[];
  perPreset: PresetOutcome[];
}

export interface SimulationResult {
  spec: { presetKinds: PresetKind[]; totalAccounts: number; extraAccountCount: number };
  scenarios: ScenarioOutcome[];
  hasConflicts: boolean;
}

const DEFAULT_CONDITIONS: ScenarioConditions = {
  senderBlacklisted: false,
  recipientWhitelisted: true,
  recipientKyced: true,
  vestingUnlocked: true,
  cooldownElapsed: true,
  withinPerWalletLimit: true,
  royaltyPaid: true,
  feePolicySatisfied: true,
  soulboundExempt: false,
  amount: 1n,
};

function evaluatePreset(kind: PresetKind, c: ScenarioConditions): PresetOutcome {
  switch (kind) {
    case "royalty":
      return c.royaltyPaid
        ? { preset: kind, pass: true, reason: "on an approved royalty-paying route" }
        : { preset: kind, pass: false, reason: "not on an approved royalty-paying route" };
    case "whitelist":
      return c.recipientWhitelisted
        ? { preset: kind, pass: true, reason: "recipient is whitelisted" }
        : { preset: kind, pass: false, reason: "recipient is not on the whitelist" };
    case "blacklist":
      return c.senderBlacklisted
        ? { preset: kind, pass: false, reason: "sender is blacklisted" }
        : { preset: kind, pass: true, reason: "sender is not blacklisted" };
    case "vesting":
      return c.vestingUnlocked
        ? { preset: kind, pass: true, reason: "tokens are unlocked" }
        : { preset: kind, pass: false, reason: "tokens are still locked (before unlock time)" };
    case "antibot":
      if (!c.cooldownElapsed) return { preset: kind, pass: false, reason: "cooldown has not elapsed" };
      if (!c.withinPerWalletLimit) return { preset: kind, pass: false, reason: "amount exceeds the per-wallet limit" };
      return { preset: kind, pass: true, reason: "cooldown elapsed and within per-wallet limit" };
    case "kycgate":
      return c.recipientKyced
        ? { preset: kind, pass: true, reason: "recipient holds a valid KYC attestation" }
        : { preset: kind, pass: false, reason: "recipient has no valid KYC attestation" };
    case "fee-on-transfer":
      return c.feePolicySatisfied
        ? { preset: kind, pass: true, reason: "fee policy satisfied" }
        : { preset: kind, pass: false, reason: "required transfer fee not satisfied" };
    case "soulbound":
      return c.soulboundExempt
        ? { preset: kind, pass: true, reason: "on the soulbound exception list" }
        : { preset: kind, pass: false, reason: "token is soulbound and non-transferable" };
    default: {
      const unreachable: never = kind;
      return { preset: unreachable, pass: false, reason: "unknown preset" };
    }
  }
}

/**
 * Deterministically predict, for each scenario, whether the composed hook lets
 * the transfer through and which extra accounts it must carry. No chain access:
 * the outcome is a pure function of the declared scenario conditions.
 */
export function simulateHook(spec: HookSpec, scenarios: TransferScenario[]): SimulationResult {
  const presetKinds = spec.presets.map((p) => p.kind);
  const requiredAccounts = spec.extraAccounts.map((a) => a.label);

  const scenarioOutcomes: ScenarioOutcome[] = scenarios.map((scenario) => {
    const conditions: ScenarioConditions = { ...DEFAULT_CONDITIONS, ...scenario.conditions };
    const perPreset = presetKinds.map((kind) => evaluatePreset(kind, conditions));
    const revertReasons = perPreset.filter((o) => !o.pass).map((o) => `${o.preset}: ${o.reason}`);
    return {
      name: scenario.name,
      kind: scenario.kind,
      willPass: revertReasons.length === 0,
      revertReasons,
      requiredAccounts,
      perPreset,
    };
  });

  return {
    spec: {
      presetKinds,
      totalAccounts: spec.totalAccounts,
      extraAccountCount: spec.extraAccounts.length,
    },
    scenarios: scenarioOutcomes,
    hasConflicts: spec.conflicts.length > 0,
  };
}
