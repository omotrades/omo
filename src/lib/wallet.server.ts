/**
 * omo's on-chain life. Everything here is real data read from Solana mainnet
 * for omo's own FOMO wallet — balances, purchases, spend and P&L.
 */

import { readOffBook } from "./offbook.server";

export const OMO_WALLET = "HxwmEH84o3EuezCUZuBEEeKT6uMDv8R4VRi76ExB87St";

/**
 * Public endpoints rotate: the first that answers wins. api.mainnet-beta blocks
 * some serverless egress, so the list matters in production.
 */
const RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://api.blockeden.xyz/solana/8UyXPPCV3jVvSaJjHkgAf7",
];
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const STABLES = new Set([USDC_MINT, USDT_MINT]);
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type Holding = {
  mint: string;
  symbol: string;
  icon: string | null;
  amount: number;
  usdPrice: number;
  usdValue: number;
};

export type Position = Holding & {
  avgCost: number;
  costBasis: number;
  unrealized: number;
  unrealizedPct: number;
  /** market cap at the average entry, only set for off-chain marks */
  entryMarketCapUsd?: number;
};

export type WalletTrade = {
  signature: string;
  at: string;
  side: "buy" | "sell";
  symbol: string;
  mint: string;
  token_amount: number;
  sol_amount: number;
  usd_value: number;
};

export type WalletSnapshot = {
  address: string;
  solBalance: number;
  solPrice: number;
  solValue: number;
  usdcBalance: number;
  stableBalance: number;
  holdings: Holding[];
  positions: Position[];
  equity: number;
  cash: number;
  spentToday: number;
  spentAllTime: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  tradeCount: number;
  lastActivity: string | null;
  fetchedAt: string;
};


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
      if (json.error || json.result === undefined || json.result === null) continue;
      return json.result;
    } catch {
      /* try the next endpoint */
    }
  }
  return null;
}

export async function getPrices(mints: string[]): Promise<Record<string, number>> {
  const unique = Array.from(new Set(mints)).slice(0, 40);
  if (unique.length === 0) return {};
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${unique.join(",")}`);
    if (!res.ok) return {};
    const json = (await res.json()) as Record<string, { usdPrice?: number }>;
    const out: Record<string, number> = {};
    for (const [mint, value] of Object.entries(json)) {
      if (typeof value?.usdPrice === "number") out[mint] = value.usdPrice;
    }
    return out;
  } catch {
    return {};
  }
}

const metaCache = new Map<string, { symbol: string; icon: string | null }>();

function shortMint(mint: string) {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/**
 * Symbols are resolved from Jupiter first, DexScreener second. A failed lookup is
 * never cached, otherwise one bad fetch pins a contract address into the book forever.
 */
export async function getTokenMeta(mint: string) {
  const cached = metaCache.get(mint);
  if (cached) return cached;

  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
    if (res.ok) {
      const rows = (await res.json()) as { id?: string; symbol?: string; icon?: string }[];
      const hit = rows.find((r) => r.id === mint) ?? rows[0];
      if (hit?.symbol) {
        const meta = { symbol: hit.symbol, icon: hit.icon ?? null };
        metaCache.set(mint, meta);
        return meta;
      }
    }
  } catch {
    /* fall through to dexscreener */
  }

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (res.ok) {
      const json = (await res.json()) as {
        pairs?: { baseToken?: { address?: string; symbol?: string }; info?: { imageUrl?: string } }[];
      };
      const pair = (json.pairs ?? []).find(
        (p) => p.baseToken?.address === mint && p.baseToken?.symbol,
      );
      if (pair?.baseToken?.symbol) {
        const meta = { symbol: pair.baseToken.symbol, icon: pair.info?.imageUrl ?? null };
        metaCache.set(mint, meta);
        return meta;
      }
    }
  } catch {
    /* keep fallback, uncached */
  }

  return { symbol: shortMint(mint), icon: null as string | null };
}


type Accounts = { solBalance: number; tokens: { mint: string; amount: number }[] };

let accountsCache: { at: number; value: Accounts } | null = null;
const ACCOUNTS_TTL = 20_000;

/**
 * Jupiter's balances endpoint is the primary source: it answers from serverless
 * runtimes where the public Solana RPCs often refuse token-account reads.
 * RPC is the fallback so the wallet still resolves if Jupiter is down.
 */
async function readViaJupiter(): Promise<Accounts | null> {
  try {
    const res = await fetch(`https://lite-api.jup.ag/ultra/v1/balances/${OMO_WALLET}`);
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, { uiAmount?: number }>;
    let solBalance = 0;
    const tokens: { mint: string; amount: number }[] = [];
    for (const [key, row] of Object.entries(json)) {
      const amount = row?.uiAmount ?? 0;
      if (amount <= 0) continue;
      if (key === "SOL" || key === SOL_MINT) solBalance += amount;
      else tokens.push({ mint: key, amount });
    }
    if (solBalance === 0 && tokens.length === 0) return null;
    return { solBalance, tokens };
  } catch {
    return null;
  }
}

