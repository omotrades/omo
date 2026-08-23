# how omo works

The full machine, end to end, mapped to the file that implements each step. The
sequence is joined in one place (`src/lib/pipeline.server.ts`), so the order of
operations can be read rather than inferred.

The short version: **fomo has no api and does not need one.** FOMO is a read
layer over a Solana wallet. The write layer is the chain. omo holds the key to
the same wallet FOMO displays, composes and signs its own swaps against public
programs, and sends them to mainnet RPC. FOMO and pump.fun then show the
position, because both of them read that wallet.

Wallet: `HxwmEH84o3EuezCUZuBEEeKT6uMDv8R4VRi76ExB87St`

Every stage below writes its output to a table that is published raw at a public
endpoint. Nothing in this document has to be taken on trust; each section names
the request that settles it.

---

## 1. read

`src/lib/market.server.ts`, `src/lib/fomo.server.ts`, `src/lib/web-research.server.ts`

- Solana memecoins are screened from public DEX data: liquidity, 1h volume, buys
  against sells, age, socials.
- The FOMO board is read for the written theses holders attached to a token,
  along with their position size and P&L.
- The open web is searched for what is actually driving the attention.

## 2. think

`src/lib/omo-brain.server.ts`, `src/lib/models.server.ts`, `src/lib/ai-gateway.server.ts`

omo is not one model. Each stage declares the mind it was written for, and the
router dispatches the call:

| role | model | why |
| --- | --- | --- |
| `reasoning` | claude opus 5 | thesis formation and the pre-trade think. long context over the whole book, strict adherence to the constraints, low appetite for hype. |
| `realtime` | grok | the live social read. memecoin attention forms on the timeline before it shows on the tape, so this stage uses the model closest to it. |
| `narration` | claude opus 5 | the public stream, on the same mind that decided, so the words match the reasoning instead of narrating over it. |

The realtime read is evidence only: who is talking, and whether the interest is
organic or already peaked. It returns no verdict. The reasoning role takes that
read together with the tape, the FOMO theses and the web material, and writes the
thesis: why the attention exists, what would make it wrong, buy or pass. The
thesis is written **before** any order exists and stored with a server timestamp
at the moment it is written.

The model that actually answered is recorded in the same row as the text it
produced, together with the model the stage declared. `GET
/api/public/reasoning.json` returns those rows with their authorship, so any line
on the site can be traced to the call that produced it.

## 3. the thesis book

`src/lib/theses.server.ts`, table `public.omo_theses`

A position's write-up is state, not source. It is opened when a position is
taken, revised while the position lives, and retired when it closes. Each row
carries the mint, the text, the author (`operator` or `model`) and, for model
rows, the model that wrote it. Size, unrealised and P&L are re-marked against the
chain on every wallet sync, so the stored row and the live wallet agree.

`GET /api/public/theses.json` publishes the whole book, open and retired, with
the authorship split. The panel on the site is a render of that table.

## 4. gate

`src/lib/audit.server.ts`

One rule set, shared by the published audit log and the live execution path.
There is no second, looser set for real orders:

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

Any failed rule is a refusal, and refusals are recorded and published exactly
like fills. That is the boring half of the proof: nobody fakes hundreds of nos.

## 5. seal

`src/lib/precommit.server.ts`

The decision (name, mint, side, intent, every rule and the numbers behind them)
plus a random nonce is canonically serialised and hashed with SHA-256. Only the
hash goes out, as a Solana memo instruction signed by a **separate burner key**
that can write memos and never holds the book.

A timestamp in omo's own database proves nothing, because omo owns the database.
A validator's timestamp is not omo's to move.

Every sealed decision carries an `intent` of `order` or `decline`, and that label
sits inside the hashed payload, so it cannot be reinterpreted afterwards. Only an
order intent can ever bind to a fill; a decline is a decision not to trade and no
fill should exist for it.

The memo transaction is built and signed by hand (`src/lib/solana.server.ts`),
because the official SDK does not run in this runtime.

## 6. execute

`src/lib/execute.server.ts`

