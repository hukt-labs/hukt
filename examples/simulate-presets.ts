// Worked example: compose several verified presets into one Token-2022
// transfer-hook spec, preview the extra accounts every transfer must carry, and
// simulate whether concrete transfer scenarios pass -- all without touching a
// chain. This mirrors what the no-code Builder does before a mint is deployed.
//
// Run from the repo root (after `cd sdk && npm install`):
//   npx tsx examples/simulate-presets.ts

import {
  composeHookProgram,
  previewExtraAccounts,
  simulateHook,
  type HookPreset,
  type TransferScenario,
} from "../sdk/hook-builder/src/index";

// A mint that enforces four policies at once. These presets are mutually
// compatible: whitelist gates the recipient, vesting locks early transfers,
// antibot rate-limits, and kycgate requires an attestation on the recipient.
const presets: HookPreset[] = [
  { kind: "whitelist", params: {} },
  { kind: "vesting", params: {} },
  { kind: "antibot", params: { cooldownSecs: 30, perWalletLimit: 1_000_000 } },
  { kind: "kycgate", params: {} },
];

const spec = composeHookProgram(presets);

console.log(`composed hook: ${spec.presets.map((p) => p.kind).join(", ")}`);
console.log(
  `${spec.totalAccounts} accounts per transfer (5 base + ${spec.extraAccounts.length} extra), within tx limit: ${spec.withinTransactionLimit}`,
);
if (spec.conflicts.length > 0) {
  console.log(`conflicts: ${spec.conflicts.map(([a, b]) => `${a}/${b}`).join(", ")}`);
}
console.log("extra accounts the resolver must attach (index 5+):");
for (const account of previewExtraAccounts(spec)) {
  const access = account.isWritable ? "writable" : "readonly";
  console.log(`  [${account.index}] ${account.label} (${account.preset}, ${access})`);
}

// Each scenario overrides only the conditions it cares about; everything else
// defaults to a compliant transfer, so a scenario reverts iff an override trips
// one of the active presets.
const scenarios: TransferScenario[] = [
  { name: "compliant wallet transfer", kind: "wallet-to-wallet" },
  {
    name: "recipient without a KYC attestation",
    kind: "cex-deposit",
    conditions: { recipientKyced: false },
  },
  {
    name: "still-vesting sender inside the cooldown window",
    kind: "dex-swap",
    conditions: { vestingUnlocked: false, cooldownElapsed: false },
  },
];

const result = simulateHook(spec, scenarios);
for (const outcome of result.scenarios) {
  const verdict = outcome.willPass ? "PASS" : "REVERT";
  console.log(`\n${outcome.name} [${outcome.kind}] -> ${verdict}`);
  for (const reason of outcome.revertReasons) {
    console.log(`  reverted by ${reason}`);
  }
}
