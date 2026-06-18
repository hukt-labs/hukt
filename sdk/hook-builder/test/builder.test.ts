import { describe, expect, it } from "vitest";
import {
  buildSpec,
  composeHookProgram,
  previewExtraAccounts,
  simulateHook,
  type HookPreset,
  type TransferScenario,
} from "../src/index";

const preset = (kind: HookPreset["kind"], params: HookPreset["params"] = {}): HookPreset => ({ kind, params });

describe("composeHookProgram", () => {
  it("assigns Execute account indices and maps base + extra accounts", () => {
    const spec = composeHookProgram([preset("whitelist")]);
    expect(spec.extraAccounts.map((a) => a.label)).toEqual(["whitelist"]);
    expect(spec.extraAccounts[0]!.index).toBe(5); // first extra sits after the 5 base accounts
    expect(spec.accountIndexMap).toMatchObject({ source: 0, mint: 1, destination: 2, authority: 3, validation: 4, whitelist: 5 });
    expect(spec.totalAccounts).toBe(6);
    expect(spec.withinTransactionLimit).toBe(true);
  });

  it("de-duplicates a Clock shared by vesting and antibot", () => {
    const spec = composeHookProgram([preset("vesting"), preset("antibot")]);
    const labels = spec.extraAccounts.map((a) => a.label);
    expect(labels).toEqual(["vesting", "clock", "cooldown"]); // one clock, not two
    expect(labels.filter((l) => l === "clock")).toHaveLength(1);
    // antibot's cooldown PDA is writable; the shared clock stays read-only.
    expect(spec.extraAccounts.find((a) => a.label === "cooldown")!.isWritable).toBe(true);
    expect(spec.extraAccounts.find((a) => a.label === "clock")!.isWritable).toBe(false);
    expect(spec.accountIndexMap).toMatchObject({ vesting: 5, clock: 6, cooldown: 7 });
  });

  it("resolves an external-PDA program reference to the gatekeeper's account index", () => {
    const spec = composeHookProgram([preset("kycgate")]);
    const attestation = spec.extraAccounts.find((a) => a.label === "kyc-attestation")!;
    expect(attestation.address).toEqual({ type: "pda", owner: "account", programIndex: 5 });
    expect(spec.accountIndexMap["kyc-gatekeeper"]).toBe(5);
  });

  it("carries seed descriptors for PDA extra accounts", () => {
    const spec = composeHookProgram([preset("whitelist")]);
    expect(spec.extraAccounts[0]!.seeds).toEqual([
      { type: "literal", bytes: "whitelist" },
      { type: "account-data", accountIndex: 2, offset: 32, length: 32 },
    ]);
  });

  it("soulbound requires no extra accounts by default, one with an exception list", () => {
    expect(composeHookProgram([preset("soulbound")]).extraAccounts).toHaveLength(0);
    const withExceptions = composeHookProgram([preset("soulbound", { exceptions: true })]);
    expect(withExceptions.extraAccounts.map((a) => a.label)).toEqual(["soulbound-config"]);
  });

  it("preserves buildSpec conflict detection for incompatible presets", () => {
    const spec = composeHookProgram([preset("whitelist"), preset("blacklist")]);
    expect(spec.conflicts).toEqual([["whitelist", "blacklist"]]);
    // buildSpec itself is unchanged and still exported.
    expect(buildSpec([preset("soulbound"), preset("royalty")]).conflicts).toEqual([["soulbound", "royalty"]]);
  });
});

describe("previewExtraAccounts", () => {
  it("returns the ordered, serializable descriptors without aliasing the spec", () => {
    const spec = composeHookProgram([preset("kycgate"), preset("vesting")]);
    const preview = previewExtraAccounts(spec);
    expect(preview.map((a) => a.index)).toEqual([5, 6, 7, 8]);
    // Serializable end to end.
    expect(() => JSON.stringify(preview)).not.toThrow();
    // A returned copy, not the internal arrays.
    expect(preview[0]!.seeds).not.toBe(spec.extraAccounts[0]!.seeds);
  });
});

describe("simulateHook", () => {
  const spec = composeHookProgram([preset("blacklist"), preset("vesting")]);
  const scenarios: TransferScenario[] = [
    { name: "plain wallet transfer", kind: "wallet-to-wallet" },
    { name: "blacklisted sender", kind: "wallet-to-wallet", conditions: { senderBlacklisted: true } },
    { name: "before unlock", kind: "dex-swap", conditions: { vestingUnlocked: false } },
  ];

  it("passes an unconditional transfer and reports required accounts", () => {
    const result = simulateHook(spec, scenarios);
    const plain = result.scenarios[0]!;
    expect(plain.willPass).toBe(true);
    expect(plain.revertReasons).toEqual([]);
    expect(plain.requiredAccounts).toEqual(["blacklist", "vesting", "clock"]);
  });

  it("reverts a blacklisted sender with a reason", () => {
    const result = simulateHook(spec, scenarios);
    const blacklisted = result.scenarios[1]!;
    expect(blacklisted.willPass).toBe(false);
    expect(blacklisted.revertReasons).toContain("blacklist: sender is blacklisted");
  });

  it("reverts a pre-unlock vesting transfer", () => {
    const result = simulateHook(spec, scenarios);
    const locked = result.scenarios[2]!;
    expect(locked.willPass).toBe(false);
    expect(locked.revertReasons.some((r) => r.startsWith("vesting:"))).toBe(true);
  });

  it("gates a DEX swap on the royalty route and is exempt-aware for soulbound", () => {
    const royaltySpec = composeHookProgram([preset("royalty")]);
    const swap = simulateHook(royaltySpec, [
      { name: "unpaid swap", kind: "dex-swap", conditions: { royaltyPaid: false } },
      { name: "paid swap", kind: "dex-swap", conditions: { royaltyPaid: true } },
    ]);
    expect(swap.scenarios[0]!.willPass).toBe(false);
    expect(swap.scenarios[1]!.willPass).toBe(true);

    const soulboundSpec = composeHookProgram([preset("soulbound")]);
    const sb = simulateHook(soulboundSpec, [
      { name: "default", kind: "wallet-to-wallet" },
      { name: "exempt", kind: "wallet-to-wallet", conditions: { soulboundExempt: true } },
    ]);
    expect(sb.scenarios[0]!.willPass).toBe(false);
    expect(sb.scenarios[1]!.willPass).toBe(true);
  });

  it("is deterministic and surfaces spec conflicts", () => {
    const a = simulateHook(spec, scenarios);
    const b = simulateHook(spec, scenarios);
    expect(a).toEqual(b);
    expect(a.hasConflicts).toBe(false);

    const conflicting = composeHookProgram([preset("whitelist"), preset("blacklist")]);
    expect(simulateHook(conflicting, scenarios).hasConflicts).toBe(true);
  });
});
