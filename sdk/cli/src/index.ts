// hukt-cli command surface. bin/hukt.js is the runnable entrypoint; this module
// documents the commands for the docs site and the future TypeScript build.

export interface CliCommand {
  name: string;
  usage: string;
  summary: string;
}

export const CLI_VERSION = "0.1.0";

export const COMMANDS: CliCommand[] = [
  {
    name: "hook",
    usage: "hukt hook add <preset> [--bps 500]",
    summary: "Add a verified preset to the hook spec.",
  },
  {
    name: "deploy",
    usage: "hukt deploy",
    summary: "Deploy the composed transfer-hook program.",
  },
  {
    name: "inspect",
    usage: "hukt inspect <mint>",
    summary: "Inspect the transfer hook attached to a mint.",
  },
  {
    name: "attest",
    usage: "hukt attest <mint>",
    summary: "Run the safety attestation scan on a mint's hook.",
  },
  {
    name: "resolve",
    usage: "hukt resolve <mint>",
    summary: "Print the extra accounts a transfer needs.",
  },
];
