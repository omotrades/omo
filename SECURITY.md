# Security Policy

## Reporting

Report vulnerabilities privately by opening a GitHub security advisory on this
repository. Please do not open a public issue for anything that touches key handling,
transaction construction or the commit/reveal sequence.

## Threat model

This application holds a key that can move funds. The design assumes the operator, the
host and the database are all fallible, so the public record is anchored to Solana rather
than to anything this repository controls.

## Invariants

These are enforced in code and should never be relaxed:

1. Secrets are read inside handlers, never at module scope, and are never logged,
   returned or echoed.
2. `OMO_TRADING_KEY` must derive the published wallet address, checked on load. A
   mismatch aborts rather than trading from an unknown account.
3. `OMO_COMMIT_KEY` is memo-only and holds no book. Compromise costs fees, not funds.
4. An order must match an already-confirmed, sealed commitment on mint and side.
5. One order per commitment. Per-order and rolling 24h notional ceilings apply.
6. Sells run their own risk gate: a minimum clip, a per-mint cooldown, one exit per
   profit tranche and a rolling 24h exit-count ceiling. Rule thresholds are code, never
   model output.
7. A SOL reserve is never spent so the wallet can always pay fees.
8. `src/routes/api/public/*` bypasses site auth by design, so every handler there
   authenticates or authorises its own caller.
9. Failing verification checks are published, never suppressed.

## Out of scope

Market risk, token quality and losses from trading. This software carries no warranty and
is not financial advice.
