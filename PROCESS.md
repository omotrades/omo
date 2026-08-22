# how omo actually works

This is the honest, end to end description of the machine, mapped to the files
that implement it. Nothing here is aspirational prose: every step below points at
the module that does it, and the whole sequence is joined in one place
(`src/lib/pipeline.server.ts`) so the order of operations can be read rather than
inferred.

The short version: **fomo has no api and does not need one.** FOMO is a read
layer over a Solana wallet. The write layer is the chain. Omo holds the key to the
same wallet FOMO displays, so it composes and signs its own swaps against public
programs and sends them to mainnet RPC. FOMO and pump.fun then show the position
because both of them read that wallet.

Wallet: `HxwmEH84o3EuezCUZuBEEeKT6uMDv8R4VRi76ExB87St`

---

## 1. read

`src/lib/market.server.ts`, `src/lib/fomo.server.ts`, `src/lib/web-research.server.ts`

- Solana memecoins are screened from public DEX data (liquidity, 1h volume, buys
  vs sells, age, socials).
- The FOMO board is read for the written theses holders attached to a token, plus
  their position size and P&L.
- The open web is searched for what is actually driving the attention.

## 2. think

`src/lib/omo-brain.server.ts`, `src/lib/models.server.ts`, `src/lib/ai-gateway.server.ts`

omo is not one model. Each stage of the loop declares the mind it was written
for, and `src/lib/models.server.ts` routes the call:

| role | model | why |
| --- | --- | --- |
| `reasoning` | claude opus 5 | thesis formation and the pre-trade think. long context over the whole book, strict adherence to the constraints (no invented fills, no repeats), low appetite for hype. |
| `realtime` | grok | the live social read. memecoin attention forms on the timeline before it shows on the tape, so this stage uses the model closest to it. |
| `narration` | claude opus 5 | the public thought stream, on the same mind that decided, so the words match the reasoning instead of narrating over it. |

The realtime read is evidence only. It describes who is talking and whether the
interest is organic or already peaked; it never returns a verdict. The reasoning
role takes that read together with the tape, the FOMO theses and the web
material, and writes the thesis: why the attention exists, what would make the
thesis wrong, buy or pass. The thesis is written **before** any order exists, and
it is stored with a server timestamp the moment it is written.

If the configured gateway does not serve a declared model, the router falls back
down an ordered chain and marks the stage degraded rather than claiming a model
it could not reach. The model actually used is recorded next to the output.


## 3. gate

`src/lib/audit.server.ts` (`evaluateRules`)

One rule set, used by both the audit log the site publishes and the live
execution path. There is no second, looser set of rules for real orders:

| rule | meaning |
| --- | --- |
| `liquidity_floor` | pool deep enough to exit the size |
| `volume_alive` | 1h volume still real, not a dead tape |
| `buy_pressure` | buys leading sells on the hour |
| `not_newborn_fade` | not a fresh launch already bleeding |
| `public_presence` | named socials or a site behind the ticker |
| `crowd_heat` | FOMO reading inside the range omo acts in |
| `cash_available` | cash on hand for the ticket |
| `already_held` | no size already on in this name |
| `not_on_break` | loop awake, not on a break |

Any failed rule is a refusal. Refusals are recorded and published exactly like
fills, which is the boring half of the proof: nobody fakes hundreds of nos.

## 4. seal (pre-commit)

`src/lib/precommit.server.ts`

The passing decision (name, mint, side, every rule, the numbers behind them) plus
a random nonce is canonically serialised and hashed with SHA-256. Only the hash
is published, as a Solana memo instruction, signed by a **separate burner key**
that can only write memos and never holds the book.

A timestamp in omo's own database proves nothing, because omo owns the database.
A validator's timestamp is not omo's to move.

The memo transaction is built and signed by hand (`src/lib/solana.server.ts`)
because the official SDK does not run in this runtime.

## 5. execute

`src/lib/execute.server.ts`

1. A route for the mint named in the already-sealed decision is quoted from
   Jupiter's public API. Jupiter is a router, not a venue: it returns which public
   programs the swap hops through (pump.fun AMM, Raydium, Meteora, Whirlpool).
2. Jupiter returns an unsigned serialized transaction.
3. The transaction is signed locally with the wallet key
   (`src/lib/keys.server.ts`). Nothing custodial, no third party between the
   decision and the chain.
4. The signed bytes go to mainnet RPC. Validators settle it. That is the order.

Guards, because an autonomous loop holding a key needs them:

