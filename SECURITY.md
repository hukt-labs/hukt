# Security Policy

HUKT programs sit in the path of every transfer of an adopting mint, so we take
reports about the hook and registry programs seriously.

## Supported

The `main` branch is the only supported line while the project is pre-1.0. The
`hukt_hooks` program runs on devnet as a reference deployment; treat mainnet use
as not-yet-supported until a release is tagged.

## Reporting a vulnerability

Please report privately rather than opening a public issue:

- Open a private vulnerability report through GitHub's
  ["Report a vulnerability"](https://github.com/hukt-labs/hukt/security/advisories/new)
  flow on this repository, or
- Reach out over [@huktfun](https://x.com/huktfun) and we will open a private
  advisory to continue.

When you report, describe the impact and the account/instruction path involved
rather than posting a working exploit. Useful details include the affected
program (`hukt_hooks` or `hukt_registry`), the instruction, the account layout,
and whether a live transfer or a direct Execute call triggers the issue.

## Scope

In scope:

- Soundness of the transfer-hook validation in `anchor/programs/hukt_hooks`
  (preset checks, the `assert_transferring` gate, the `ExtraAccountMetaList`
  layout matching the accounts the handler reads).
- Bond accounting, slashing, and authority checks in
  `anchor/programs/hukt_registry`.
- The offchain resolver reconstructing an incorrect or unsafe account set.

Out of scope:

- A hook reverting a transfer by design. A transfer hook is verification-only;
  it can revert but cannot move, mint, or burn tokens. See
  [`docs/security.md`](./docs/security.md) for the threat model and the
  invariants each preset relies on.

## Disclosure

We aim to acknowledge a report within a few days and to coordinate a fix and a
disclosure timeline with the reporter before any public writeup.
