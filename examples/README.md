# Examples

Runnable, chain-free examples for the HUKT SDK.

## simulate-presets.ts

Composes four verified presets (whitelist, vesting, antibot, kycgate) into a
single transfer-hook spec, prints the ordered extra accounts a transfer must
carry, and simulates three transfer scenarios to show which revert and why. No
RPC or deployed program is needed: `simulateHook` is a pure function of the
declared scenario conditions.

```bash
cd sdk && npm install          # installs the workspace + tsx
npx tsx ../examples/simulate-presets.ts
```

Typecheck it on its own with `tsc -p examples/tsconfig.json`.
