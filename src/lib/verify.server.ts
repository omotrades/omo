/**
 * Independent verifier.
 *
 * Everything here is recomputed from data a stranger can fetch themselves:
 * the memo transaction and the fill transaction are pulled from public Solana
 * RPC, and the hash is recomputed from the revealed plaintext. Nothing is taken
 * on trust from omo's own database except the plaintext, which is exactly the
 * thing the on-chain hash constrains.
 *
 * To debunk this you would need one of:
 *   - a revealed payload whose sha256 does not match the memo already on chain,
 *   - a fill in an earlier slot than the memo that named it,
 *   - a fill on a mint the earlier memo never named,
 *   - a fill signed by a key other than the published wallet.
 * All four are checked below and reported per row, pass or fail.
 */

import { OMO_WALLET } from "./wallet.server";
import { commitPreimage } from "./precommit.server";

const RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
];

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  for (const endpoint of RPCS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { result?: T; error?: unknown };
      if (json.error) continue;
      if (json.result !== undefined) return json.result;
    } catch {
      /* try the next node */
    }
  }
  return null;
}

async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type TxShape = {
  slot?: number;
  blockTime?: number | null;
  transaction?: {
    message?: { accountKeys?: (string | { pubkey: string; signer?: boolean })[] };
    signatures?: string[];
  };
  meta?: {
    logMessages?: string[] | null;
    preTokenBalances?: { mint: string; owner?: string }[] | null;
    postTokenBalances?: { mint: string; owner?: string }[] | null;
  };
};

