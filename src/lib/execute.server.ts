/**
 * Execution.
 *
 * This is the step people assume cannot exist because fomo publishes no api. It
 * does not need to. A swap on Solana is a signed transaction against a public
 * program, so the order is composed here, signed with the wallet key, and handed
 * to mainnet rpc. Fomo and pump.fun then show the position because both of them
 * read the same wallet on the same chain. Neither one executes anything.
 *
 * The sequence, exactly as the proof page states it:
 *
 *   1. a route for the mint named in the already-sealed decision is quoted from
 *      jupiter's public api. jupiter is a router, not a venue: it returns which
 *      public programs (pump.fun amm, raydium, meteora, whirlpool) the swap will
 *      hop through.
 *   2. jupiter returns an unsigned serialized transaction for that exact route.
 *   3. the transaction is signed locally with the wallet key. nothing custodial,
 *      no third party between the decision and the chain.
 *   4. the signed bytes go to rpc. validators settle it. that is the order.
 *   5. the signature is confirmed, and only then written to the trade journal,
 *      where the same row the site renders is the row a stranger can look up.
 *
 * Guards, because an autonomous loop holding a key needs them:
 *   - the mint must match the mint inside the sealed pre-commitment,
 *   - the pre-commitment's memo must already be on chain,
 *   - the quote's price impact and route must clear a floor,
 *   - one order per decision, enforced by the commitment row,
 *   - a hard per-order and per-day notional ceiling.
 */

import { OMO_WALLET } from "./wallet.server";

const JUPITER_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP = "https://quote-api.jup.ag/v6/swap";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Hard ceiling on a single ticket, exported so sizing cannot silently exceed it. */
export const MAX_ORDER_USD = 3_000;

/** Risk limits. Deliberately boring, deliberately not model-controlled. */
export const EXECUTION_LIMITS = {
  maxOrderUsd: MAX_ORDER_USD,
  maxDailyUsd: 12_000,
  maxPriceImpactPct: 2.5,
  slippageBps: 150,
  minSolReserve: 0.05,
};

export type OrderIntent = {
  /** the commitment row this order is allowed to fill, and nothing else */
  commitId: string;
  side: "buy" | "sell";
  mint: string;
  symbol: string;
  /** buys are sized in usd; sells are sized as a fraction of the position */
  usd?: number;
  fraction?: number;
};

export type OrderResult =
  | { status: "unarmed"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string; signature?: string }
  | {
      status: "filled";
      signature: string;
      slot: number | null;
      at: string;
      route: string[];
      priceImpactPct: number;
      inAmount: string;
      outAmount: string;
      usdValue: number;
    };

type Quote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan?: { swapInfo?: { label?: string } }[];
};

async function quote(inputMint: string, outputMint: string, amount: string): Promise<Quote | null> {
  const url = `${JUPITER_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${EXECUTION_LIMITS.slippageBps}&onlyDirectRoutes=false`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.log(`[execute] quote failed ${res.status}`);
      return null;
    }
    return (await res.json()) as Quote;
  } catch (error) {
    console.log(`[execute] quote error ${String(error).slice(0, 120)}`);
    return null;
  }
}

