#!/usr/bin/env node
"use strict";

const VERSION = "0.1.0";

const COMMANDS = [
  ["hook add <preset>", "Add a verified preset to the current hook spec"],
  ["deploy", "Deploy the composed transfer-hook program"],
  ["inspect <mint>", "Inspect the transfer hook attached to a mint"],
  ["attest <mint>", "Run the safety attestation scan on a mint's hook"],
  ["resolve <mint>", "Print the extra accounts a transfer of <mint> needs"],
];

function printHelp() {
  console.log(`hukt-cli ${VERSION}`);
  console.log("Solana Token-2022 transfer hooks from the command line.\n");
  console.log("Usage: hukt <command> [options]\n");
  console.log("Commands:");
  for (const [name, desc] of COMMANDS) {
    console.log(`  ${name.padEnd(22)} ${desc}`);
  }
}

const arg = process.argv[2];

if (!arg || arg === "help" || arg === "--help" || arg === "-h") {
  printHelp();
  process.exit(0);
}

if (arg === "version" || arg === "--version" || arg === "-v") {
  console.log(VERSION);
  process.exit(0);
}

console.error(`hukt: unrecognized command '${arg}'\n`);
printHelp();
process.exit(1);
