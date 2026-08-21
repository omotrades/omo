# Architecture

Omo is a single deployable TanStack Start application. There is no separate worker
process, no queue and no daemon: a scheduler calls one HTTP endpoint, that endpoint runs
one decision cycle to completion, and every artefact of that cycle is written to a store
that the public endpoints read back.

```text
                    ┌──────────────────────────────────────────┐
   scheduler ─POST─▶│  /api/public/cycle  (secret gated)       │
                    └───────────────────┬──────────────────────┘
                                        │ runDecisionCycle()
                                        ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ market data  │   │ crowd theses │   │  web search  │   │ wallet state │
   │ (DEX public) │   │ (fomo board) │   │              │   │ (Solana RPC) │
   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
          └──────────────────┴─────────┬────────┴──────────────────┘
                                       ▼
                          think ──▶ gate ──▶ seal ──▶ execute ──▶ journal ──▶ reveal
                                       │        │         │           │          │
                                    rules    memo tx    signed     confirmed   plaintext
                                    (audit)  on chain   locally    signature   published
                                       │        │         │           │          │
                                       └────────┴─────────┴───────────┴──────────┘
                                                          ▼
                                              Postgres (audit, commits, journal)
                                                          ▼
                                        /api/public/proof.json · verify.json · UI
```

## Boundaries

**Server-only modules** end in `.server.ts` and are blocked from the client bundle by
filename. They are the only place that touches secrets, RPC or the database.

**Typed RPC** lives in `*.functions.ts` (`createServerFn`). These are thin wrappers:
module scope holds imports, types and the exported declarations, nothing else. The UI
imports functions modules, never `.server.ts` modules.

**Public HTTP** lives under `src/routes/api/public/*` for callers that are not the app:
schedulers and anyone verifying the record. Those handlers authenticate or authorise
themselves; the prefix does not.

**Environment** is read inside handlers, never at module scope, because injection
happens at call time. Browser-visible config uses `VITE_*` only.

## Design decisions

### One rule set

`evaluateRules` in `src/lib/audit.server.ts` is the only implementation of the entry
criteria. The published audit log and the live execution gate both call it. A second,
looser rule set for real orders would make the audit log decorative, so there isn't one.

### Commit before act, reveal after

A timestamp in omo's own database proves nothing, because omo owns the database. So the
decision is canonically serialised, salted with a nonce, hashed with SHA-256, and only
the hash is published as a Solana memo, signed by a burner key that never holds funds.
The plaintext is opened later. A validator's slot ordering is not omo's to move, which is
the only reason the sequence is checkable at all.

Canonical serialisation is deliberate and stable (sorted keys, `undefined` dropped,
version-prefixed preimage) because a hash over a non-deterministic encoding is not a
commitment. It is covered by unit tests.

### Hand-rolled transaction wire format

The runtime is a serverless Worker, so the official Solana SDK is not usable. Memo and
swap transactions are therefore signed by writing the signature back into the fee-payer
slot of a serialized transaction (`src/lib/solana.server.ts`). The shortvec prefix and
base64 helpers are small, isolated and unit tested.

### Two keys

| variable | job | blast radius |
| --- | --- | --- |
| `OMO_TRADING_KEY` | signs swaps; exported from the wallet app | the book |
| `OMO_COMMIT_KEY` | signs decision-hash memos only | dust for fees |

`tradingSigner()` asserts the key derives the published wallet address and fails loudly
otherwise, so a misconfigured deploy cannot trade from an unpublished account.

### Unarmed by default

Without a trading key the pipeline runs every stage except execution and reports
`unarmed`. Clones, CI and local development therefore exercise the real code path
without touching funds.

### Risk limits are code, not policy

Enforced in `src/lib/execute.server.ts`: mint and side must match the sealed commitment,
the memo must already be confirmed, price impact and slippage floors, one order per
commitment, per-order and rolling 24h notional ceilings, and a SOL reserve that is never
spent so the wallet can always pay fees.

### <a id="no-api-needed"></a>No API needed

FOMO exposes no API and does not need to. It renders a Solana account. So does pump.fun.
Omo holds the key to that account, builds its own swap through Jupiter's public router,
signs locally and submits to mainnet RPC. The chain is the API; the memo is the
timestamp. Nothing in the path depends on a private integration, which is also why the
record stays verifiable if any front end disappears.

## Model routing

`src/lib/models.server.ts` maps loop stages to minds instead of hardcoding one model:

| role | model | stage |
| --- | --- | --- |
| `reasoning` | claude opus 5 | thesis formation, self-audit, verdicts |
| `realtime` | grok | live social read on a single name |
| `narration` | claude opus 5 | the public thought stream |

Each role carries an ordered fallback chain. A gateway that does not serve the declared
model causes the stage to run on the next available one and be marked `degraded`; the id
actually used is attached to the output, so the record never overstates which mind ran.
The realtime role produces evidence, not verdicts: only the reasoning role may conclude.

## Data model


| table | contents |
| --- | --- |
| `omo_audits` | one row per decision: inputs held at that moment, every rule outcome, verdict |
| `omo_commits` | hash, nonce, sealed payload, memo signature, reveal time, linked fill |
| `omo_trades` | confirmed fills only: signature, mint, side, amounts, usd value |
| thought/state tables | agent narration and loop state for the UI |

History is pruned on a schedule so the public payloads stay small and the page stays
fast; the chain remains the durable record.

## Failure posture

- No RPC, DEX or model call blocks a cycle indefinitely; each stage degrades to a
  recorded refusal rather than a hang.
- A refusal is a first-class outcome and is published exactly like a fill. Hundreds of
  recorded nos are the boring half of the proof.
- Publishing a memo is decoupled from the tick, so slow RPC delays a commitment rather
  than stalling the loop.
