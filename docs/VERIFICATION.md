# Verification

Everything below can be done by a stranger with `curl`, a SHA-256 tool and a public
Solana RPC endpoint. No access to this deployment is required.

Published wallet: `HxwmEH84o3EuezCUZuBEEeKT6uMDv8R4VRi76ExB87St`

## 1. Pull the record

```sh
curl -s https://omotrades.com/api/public/proof.json | jq '.commitments[0]'
```

A commitment row contains the hash, the memo signature, the reveal time and, once
revealed, the plaintext preimage plus the fill it was bound to.

## 2. Recompute the hash

The preimage is version prefixed and canonically encoded:

```text
omo-commit-v1|<nonce>|<canonical json of the decision>
```

```sh
printf '%s' "$PREIMAGE" | shasum -a 256
```

The digest must equal the `hash` field, which is already sitting inside a confirmed
Solana memo transaction from an earlier block.

## 3. Check the memo predates the fill

```sh
curl -s $RPC -X POST -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"getTransaction",
  "params":["<memo signature>",{"maxSupportedTransactionVersion":0}]}' | jq '.result.slot'
```

Repeat for the fill signature. The memo slot must be strictly lower. Slot ordering is
produced by validators, not by this application.

## 4. Check the fill matches

The fill transaction must touch the mint named in the revealed plaintext, and must be
signed by the published wallet address.

## 5. Or let the endpoint do all four

```sh
curl -s https://omotrades.com/api/public/verify.json | jq '.rows[0].checks'
```

Each row reports four independent checks, pass or fail:

| check | meaning |
| --- | --- |
| `hash_matches` | revealed plaintext hashes to the published hash |
| `memo_earlier` | memo confirmed in a strictly earlier slot than the fill |
| `mint_matches` | fill touches the mint the memo named |
| `signer_matches` | fill signed by the published wallet |

Failures are shown, not hidden. A row that cannot be verified is worth more than a row
that claims it was.

## 6. Check the exits, not just the entries

```sh
curl -s https://omotrades.com/api/public/exits.json | jq '{limits, marks: .marks[0], sells: .sells[0]}'
```

Sells are sealed and published exactly like buys, so every row in
`sellCommitments` can be run through steps 1 to 4 above. The `limits` block is the
live exit thresholds and `marks` is the stored high-water mark and tranche counter
each trailing stop was judged against, so a trim or a close can be replayed
against the numbers that produced it.

## What would falsify the claim

- A revealed preimage whose digest does not match the published hash.
- A fill in an earlier slot than the memo that supposedly preceded it.
- A fill on a mint the memo never named.
- A fill signed by a key other than the published wallet.
- A sell with no sealed commitment, or one whose memo followed the fill.
- A trailing stop exit whose stored high-water mark never supported it.
- Positions on the site that disagree with the wallet's on-chain token accounts.

Any one of those is disqualifying, and all of them are checkable without asking.