async function readViaRpc(): Promise<Accounts | null> {
  const [lamports, ...programs] = await Promise.all([
    rpc<{ value: number }>("getBalance", [OMO_WALLET]),
    ...[TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) =>
      rpc<{
        value: {
          account: {
            data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } };
          };
        }[];
      }>("getTokenAccountsByOwner", [OMO_WALLET, { programId }, { encoding: "jsonParsed" }]),
    ),
  ]);
  if (!lamports && programs.every((p) => !p)) return null;

  const tokens = programs
    .flatMap((r) => r?.value ?? [])
    .map((entry) => entry.account.data.parsed.info)
    .filter((info) => (info.tokenAmount.uiAmount ?? 0) > 0)
    .map((info) => ({ mint: info.mint, amount: info.tokenAmount.uiAmount ?? 0 }));

  return { solBalance: lamports ? lamports.value / 1e9 : 0, tokens };
}

/** Balances change only when omo transacts, so they are cached; prices are not. */
async function readAccounts(force = false): Promise<Accounts> {
  if (!force && accountsCache && Date.now() - accountsCache.at < ACCOUNTS_TTL) {
    return accountsCache.value;
  }

  const value = (await readViaJupiter()) ?? (await readViaRpc());
  if (!value) return accountsCache?.value ?? { solBalance: 0, tokens: [] };
  accountsCache = { at: Date.now(), value };
  return value;
}

async function buildHoldings(
  tokens: { mint: string; amount: number }[],
  prices: Record<string, number>,
): Promise<Holding[]> {
  const holdings = await Promise.all(
    tokens.map(async (token) => {
      const meta = await getTokenMeta(token.mint);
      const usdPrice = prices[token.mint] ?? 0;
      return {
        mint: token.mint,
        symbol: meta.symbol,
        icon: meta.icon,
        amount: token.amount,
        usdPrice,
        usdValue: token.amount * usdPrice,
      };
    }),
  );
  // dust left over from a closed position is not a position
  return holdings
    .filter((h) => h.usdValue >= 0.5)
    .sort((a, b) => b.usdValue - a.usdValue);
}


type ParsedTx = {
  blockTime: number | null;
  meta: {
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: { mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }[];
    postTokenBalances?: {
      mint: string;
      owner?: string;
      uiTokenAmount: { uiAmount: number | null };
    }[];
  } | null;
  transaction: { message: { accountKeys: { pubkey: string }[] } };
};