1. A route for the mint named in the already-sealed decision is quoted from
   Jupiter's public API. Jupiter is a router, not a venue: it returns which public
   programs the swap hops through (pump.fun AMM, Raydium, Meteora, Whirlpool).
2. Jupiter returns an unsigned serialised transaction.
3. It is signed locally with the wallet key (`src/lib/keys.server.ts`). Nothing
   custodial, no third party between the decision and the chain.
4. The signed bytes go to mainnet RPC. Validators settle it. That is the order.

Guards, because a loop holding a key needs them:

- the mint and side must match the sealed pre-commitment,
- the commitment's memo must already be confirmed on chain,
- price impact must clear a floor (2.5%), slippage capped at 150 bps,
- one order per decision, enforced by the commitment row,
- a size budget derived from the live book on every order (`src/lib/risk.server.ts`):
  per ticket = equity x 3.5% x a drawdown factor that shrinks while open risk is
  under water, per day = four tickets, both clamped by a structural backstop of
  $3,000 per ticket and $12,000 per day and enforced at the execution boundary
  rather than only in sizing. The computed numbers and the formula are published
  in `limits` on `/proof`, so they can be recomputed from public equity,
- a SOL reserve is never spent, so the wallet can always pay fees.

## 7. manage

`src/lib/exit.server.ts`

An entry loop on its own can only open risk. Every cycle, before anything new is
considered, each open position is re-read from the wallet, re-priced from public
DEX data, and run through a fixed exit rule set:

| rule | fires when |
| --- | --- |
| `exit_stop_loss` | unrealised at or below -35% of cost |
| `exit_trailing_stop` | printed +60% or better and gave back 40 points from that high |
| `exit_liquidity_break` | pool below $8,000, so the size can no longer leave cleanly |
| `exit_thesis_invalidated` | 6h change at or below -25% **and** sells leading buys 1.4x |
| `exit_take_profit` | +100% / +300% / +900%, trimming 33% / 33% / 50% of the rest |
| `exit_stale_thesis` | held 14 days, inside +/-10%, 6h volume under $5,000 |

Risk-off beats profit taking: a stop, trail, liquidity break, invalidation or
stale timer closes the position fully instead of trimming.

A separate sell risk gate then runs, narrow on purpose, because a refused buy
costs nothing while a refused sell leaves risk on: minimum $25 clip, 30 minute
cooldown per mint, one take per tranche, ceiling of 8 exits per rolling 24 hours.

The trailing stop needs a memory, so the high-water mark and tranche counter live
in the publicly readable `omo_position_marks` table, written on the live cadence
independently of any scheduler. An unset mark starts at the live number, negative
included, so the rule never trails from a peak that never happened. A trailing
stop nobody can inspect is a story, not a rule.

Exits are sealed, published as a memo and only then routed and signed, so a sell
carries the same proof as a buy. `GET /api/public/exits.json` publishes the
thresholds, every stored mark, and every sell against the commitment that
preceded it.

## 8. journal

`src/lib/wallet.server.ts`

Only a **confirmed** signature enters the trade journal, and the fill is bound
back to the commitment it filled. The binding is deliberately strict: same mint,
same side, memo confirmed before the fill, inside the window, and not already
bound elsewhere. Positions, cash, spend and P&L on the site are then re-derived
from the wallet itself, read off chain, so the number on the page and the number
a stranger computes come from the same source.

A fill counts as machine executed only when a sealed commitment naming the same
mint and side was on chain before it. Anything else is published as unbound, with
the count stated rather than buried.

## 9. reveal

`src/lib/precommit.server.ts`, `src/lib/verify.server.ts`

Twenty minutes later the plaintext opens. Anyone can SHA-256 the revealed
preimage and match the hash already sitting in an earlier confirmed block.

`GET /api/public/verify.json` re-checks the record against public RPC and reports
four checks per row, pass or fail:

1. the revealed plaintext hashes to the published hash,
2. the memo is in an **earlier slot** than the fill,
3. the fill touches the mint the memo named,
4. the fill was signed by the published wallet.

