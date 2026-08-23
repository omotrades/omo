# omo

omo reads the market, forms a thesis, gates it against fixed rules, seals the decision before acting, and publishes the plaintext so anyone can verify the order of events.

live site: <https://omotrades.com>  
wallet: `HxwmEH84o3EuezCUZuBEEeKT6uMDv8R4VRi76ExB87St`

## how it runs

```text
read ──▶ think ──▶ gate ──▶ seal ──▶ execute ──▶ journal ──▶ reveal
 │        │        │        │          │           │          │
market  thesis   fixed    sha256     jupiter    confirmed  plaintext
data    (model)  rules    memo tx    + local    signature  published
                            on chain  signing
```

| stage | module | what it does |
| --- | --- | --- |
| manage | `src/lib/exit.server.ts` | re-price every open position, run the exit rule set, seal and route sells |
| read | `src/lib/market.server.ts`, `src/lib/fomo.server.ts`, `src/lib/theses.server.ts`, `src/lib/web-research.server.ts` | screen tokens, read crowd theses, manage the database-backed thesis book, search the open web |
| think | `src/lib/omo-brain.server.ts`, `src/lib/ai-gateway.server.ts`, `src/lib/models.server.ts` | write a thesis, an invalidation and a verdict |
| gate | `src/lib/audit.server.ts` | one rule set shared by the audit log and the live path |
| seal | `src/lib/precommit.server.ts` | hash the decision, publish the hash as a Solana memo |
| execute | `src/lib/execute.server.ts`, `src/lib/solana.server.ts`, `src/lib/keys.server.ts` | quote, sign locally, submit, enforce risk limits |
| journal | `src/lib/wallet.server.ts` | record confirmed fills, re-derive the book from chain |
| reveal | `src/lib/precommit.server.ts`, `src/lib/verify.server.ts` | open the preimage, re-verify against public RPC |

the whole sequence is joined in `src/lib/pipeline.server.ts`.

## source of truth

- **wallet** — `HxwmEH84o3EuezCUZuBEEeKT6uMDv8R4VRi76ExB87St` on Solana
- **commitments** — Solana Memo Program transactions from the burner memo key

any claim on the front end can be recomputed from tpublic sources.

## public endpoints

| endpoint | contents |
| --- | --- |
| `GET /api/public/proof.json` | decisions, fills, commitments, refusals |
| `GET /api/public/verify.json` | re-verification of every commitment against public RPC |
| `GET /api/public/exits.json` | exit thresholds, stored high-water marks, every sell bound to its commitment |
| `GET /api/public/theses.json` | current open thesis book with live chain and author provenance |
| `GET /api/public/reasoning.json` | server-side reasoning log with timestamps and per-thesis provenance |
| `GET /api/public/disclosure.json` | live machine state, loop status, and hardware truths |
| `POST /api/public/cycle` | authenticated trigger for one decision cycle |

see [`PROCESS.md`](PROCESS.md) for the honest end-to-end description and [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for how to check a claim independently.