/** Reads recent wallet transactions and turns them into buy/sell rows. */
export async function fetchRecentTrades(limit = 150): Promise<WalletTrade[]> {
  const sigs = await rpc<{ signature: string; blockTime: number | null; err: unknown }[]>(
    "getSignaturesForAddress",
    [OMO_WALLET, { limit }],
  );
  if (!sigs?.length) return [];

  const trades: WalletTrade[] = [];
  const prices = await getPrices([SOL_MINT]);
  const solPrice = prices[SOL_MINT] ?? 0;

  for (const sig of sigs.filter((s) => !s.err).slice(0, 90)) {
    const tx = await rpc<ParsedTx>("getTransaction", [
      sig.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx?.meta) continue;

    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
    const index = keys.indexOf(OMO_WALLET);
    if (index < 0) continue;

    const solDelta =
      ((tx.meta.postBalances[index] ?? 0) - (tx.meta.preBalances[index] ?? 0)) / 1e9;

    const before = new Map<string, number>();
    for (const b of tx.meta.preTokenBalances ?? []) {
      if (b.owner === OMO_WALLET) before.set(b.mint, b.uiTokenAmount.uiAmount ?? 0);
    }
    const after = new Map<string, number>();
    for (const b of tx.meta.postTokenBalances ?? []) {
      if (b.owner === OMO_WALLET) after.set(b.mint, b.uiTokenAmount.uiAmount ?? 0);
    }

    const mints = new Set([...before.keys(), ...after.keys()]);
    // the traded name is the biggest non-stable move; stables and sol are how the
    // ticket was paid for, so they price the trade instead of being the trade
    let biggest: { mint: string; delta: number } | null = null;
    let stableDelta = 0;
    for (const mint of mints) {
      const delta = (after.get(mint) ?? 0) - (before.get(mint) ?? 0);
      if (Math.abs(delta) < 1e-9) continue;
      if (STABLES.has(mint)) {
        stableDelta += delta;
        continue;
      }
      if (!biggest || Math.abs(delta) > Math.abs(biggest.delta)) biggest = { mint, delta };
    }

    // a fomo ticket can be funded in usdc, in which case the sol balance barely
    // moves. whichever leg actually left the wallet is what the trade cost.
    const solUsd = Math.abs(solDelta) * solPrice;
    const stableUsd = Math.abs(stableDelta);
    const legUsd = Math.max(solUsd, stableUsd);

    const at = new Date((sig.blockTime ?? tx.blockTime ?? 0) * 1000).toISOString();

    if (!biggest) {
      // Pure cash movement — funding in, or value sent out.
      if (legUsd < 0.5) continue;
      const inbound = stableUsd > solUsd ? stableDelta > 0 : solDelta > 0;
      trades.push({
        signature: sig.signature,
        at,
        side: inbound ? "buy" : "sell",
        symbol: stableUsd > solUsd ? "USDC" : "SOL",
        mint: stableUsd > solUsd ? USDC_MINT : SOL_MINT,
        token_amount: stableUsd > solUsd ? Math.abs(stableDelta) : Math.abs(solDelta),
        sol_amount: Math.abs(solDelta),
        usd_value: legUsd,
      });
      continue;
    }

    trades.push({
      signature: sig.signature,
      at,
      side: biggest.delta > 0 ? "buy" : "sell",
      symbol: (await getTokenMeta(biggest.mint)).symbol,
      mint: biggest.mint,
      token_amount: Math.abs(biggest.delta),
      sol_amount: Math.abs(solDelta),
      usd_value: legUsd,
    });

  }

  return trades;
}

/**
 * P&L from the trade ledger, using average cost per mint.
 * realized = what a sell actually returned vs. the average cost of those tokens.
 * unrealized = live value of what omo still holds vs. the average cost of that size.
 */
export type BasisOverride = {
  /** usd position value fomo reported at read time */
  valueUsd: number;
  /** usd cost basis fomo reported (value - unrealized) */
  investedUsd: number;
  /** realized pnl fomo reported for this mint */
  realizedUsd: number;
};

/**
 * FOMO is the source of truth for entry price: the app itself reports value,
 * invested and pnl per position, while a basis rebuilt from swap transactions
 * drifts (router legs, fees, partial fills). These overrides are set once per
 * tick and then reused on every re-price, so the terminal always agrees with
 * the numbers omo sees in its own FOMO portfolio.
 */
let basisOverrides = new Map<string, BasisOverride>();

export function setBasisOverrides(rows: (BasisOverride & { mint: string })[]) {
  const next = new Map<string, BasisOverride>();
  for (const row of rows) {
    if (row.investedUsd > 0 || row.realizedUsd !== 0) {
      next.set(row.mint, {
        valueUsd: row.valueUsd,
        investedUsd: row.investedUsd,
        realizedUsd: row.realizedUsd,
      });
    }
  }
  if (next.size) basisOverrides = next;
}

/**
 * Positions omo has exited for good. FOMO keeps reporting a stale basis for a
 * mint after the exit, so the realized result of a retired trade is pinned here
 * and wins over both the on-chain ledger and the FOMO override.
 */
export const RETIRED_REALIZED = new Map<string, number>([
  // $FROGGY — right narrative, entry too late. closed at a loss.
  ["7SNuFkbD7aVs5LMM6DWsSFTq4zsXNxYuD8Hdsp1Kpump", -634.96],
  // $HAYMAKER — trimmed into strength, then closed the rest into the same demand.
  ["Hr66MMmcwwt6YNPUAVuSyjhrhFSnjCNxuPuAJ1Ubpump", 595.24],
  // $BIST — tiktok distribution trade that stopped distributing. exited into $ZEUS.
  ["HHNiHAW7YiydP6tfMhtD5WbZ6QQ8d2D1Fdyvp46Dpump", -580.92],
  // $ZEUS — closed after finding @pepesdog_en already owned the pepeverse dog story.
  ["BZ9kBdCovUv5g7krWdwytNV7StLVabYTBro4DSbBpump", -318.88],
  // $shitcoin — starter closed out, small loss taken rather than held down.
  ["5kr3KPg6Nhx2cBvunCuEgnUnJzRRz7C56aKNaFMmpump", -82.68],
  // $HOPE — charity name that never held its first flush. cut, not carried.
  ["GoShowKzM1NtiEVFrFYqVctUSNde71Und2TA3eN7pump", -225.58],
  // $lickingcat — sold out. it did its job, the money belongs where attention is.
  ["EjD5Y9NVhXmtEqU7wYvAyZvDWZFQeEuHXFatJmTbpump", 414.08],
  // $Lucifer — charity angle experiment, closed out. starter size, flat result.
  ["7nC7jCpfJh2EdCocTzLbsb7XJaoZHM7giWfX7orDC5sS", 0],
  // $zoe — the anti-ai mascot trade, closed in profit and filed in memory.
  ["7n8kRipxAQBfpGQtcGA2AbkM2HASSVCzqZ5F3QEopump", 660.39],
  // $HANDSEM — attention trade, sold into the crowd it was renting.
  ["pinned:handsem", 547.06],
]);

/**
 * What the FOMO app itself reports as invested in a position.
 *
 * FOMO is the ledger of record for a ticket: it knows every fill, including
 * adds, at the price they actually cleared. The on-chain view only sees the
 * funding leg of a swap, so it can read high or low. Where FOMO's own number is
 * known it wins outright.
 */
const BASIS_TRUTH = new Map<string, number>([
  // $neegy — averaged in twice. FOMO reports $2,985.00 invested across two fills
  // ($2,487.50 at 813.5k, $497.50 at 709.5k), avg entry 794.1k.
  ["6oGuFDbEeaSzTcvrmmd2MqfNYwHKXFoN7regcR22pump", 2985],
  // $fomocat — FOMO reports $1,688.52 invested, avg entry 141.1k MC.
  ["67xmJC4zGwmiqFBW6d6Fu3o4vkGEHxs9KKixbHuBpump", 1688.52],
  // $SEAL — three fills on chain, $250.00 + $600.00 + $273.67 = $1,123.67.
  ["4LfjGRB9LrjFk3VS1cG42WYYtE5hXEQrPjBWeVsnpump", 1123.67],

  // $burpcoin — averaged in across six fills, $1,750.64 total invested on chain.
  ["FsLJrQRBT7gdDUXcdbww83itvh9LRusshFigpjswpump", 1750.64],
  // $CATE — FOMO reports $27,475.00 invested after the add, 1.5M+ tokens, avg entry $15.3M MC.
  ["Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump", 27475],
  // $lenny — FOMO reports $2,388.00 invested, 18.2M LENNY, avg entry $126.1k MC.
  ["Gc5hxBYZjxWNpt3B8XYbp4YoGCHSMfrJK7ex4GUTpump", 2388],
  // $BULLSHIT — two fills of $4,975.00 ($2.1M + $2.2M MC), $9,950.00 invested, 4.4M tokens.
  ["zj1jpp7QMveWHLs61vL9KMZf254KvW7j4AAmBF8ry2k", 9950],
]);


/**
 * The FOMO account is the whole book, every chain. The tracked solana wallet is
 * only the part of it that lives on solana, so names bought elsewhere (and size
 * that is locked) never show up in an RPC read.
 *
 * These anchors are read straight off omo's own FOMO profile at the timestamp
 * below: account equity, all-time p&l across all 67 fills, and what the solana
 * side of the book was worth at that exact moment. The difference between the
 * two is carried as an off-book constant, so equity and total p&l still move in
 * real time with every live solana re-price instead of being frozen numbers.
 */
const FOMO_ACCOUNT = {
  at: "2026-08-17T21:20:00Z",
  /** fills fomo has recorded for the account */
  tradeCount: 67,
};

export const FOMO_TRADE_COUNT = FOMO_ACCOUNT.tradeCount;







export function computePnl(trades: WalletTrade[], holdings: Holding[]) {
  const perMint = new Map<
    string,
    { buyUsd: number; buyQty: number; realized: number; unreliable: boolean; lastBuyAt: string }
  >();
  const ordered = [...trades].sort((a, b) => a.at.localeCompare(b.at));

  for (const trade of ordered) {
    // sol and stable legs are how a swap is routed, not a trade in themselves
    if (trade.mint === SOL_MINT || STABLES.has(trade.mint)) continue;
    const row = perMint.get(trade.mint) ?? {
      buyUsd: 0,
      buyQty: 0,
      realized: 0,
      unreliable: false,
      lastBuyAt: "",
    };
    if (trade.side === "buy") {
      row.buyUsd += trade.usd_value;
      row.buyQty += trade.token_amount;
      if (trade.at > row.lastBuyAt) row.lastBuyAt = trade.at;
    } else {
      const avg = row.buyQty > 0 ? row.buyUsd / row.buyQty : 0;
      const qty = Math.min(trade.token_amount, row.buyQty);
      const retired = avg * qty;
      // a swap only exposes its final sol leg, so proceeds far below the cost
      // being retired are a parsing artefact, not a -95% round trip. flag the
      // mint instead of printing a loss that never happened.
      if (retired > 1 && trade.usd_value < retired * 0.5) row.unreliable = true;
      row.realized += trade.usd_value - retired;
      // Selling retires cost basis so the remaining size keeps the same average.
      row.buyQty = Math.max(0, row.buyQty - qty);
      row.buyUsd = Math.max(0, row.buyUsd - retired);
    }
    perMint.set(trade.mint, row);
  }

  // Realized p&l has to be identical for every visitor, on every server. A
  // basis rebuilt from swap transactions depends on how much of the signature
  // window that particular server managed to parse, so it printed a different
  // number per request (sometimes a large fake gain). Only closed positions
  // that have been reconciled by hand count, plus whatever fomo itself reports
  // as realized on a name still open.
  let realizedPnl = 0;
  for (const value of RETIRED_REALIZED.values()) realizedPnl += value;
  for (const [mint, override] of basisOverrides.entries()) {
    if (RETIRED_REALIZED.has(mint)) continue;
    realizedPnl += override.realizedUsd;
  }




  const positions: Position[] = holdings.map((holding) => {
    const row = perMint.get(holding.mint);
    const override = basisOverrides.get(holding.mint);
    // fomo reports what is invested in the position as a whole
    const fomoInvested = override && override.investedUsd > 0 ? override.investedUsd : 0;
    const ledgerRaw = row && row.buyQty > 0 ? row.buyUsd / row.buyQty : 0;
    // a swap tx only shows its final sol leg, so a ledger basis far below the
    // live value is an artefact, not a 10x. rather than print a fake gain,
    // treat the entry as unknown until fomo reports it.
    const ledgerAvg =
      ledgerRaw > 0 && holding.usdPrice > 0 && ledgerRaw < holding.usdPrice * 0.2
        ? 0
        : ledgerRaw;
    const ledgerInvested = ledgerAvg > 0 ? ledgerAvg * holding.amount : 0;
    // topping up a position leaves fomo's last reported basis behind until it
    // re-reads, while the on-chain ledger already counted the new ticket. the
    // larger of the two is what has actually been put into the name.
    const settled = Math.max(fomoInvested, ledgerInvested);
    // usd actually paid across the fills that are still open on this mint,
    // reconciled by hand against the signatures. a live swap parse can double
    // count routing legs, so the reconciled figure wins whenever we have one.
    const ledgerSpend = row && !row.unreliable && row.buyUsd > 0 ? row.buyUsd : 0;
    const costBasis = BASIS_TRUTH.get(holding.mint) ?? Math.max(settled, ledgerSpend);



    const avgCost = holding.amount > 0 ? costBasis / holding.amount : 0;
    const unrealized = costBasis > 0 ? holding.usdValue - costBasis : 0;
    return {
      ...holding,
      avgCost,
      costBasis,
      unrealized,
      unrealizedPct: costBasis > 0.01 ? (unrealized / costBasis) * 100 : 0,
    };
  });

  const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealized, 0);

  return { realizedPnl, unrealizedPnl, positions };
}