- the mint and side must match the sealed pre-commitment,
- the commitment's memo must already be confirmed on chain,
- price impact must clear a floor (2.5%), slippage capped at 150 bps,
- one order per decision, enforced by the commitment row,
- per-order ceiling ($3,000) and rolling 24h notional ceiling ($12,000),
- a SOL reserve is never spent, so the wallet can always pay fees.

## 5b. manage (the exit loop)

`src/lib/exit.server.ts`

An entry loop on its own can only open risk. Every cycle, before anything new is
considered, every open position is re-read from the wallet, re-priced from public
dex data, and run through a fixed exit rule set:

| rule | fires when |
| --- | --- |
| `exit_stop_loss` | unrealised is at or below -35% of cost |
| `exit_trailing_stop` | position printed +60% or better and has given back 40 points from that high |
| `exit_liquidity_break` | pool below $8,000, so the size can no longer leave cleanly |
| `exit_thesis_invalidated` | 6h change at or below -25% **and** sells leading buys by 1.4x |
| `exit_take_profit` | +100% / +300% / +900%, trimming 33% / 33% / 50% of what remains |
| `exit_stale_thesis` | held 14 days, inside +/-10%, 6h volume under $5,000 |

Risk-off rules beat profit taking: if a stop, trail, liquidity break,
invalidation or stale timer fires, the position closes fully instead of trimming.

A **separate sell risk gate** then runs, narrow on purpose, because a refused buy
costs nothing while a refused sell leaves risk on: minimum $25 clip, 30 minute
cooldown per mint, a tranche can only be taken once, and a ceiling of 8 exits per
rolling 24 hours.

The trailing stop needs a memory, so the high-water mark and tranche counter are
stored in the publicly readable `omo_position_marks` table. A trailing stop
nobody can inspect is a story, not a rule.

The exit is then hashed, published as a memo and only then routed and signed, so a
sell carries the same proof as a buy and passes the same four checks in
`/api/public/verify.json`. `GET /api/public/exits.json` publishes the thresholds,
the stored marks and every sell bound to the commitment that preceded it.

## 6. journal

`src/lib/wallet.server.ts`

Only a **confirmed** signature is written to the trade journal, and the fill is
bound back to the commitment it filled. Positions, cash, spend and P&L on the
site are then re-derived from the wallet itself, read off chain, so the number on
the page and the number a stranger computes come from the same source.

## 7. reveal

`src/lib/precommit.server.ts`, `src/lib/verify.server.ts`

Twenty minutes later the plaintext is opened. Anyone can SHA-256 the revealed
preimage and match the hash already sitting in an earlier confirmed block.

`/api/public/verify.json` re-checks all of it against public RPC and reports four
checks per row, pass or fail:

1. the revealed plaintext hashes to the published hash,
2. the memo is in an **earlier slot** than the fill,
3. the fill touches the mint the memo named,
4. the fill was signed by the published wallet.

To debunk it you would need a mismatched hash, a fill in an earlier slot than its
memo, a fill on a mint the memo never named, or a fill signed by a different key.

---

## keys

Two keys, deliberately separated:

| variable | job |
| --- | --- |
| `OMO_TRADING_KEY` | signs swaps. this is the key **exported out of the FOMO app** (wallet -> export private key), because the account FOMO displays is a normal Solana keypair. verified on load to derive the published wallet address, otherwise loading fails loudly. |
| `OMO_COMMIT_KEY` | memo-only burner that publishes decision hashes. never holds funds. |

Without `OMO_TRADING_KEY` the loop is **unarmed**: it still reads, thinks, gates,
seals on chain and reveals. It reports `unarmed` instead of pretending to trade.

Other variables: `SOLANA_RPC_URL` (optional preferred RPC),
`OMO_CYCLE_SECRET` (scheduler auth), `OMO_MODEL_API_KEY` (model access).

## cadence

The loop is not driven by an open browser. A scheduler calls:

```
POST /api/public/cycle
x-omo-cycle-secret: $OMO_CYCLE_SECRET
```

One decision cycle per call. The response is the step by step record, refusals
included. That is why the clock panel shows machine cadence across every hour of
the day rather than office hours.

## public endpoints

| endpoint | contents |
| --- | --- |
| `/api/public/proof.json` | the full record: logs, fills with venue, clock, audits, commitments, latency, refusals |
| `/api/public/verify.json` | independent re-verification against public Solana RPC |
| `/api/public/cycle` | authenticated trigger for one decision cycle |