Each response also carries a `scope` block: how many order commitments exist, how
many are revealed, and how many carry a bound fill. Every count is printed next
to the sentence saying which question it answers, so a zero reads as a scope
statement rather than a shrug.

To break it you would need a mismatched hash, a fill in an earlier slot than its
memo, a fill on a mint the memo never named, or a fill signed by a different key.

---

## keys

Two keys, deliberately separated:

| variable | job |
| --- | --- |
| `OMO_TRADING_KEY` | signs swaps. this is the key exported out of the FOMO app (wallet -> export private key), because the account FOMO displays is a normal Solana keypair. verified on load to derive the published wallet address, otherwise loading fails loudly. |
| `OMO_COMMIT_KEY` | memo-only burner that publishes decision hashes. never holds funds. |

The trading key is the only thing that separates signing from not signing. Read,
think, gate, seal, reveal, mark and manage all run either way, and the machine
reports its own signing state at `/api/public/disclosure.json` instead of letting
anyone guess.

Other variables: `SOLANA_RPC_URL` (preferred RPC), `OMO_CYCLE_SECRET` (scheduler
auth), `OMO_MODEL_API_KEY` (model access).

### open brain, locked hand

The decision machine is in this repository. The secret that authorises a transfer
of value is not, and will not be. It reaches the running process as an
environment variable and is never written to a file, a log, a table or a response
body. `src/lib/signer.interface.ts` states the boundary and the contract the
pipeline is written against: anything that can sign transaction bytes satisfies
it, whether that is a local keypair, a remote signer or hardware.

So reading this repository tells you exactly how a decision is formed and exactly
what will be signed, and gives you no ability to sign anything. That is the
intended trade. Auditability and custody are separate problems.

Nothing about the proof depends on seeing the key. The four checks in
`verify.server.ts` run against public RPC: hash before fill, reveal matches
commitment, mint matches commitment, fill signed by the published wallet. A key
you cannot see cannot forge any of those.

Arming is a runtime property. `isArmed()` reads the environment and
`/api/public/disclosure.json` republishes that answer unedited, which is why no
deploy and no edit in this file can turn it on.


## cadence

The loop is not driven by an open browser. A scheduler calls:

```
POST /api/public/cycle
x-omo-cycle-secret: $OMO_CYCLE_SECRET
```

One decision cycle per call, and the response is the step by step record,
refusals included. That is why the clock panel shows machine cadence across every
hour of the day rather than office hours.

## public endpoints

| endpoint | contents |
| --- | --- |
| `/api/public/proof.json` | the full record: logs, fills with venue, clock, audits, commitments, latency, refusals |
| `/api/public/verify.json` | independent re-verification against public Solana RPC, with scope counts |
| `/api/public/theses.json` | the thesis book: open and retired write-ups, authors, live marks |
| `/api/public/reasoning.json` | recent stream lines with the author and model recorded per line |
| `/api/public/exits.json` | exit thresholds, stored high-water marks, sells and sell commitments |
| `/api/public/disclosure.json` | signing state, bound against unbound fills, mark freshness, model status, size ceilings |
| `/api/public/cycle` | authenticated trigger for one decision cycle |

## how to check it in five minutes

1. `theses.json` — read the book, then compare it to the panel on the site. The
   panel is a render of that table; a thesis changes without a deploy.
2. `reasoning.json` — take any sentence off the page and find the row that stores
   it, with the model that wrote it and the server timestamp.
3. `verify.json` — pick a bound fill, hash the revealed preimage yourself, and
   confirm the memo slot precedes the fill slot on any public explorer.
4. `exits.json` — read the thresholds, then check the stored high-water mark for
   an open position against its live price.
5. `disclosure.json` — the unflattering numbers, published by the machine about
   itself, including whatever it is not doing yet.

The site renders finished strings and nothing more: no phrase list, no
client-side sentence assembly, no random selection. The only browser-driven
motion is a one second clock and a colour cycle over ASCII already fetched from
the server. Load the page with JavaScript disabled, or read the server-rendered
HTML, and compare it to the endpoints above.
