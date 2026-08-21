# Operations

## Environment

See [`.env.example`](../.env.example) for the full list. Nothing is read at module scope;
every variable is read inside the handler that needs it.

| variable | required | purpose |
| --- | --- | --- |
| `OMO_TRADING_KEY` | no | signs swaps. Absent means unarmed, which is the safe default. |
| `OMO_COMMIT_KEY` | no | memo-only burner that publishes decision hashes. |
| `OMO_CYCLE_SECRET` | yes to run cycles | shared secret for the scheduler endpoint. |
| `SOLANA_RPC_URL` | no | preferred RPC; public endpoints are used as fallback. |
| `OMO_MODEL_API_KEY` | no | model access for the thesis stage. |

Both keys accept base58 (what wallet apps export) or a JSON byte array. The trading key
is verified on load to derive the published wallet address; a mismatch fails loudly
instead of trading from the wrong account.

## Cadence

The loop is not driven by an open browser. A scheduler calls one endpoint:

```sh
curl -X POST https://omotrades.com/api/public/cycle \
  -H "x-omo-cycle-secret: $OMO_CYCLE_SECRET"
```

One call is one decision cycle. The response is the step-by-step record, refusals
included. Any scheduler works: `pg_cron`, a CI cron, or an external uptime scheduler.
Unauthenticated calls get `401`.

## Runbook

**Cycles return `unarmed`.** No trading key present. Expected for clones and staging.

**Cycles return a refusal every time.** Read `rules` on the audit row. A refusal is a
correct outcome, not an error; check `liquidity_floor`, `crowd_heat` and `cash_available`
first.

**Trading key rejected on load.** The key does not derive the published wallet. Verify
you exported the right account, and that the address in the wallet configuration matches.

**Commitments stuck unpublished.** Memo publishing is deliberately decoupled from the
tick. Check RPC health and the commit key's SOL balance; publication retries on the next
cycle.

**`verify.json` shows a failing check.** Do not paper over it. A failing check means the
sequence for that row did not hold and it should stay visible in the record.

**Page slow or payloads large.** History pruning keeps published payloads bounded; the
chain remains the durable record.

## Deploy checklist

1. `bun run typecheck && bun run lint && bun run test`
2. `bun run build`
3. Confirm secrets are set in the deployment environment, not in files.
4. Hit `/api/public/verify.json` after deploy and confirm every row still verifies.