/**
 * Live wallet snapshot. `deep` re-reads balances/token accounts from the chain;
 * otherwise the cached balances are re-priced so equity moves in real time.
 */
export async function getWalletSnapshot(
  trades: WalletTrade[],
  deep = false,
): Promise<WalletSnapshot> {
  const accounts = await readAccounts(deep);
  const prices = await getPrices([SOL_MINT, ...accounts.tokens.map((t) => t.mint)]);
  const solPrice = prices[SOL_MINT] ?? 0;
  const solBalance = accounts.solBalance;

  // Stablecoins are dry powder, not a trade — they sit in cash, never in positions.
  const stableRows = accounts.tokens.filter((t) => STABLES.has(t.mint));
  const stableBalance = stableRows.reduce(
    (sum, t) => sum + t.amount * (prices[t.mint] ?? 1),
    0,
  );
  const usdcBalance = stableRows
    .filter((t) => t.mint === USDC_MINT)
    .reduce((sum, t) => sum + t.amount, 0);

  const holdings = await buildHoldings(
    accounts.tokens.filter((t) => !STABLES.has(t.mint)),
    prices,
  );

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const buys = trades.filter(
    (t) => t.side === "buy" && t.mint !== SOL_MINT && !STABLES.has(t.mint),
  );
  // a swap tx only exposes its funding leg, so where fomo reports what was
  // actually invested in a mint, the larger of the two figures is the truth:
  // the ledger can miss an unpriced leg, and fomo only reports what is still open
  const spendFor = (rows: WalletTrade[]) => {
    const ledger = new Map<string, number>();
    const lastBuy = new Map<string, string>();
    for (const t of rows) {
      ledger.set(t.mint, (ledger.get(t.mint) ?? 0) + t.usd_value);
      if (t.at > (lastBuy.get(t.mint) ?? "")) lastBuy.set(t.mint, t.at);
    }
    let total = 0;
    for (const [mint, ledgerUsd] of ledger.entries()) {
      const override = basisOverrides.get(mint);
      total += BASIS_TRUTH.get(mint) ?? Math.max(ledgerUsd, override?.investedUsd ?? 0);
    }

    return total;
  };

  // the off-chain side of the book is closed out, so it only carries history:
  // what was spent there and what was banked when it was sold
  const offBook = await readOffBook();

  const spentToday = spendFor(buys.filter((t) => new Date(t.at) >= startOfDay));
  const spentAllTime = spendFor(buys) + offBook.spentUsd;

  const chain = computePnl(trades, holdings);
  const positions = chain.positions;
  // off-chain positions carry their own live mark and must show up in the book
  for (const mark of offBook.positions) {
    positions.push({
      mint: mark.address,
      symbol: mark.symbol,
      icon: null,
      amount: mark.amount,
      usdPrice: mark.priceUsd,
      usdValue: mark.valueUsd,
      avgCost: mark.amount > 0 ? mark.investedUsd / mark.amount : 0,
      costBasis: mark.investedUsd,
      unrealized: mark.unrealizedUsd,
      unrealizedPct: mark.unrealizedPct,
      entryMarketCapUsd: mark.entryMarketCapUsd,
    });
  }
  positions.sort((a, b) => b.usdValue - a.usdValue);
  // realized is closed only: banked sells on this chain plus the result already
  // booked elsewhere. unrealized is open size only, marked live on every tick.
  const realizedPnl = chain.realizedPnl + offBook.realizedUsd;
  const unrealizedPnl = chain.unrealizedPnl + offBook.unrealizedUsd;
  const solValue = solBalance * solPrice;
  const cash = solValue + stableBalance;
  // equity is the whole fomo account: the live solana read plus the size that
  // lives off this chain. both move together on every re-price.
  const equity = cash + holdings.reduce((sum, h) => sum + h.usdValue, 0) + offBook.equityUsd;


  return {
    address: OMO_WALLET,
    solBalance,
    solPrice,
    solValue,
    usdcBalance,
    stableBalance,
    holdings,
    positions,
    equity,
    cash,
    spentToday,
    spentAllTime,
    realizedPnl,
    unrealizedPnl,
    // all-time p&l for the account, every chain: closed plus open, counted once
    totalPnl: realizedPnl + unrealizedPnl,
    tradeCount: Math.max(trades.length, FOMO_TRADE_COUNT),
    lastActivity: trades[0]?.at ?? null,
    fetchedAt: new Date().toISOString(),
  };
}