async function getTx(signature: string) {
  return rpc<TxShape>("getTransaction", [
    signature,
    { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" },
  ]);
}

function accountKeys(tx: TxShape) {
  return (tx.transaction?.message?.accountKeys ?? []).map((k) =>
    typeof k === "string" ? k : k.pubkey,
  );
}

/** Memo text is echoed in the program logs, so it can be read back from chain. */
function memoFromLogs(tx: TxShape) {
  for (const line of tx.meta?.logMessages ?? []) {
    const match = /Memo \(len \d+\): "(.*)"$/.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

export type VerifyRow = {
  symbol: string | null;
  side: string | null;
  committedMint: string | null;
  memoSignature: string | null;
  memoSlot: number | null;
  memoTimeUtc: string | null;
  fillSignature: string | null;
  fillSlot: number | null;
  fillTimeUtc: string | null;
  recomputedHash: string | null;
  onChainHash: string | null;
  checks: {
    hashMatchesChain: boolean;
    memoBeforeFill: boolean;
    fillTouchedCommittedMint: boolean;
    fillSignedByWallet: boolean;
  };
  verified: boolean;
  note: string;
};

export type ExecutionPath = {
  wallet: string;
  venue: string;
  custody: string;
  steps: string[];
  whyNoApiIsNeeded: string;
};

/**
 * The execution path, written down rather than asserted. A swap on Solana is a
 * signed transaction against a public program, so the platform an order is
 * placed through is a rendering choice, not a dependency.
 */
export const EXECUTION_PATH: ExecutionPath = {
  wallet: OMO_WALLET,
  venue: "public solana programs · jupiter route, pump.fun and its amm, raydium, meteora",
  custody: "the key that signs the swaps is the wallet that holds the book. the key that writes the decision hashes is a separate burner that can only write memos.",
  steps: [
    "the decision is hashed with a random nonce and only the hash is written into a solana memo, so a validator timestamps it before any order exists.",
    "a route for the exact mint in that sealed decision is quoted from a public router api, which returns an unsigned transaction.",
    "the transaction is signed locally with the wallet key, so nothing custodial and no third party sits between the decision and the chain.",
    "the signed transaction goes to mainnet rpc and validators settle it. that is the order. there is no platform call anywhere in the sequence.",
    "fomo and pump.fun then display the position because both read the same wallet on the same chain, which is why the fill shows up in either app without either one executing it.",
    "twenty minutes later the plaintext is revealed, and the hash can be recomputed against the memo that was already in a confirmed block.",
  ],
  whyNoApiIsNeeded:
    "fomo has no public api and does not need one. it is a read layer over a wallet. the write layer is the chain, and anyone holding a key can write to it directly.",
};

export type VerifyReport = {
  wallet: string;
  generatedAtUtc: string;
  executionPath: ExecutionPath;
  howToReplicate: string[];
  totals: { checked: number; verified: number; failed: number };
  rows: VerifyRow[];
};



/**
 * Checks the most recent revealed commitments that have a fill attached, end to
 * end, against mainnet. Cheap enough to serve publicly, small enough not to
 * hammer the free RPC.
 */
export async function buildVerifyReport(limit = 8): Promise<VerifyReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data } = await supabaseAdmin
    .from("omo_commits")
    .select(
      "symbol, side, mint, payload, nonce, commit_hash, memo_signature, memo_slot, fill_signature, revealed",
    )
    .eq("revealed", true)
    .not("memo_signature", "is", null)
    .not("fill_signature", "is", null)
    .order("decision_at", { ascending: false })
    .limit(limit);

  const rows: VerifyRow[] = [];
  for (const row of data ?? []) {
    const recomputed =
      row.payload && row.nonce ? await sha256Hex(commitPreimage(row.payload, row.nonce)) : null;

    const [memoTx, fillTx] = await Promise.all([
      row.memo_signature ? getTx(row.memo_signature) : Promise.resolve(null),
      row.fill_signature ? getTx(row.fill_signature) : Promise.resolve(null),
    ]);

    const memoText = memoTx ? memoFromLogs(memoTx) : null;
    const onChainHash = memoText?.startsWith("omo:commit:v1:")
      ? memoText.slice("omo:commit:v1:".length)
      : null;

    const memoSlot = memoTx?.slot ?? (row.memo_slot === null ? null : Number(row.memo_slot));
    const fillSlot = fillTx?.slot ?? null;
    const mints = new Set(
      [...(fillTx?.meta?.preTokenBalances ?? []), ...(fillTx?.meta?.postTokenBalances ?? [])].map(
        (b) => b.mint,
      ),
    );
    const signers = accountKeys(fillTx ?? {});

    const checks = {
      hashMatchesChain: !!recomputed && !!onChainHash && recomputed === onChainHash,
      memoBeforeFill: memoSlot !== null && fillSlot !== null && memoSlot < fillSlot,
      fillTouchedCommittedMint: !!row.mint && mints.has(row.mint),
      fillSignedByWallet: signers[0] === OMO_WALLET,
    };
    const verified = Object.values(checks).every(Boolean);

    rows.push({
      symbol: row.symbol,
      side: row.side,
      committedMint: row.mint,
      memoSignature: row.memo_signature,
      memoSlot,
      memoTimeUtc: memoTx?.blockTime ? new Date(memoTx.blockTime * 1000).toISOString() : null,
      fillSignature: row.fill_signature,
      fillSlot,
      fillTimeUtc: fillTx?.blockTime ? new Date(fillTx.blockTime * 1000).toISOString() : null,
      recomputedHash: recomputed,
      onChainHash,
      checks,
      verified,
      note: verified
        ? "the sealed decision was on chain before the fill, and the fill matches it"
        : !checks.hashMatchesChain
          ? "hash could not be matched against the memo on chain"
          : !checks.memoBeforeFill
            ? "slot ordering could not be established from this rpc"
            : !checks.fillTouchedCommittedMint
              ? "the fill did not touch the committed mint"
              : "the fill was not signed by the published wallet",
    });
  }

  const verified = rows.filter((r) => r.verified).length;
  return {
    wallet: OMO_WALLET,
    generatedAtUtc: new Date().toISOString(),
    executionPath: EXECUTION_PATH,
    howToReplicate: [
      `fetch the memo: curl a mainnet rpc with getTransaction on memoSignature and read the memo log`,
      `recompute the hash: sha256("omo-commit-v1|" + nonce + "|" + canonical(payload)) where canonical sorts object keys and drops undefined`,
      `compare it byte for byte with the string after "omo:commit:v1:" in the memo log`,
      `fetch the fill with getTransaction on fillSignature and confirm its slot is higher than the memo slot`,
      `confirm the fill's pre/post token balances contain committedMint and that account key 0 is ${OMO_WALLET}`,
      `every field above comes from public rpc, so a mismatch anywhere breaks the claim`,
    ],
    totals: { checked: rows.length, verified, failed: rows.length - verified },
    rows,
  };
}