async function buildSwap(quoteResponse: Quote): Promise<Uint8Array | null> {
  try {
    const res = await fetch(JUPITER_SWAP, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: OMO_WALLET,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.log(`[execute] swap build failed ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { swapTransaction?: string };
    if (!body.swapTransaction) return null;
    const { fromBase64 } = await import("./solana.server");
    return fromBase64(body.swapTransaction);
  } catch (error) {
    console.log(`[execute] swap build error ${String(error).slice(0, 120)}`);
    return null;
  }
}

/** Decimals read off the mint itself, so sell sizes are exact rather than assumed. */
async function mintDecimals(mint: string): Promise<number | null> {
  const { rpc } = await import("./solana.server");
  const supply = await rpc<{ value?: { decimals?: number } }>("getTokenSupply", [mint]);
  const decimals = supply?.value?.decimals;
  return typeof decimals === "number" ? decimals : null;
}

async function solPriceUsd(): Promise<number | null> {
  const { getPrices } = await import("./wallet.server");
  const prices = await getPrices([SOL_MINT]);
  return prices[SOL_MINT] ?? null;
}

/** Notional already sent today, read out of the journal rather than tracked in memory. */
async function spentTodayUsd() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data } = await supabaseAdmin
    .from("omo_trades")
    .select("usd_value, side, at")
    .gte("at", since);
  return (data ?? [])
    .filter((row) => row.side === "buy")
    .reduce((sum, row) => sum + Number(row.usd_value ?? 0), 0);
}

/**
 * Checks the order against the sealed decision it claims to be filling. The
 * commitment must exist, must already be stamped on chain, must name this mint
 * and side, and must not have been filled once already.
 */
async function checkCommitment(intent: OrderIntent): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("omo_commits")
    .select("id, mint, side, verdict, memo_signature, fill_signature")
    .eq("id", intent.commitId)
    .maybeSingle();
  if (!data) return "no sealed decision for this order";
  if (!data.memo_signature) return "decision hash is not on chain yet";
  if (data.mint && data.mint !== intent.mint) return "order mint does not match the sealed decision";
  if (data.side && data.side !== intent.side) return "order side does not match the sealed decision";
  if (data.fill_signature) return "this decision already has a fill";
  return null;
}

/**
 * Places one order. Every early return is a refusal that gets logged and shown,
 * because the refusals are as much of the record as the fills.
 */
export async function placeOrder(intent: OrderIntent): Promise<OrderResult> {
  const { tradingSigner } = await import("./keys.server");
  const signer = await tradingSigner();
  if (!signer) {
    return { status: "unarmed", reason: "no trading key loaded, decision committed but not executed" };
  }

  const commitProblem = await checkCommitment(intent);
  if (commitProblem) return { status: "blocked", reason: commitProblem };

  const { getWalletSnapshot, fetchRecentTrades } = await import("./wallet.server");
  const snapshot = await getWalletSnapshot(await fetchRecentTrades(150), true);
  const sol = await solPriceUsd();
  if (!sol) return { status: "blocked", reason: "no sol price, cannot size the order" };

  let inputMint: string;
  let outputMint: string;
  let amount: string;
  let usd: number;
  let sellTokenAmount = 0;

  if (intent.side === "buy") {
    usd = Math.min(intent.usd ?? 0, EXECUTION_LIMITS.maxOrderUsd);
    if (usd < 25) return { status: "blocked", reason: "ticket below the minimum size" };
    const spent = await spentTodayUsd();
    if (spent + usd > EXECUTION_LIMITS.maxDailyUsd) {
      return { status: "blocked", reason: `daily notional ceiling reached ($${Math.round(spent)})` };
    }
    const lamports = Math.floor((usd / sol) * LAMPORTS_PER_SOL);
    const reserve = Math.floor(EXECUTION_LIMITS.minSolReserve * LAMPORTS_PER_SOL);
    const available = Math.floor((snapshot?.solBalance ?? 0) * LAMPORTS_PER_SOL) - reserve;
    if (lamports > available) return { status: "blocked", reason: "not enough sol after the gas reserve" };
    inputMint = SOL_MINT;
    outputMint = intent.mint;
    amount = String(lamports);
  } else {
    const position = (snapshot?.positions ?? []).find((row) => row.mint === intent.mint);
    if (!position || position.amount <= 0) return { status: "blocked", reason: "no position to sell" };
    const fraction = Math.min(Math.max(intent.fraction ?? 1, 0.01), 1);
    const decimals = await mintDecimals(intent.mint);
    if (decimals === null) return { status: "blocked", reason: "could not read mint decimals" };
    const raw = BigInt(Math.floor(position.amount * fraction * 10 ** decimals));
    if (raw <= 0n) return { status: "blocked", reason: "sell size rounds to zero" };
    usd = position.usdValue * fraction;
    sellTokenAmount = position.amount * fraction;
    inputMint = intent.mint;
    outputMint = SOL_MINT;
    amount = raw.toString();
  }

  const q = await quote(inputMint, outputMint, amount);
  if (!q) return { status: "failed", reason: "no route quoted for this mint" };

  const impact = Math.abs(Number(q.priceImpactPct ?? 0)) * 100;
  if (impact > EXECUTION_LIMITS.maxPriceImpactPct) {
    return { status: "blocked", reason: `price impact ${impact.toFixed(2)}% above the floor` };
  }

  const unsigned = await buildSwap(q);
  if (!unsigned) return { status: "failed", reason: "router returned no transaction" };

  const { signSerializedTransaction, sendRawTransaction, confirmSignature, RPCS } = await import(
    "./solana.server"
  );
  const signed = signSerializedTransaction(unsigned, signer.sign);

  let signature: string | null = null;
  for (const endpoint of RPCS) {
    signature = await sendRawTransaction(endpoint, signed);
    if (signature) break;
  }
  if (!signature) return { status: "failed", reason: "every rpc refused the transaction" };

  const confirmation = await confirmSignature(signature);
  if (!confirmation.confirmed) {
    return { status: "failed", reason: confirmation.err ?? "unconfirmed", signature };
  }

  const route = (q.routePlan ?? [])
    .map((leg) => leg.swapInfo?.label)
    .filter((label): label is string => Boolean(label));
  const at = confirmation.blockTime ?? new Date().toISOString();

  await journalFill({
    signature,
    at,
    side: intent.side,
    symbol: intent.symbol,
    mint: intent.mint,
    usdValue: usd,
    solAmount: intent.side === "buy" ? Number(amount) / LAMPORTS_PER_SOL : Number(q.outAmount) / LAMPORTS_PER_SOL,
    tokenAmount: intent.side === "buy" ? Number(q.outAmount) : sellTokenAmount,
    commitId: intent.commitId,
  });

  return {
    status: "filled",
    signature,
    slot: confirmation.slot,
    at,
    route,
    priceImpactPct: Number(impact.toFixed(3)),
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    usdValue: usd,
  };
}

/**
 * Writes a confirmed fill into the journal and binds it back to the commitment
 * it filled. The binding is what lets the verifier prove the memo was stamped in
 * an earlier slot than the trade.
 */
async function journalFill(args: {
  signature: string;
  at: string;
  side: "buy" | "sell";
  symbol: string;
  mint: string;
  usdValue: number;
  solAmount: number;
  tokenAmount: number;
  commitId: string;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("omo_trades").upsert(
    {
      signature: args.signature,
      at: args.at,
      side: args.side,
      symbol: args.symbol,
      mint: args.mint,
      usd_value: args.usdValue,
      sol_amount: args.solAmount,
      token_amount: args.tokenAmount,
    } as never,
    { onConflict: "signature" },
  );
  await supabaseAdmin
    .from("omo_commits")
    .update({ fill_signature: args.signature, fill_at: args.at } as never)
    .eq("id", args.commitId);
}