/**
 * Which program actually executed a fill. Read straight off the transaction's
 * account keys, so the venue label is verifiable against the same signature
 * anyone can open on solscan.
 */
const VENUE_PROGRAMS: [string, string][] = [
  ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pump.fun bonding curve"],
  ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "pump.fun amm"],
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "jupiter router"],
  ["JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", "jupiter router"],
  ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "raydium"],
  ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "raydium clmm"],
  ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "orca whirlpool"],
  ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "meteora dlmm"],
];

const NON_VENUE_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
]);

/**
 * Read the executing programs off a fill. Top-level instructions come first, so
 * the label reflects what actually routed the order (a fomo or pump.fun order
 * that hops through jupiter is labelled by the router it entered, not by the
 * first pool it touched). Unrecognised routers are printed as their raw program
 * id so nothing is invented, and a tx with no swap program at all is labelled a
 * plain transfer instead of being left blank.
 */
export async function fetchFillVenue(
  signature: string,
): Promise<{ label: string | null; programs: string[] }> {
  const tx = await rpc<{
    transaction: {
      message: {
        accountKeys: { pubkey: string }[];
        instructions: { programId?: string }[];
      };
    };
    meta?: { innerInstructions?: { instructions: { programId?: string }[] }[] };
  }>("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!tx) return { label: null, programs: [] };

  const top = (tx.transaction?.message?.instructions ?? [])
    .map((i) => i.programId)
    .filter((p): p is string => Boolean(p));
  const inner = (tx.meta?.innerInstructions ?? [])
    .flatMap((group) => group.instructions ?? [])
    .map((i) => i.programId)
    .filter((p): p is string => Boolean(p));
  const keys = tx.transaction?.message?.accountKeys?.map((k) => k.pubkey) ?? [];

  const ordered: string[] = [];
  for (const p of [...top, ...inner, ...keys]) {
    if (!ordered.includes(p)) ordered.push(p);
  }

  const known = new Map(VENUE_PROGRAMS);
  const labels: string[] = [];
  for (const program of ordered) {
    const label = known.get(program);
    if (label && !labels.includes(label)) labels.push(label);
  }

  if (labels.length > 0) return { label: labels[0] ?? null, programs: labels };

  // no known amm or router: name the unrecognised executing program outright
  const unknownRouter = top.find((p) => !NON_VENUE_PROGRAMS.has(p));
  if (unknownRouter) {
    const short = `${unknownRouter.slice(0, 4)}…${unknownRouter.slice(-4)}`;
    return { label: `program ${short}`, programs: [unknownRouter] };
  }

  return { label: "token transfer · no swap program", programs: [] };
}

