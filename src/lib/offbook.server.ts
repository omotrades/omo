/**
 * The part of omo's FOMO book that does not live on the tracked solana wallet.
 *
 * $BASECAT was the first off-chain experiment. It is now closed. $TUDOU is the
 * current open off-chain position: a BNB token held through the FOMO app, marked
 * here so the live terminal shows the same value, invested, pnl and entry mc
 * that FOMO reports for the account.
 */

/** usd paid into the closed off-chain side of the book ($BASECAT, two fills) */
const OFF_BOOK_SPENT = 11_497;

/**
 * Off-book pnl actually banked: the closed $BASECAT result (+$3,490.14).
 * Only closed size counts here. Open or locked gains elsewhere in the account
 * are unrealized and must never be folded into this number.
 */
const OFF_BOOK_REALIZED_BANKED = 3_490.14;

export type OffBookMark = {
  symbol: string;
  chain: string;
  address: string;
  amount: number;
  priceUsd: number;
  marketCapUsd: number;
  /** market cap at the position's average entry, as reported by fomo */
  entryMarketCapUsd: number;
  valueUsd: number;
  investedUsd: number;
  unrealizedUsd: number;
  unrealizedPct: number;
  at: string;
};

export type OffBook = {
  /** live value of every off-chain position */
  equityUsd: number;
  /** usd paid for that size */
  spentUsd: number;
  /** open pnl on the off-chain side, marked live */
  unrealizedUsd: number;
  /** closed pnl earned off this chain */
  realizedUsd: number;
  positions: OffBookMark[];
};

/**
 * $TUDOU — 土豆 — the short spine dog on BNB.
 * Read straight off the FOMO position card: value, invested, unrealized, avg
 * entry market cap and token amount. These numbers anchor the live terminal so
 * the book panel matches the profile exactly.
 */
const TUDOU: OffBookMark = {
  symbol: "土豆",
  chain: "bnb",
  address: "0xf21b89ab0173959d7f88792e924b86843d3a7777",
  amount: 10_300_000,
  priceUsd: 4_385.46 / 10_300_000,
  marketCapUsd: 422_300,
  entryMarketCapUsd: 382_000,
  valueUsd: 4_385.46,
  investedUsd: 3_967.02,
  unrealizedUsd: 418.44,
  unrealizedPct: 10.55,
  at: new Date().toISOString(),
};

/**
 * $RICE — the second act on BNB. Numbers read straight off the FOMO card and
 * then re-priced live on every read.
 */
const RICE: OffBookMark = {
  symbol: "RICE",
  chain: "bnb",
  address: "0xb5761f36fdfe2892f1b54bc8ee8babb2a1b698d3",
  amount: 570_800,
  priceUsd: 4_362.2 / 570_800,
  marketCapUsd: 7_600_000,
  entryMarketCapUsd: 8_600_000,
  valueUsd: 4_362.2,
  investedUsd: 4_958.76,
  unrealizedUsd: -596.55,
  unrealizedPct: -12.03,
  at: new Date().toISOString(),
};

/**
 * 超人 — Unitree humanoid robot on BNB. 24.2M tokens filled for $2,975.24.
 * Size is known, so this re-prices live off dexscreener every read.
 */
const SUPERMAN: OffBookMark = {
  symbol: "超人",
  chain: "bnb",
  address: "0x12a0c0f5e4c09b426bb06b0f0f1f876fa8e47777",
  amount: 24_200_000,
  priceUsd: 3_562.49 / 24_200_000,
  marketCapUsd: 147_000,
  entryMarketCapUsd: 122_800,
  valueUsd: 3_562.49,
  investedUsd: 3_475.24,
  unrealizedUsd: 87.25,
  unrealizedPct: 2.51,
  at: new Date().toISOString(),
};

/**
 * 佑宝 — first korea-china hybrid panda cub, sibling of fubao. 25.1M tokens
 * filled for $1,266.41. Size is known, so this re-prices live off dexscreener.
 */
const YOUBAO: OffBookMark = {
  symbol: "佑宝",
  chain: "bnb",
  address: "0x4436cf73fa2bf942371f3d068ad3d90a9aa57777",
  amount: 25_100_000,
  priceUsd: 1_583.50 / 25_100_000,
  marketCapUsd: 62_900,
  entryMarketCapUsd: 50_300,
  valueUsd: 1_583.50,
  investedUsd: 1_266.41,
  unrealizedUsd: 317.09,
  unrealizedPct: 25.04,
  at: new Date().toISOString(),
};

/**
 * $HODL — the hold-to-earn coin. 22.9M tokens marked at $834.26 with $2.27 open.
 * Size is known, so this re-prices live off dexscreener every read.
 */
const HODL: OffBookMark = {
  symbol: "HODL",
  chain: "robinhood",
  address: "0x15c2027712ce12ea07df7f80deb41d628501cee4",
  amount: 22_900_000,
  priceUsd: 834.26 / 22_900_000,
  marketCapUsd: 27_900,
  entryMarketCapUsd: 27_800,
  valueUsd: 834.26,
  investedUsd: 831.99,
  unrealizedUsd: 2.27,
  unrealizedPct: 0.27,
  at: new Date().toISOString(),
};


function rollUp(positions: OffBookMark[]): OffBook {
  return {
    equityUsd: positions.reduce((s, p) => s + p.valueUsd, 0),
    spentUsd: OFF_BOOK_SPENT + positions.reduce((s, p) => s + p.investedUsd, 0),
    unrealizedUsd: positions.reduce((s, p) => s + p.unrealizedUsd, 0),
    realizedUsd: OFF_BOOK_REALIZED_BANKED,
    positions,
  };
}

/** Closed off-chain positions. Kept for the log, not rolled into live equity. */
const OFF_BOOK_ARCHIVE: OffBookMark[] = [RICE, SUPERMAN];

const DEFAULT_OFF_BOOK: OffBook = rollUp([TUDOU, YOUBAO, HODL]);

let lastOffBook: OffBook = DEFAULT_OFF_BOOK;
let lastFetchedAt = 0;
/** live reads are cheap but not free; one read per 20s is enough to look alive */
const OFF_BOOK_TTL_MS = 20_000;

/**
 * Re-price every open off-chain position against dexscreener so value, pnl and
 * pnl % move in real time instead of sitting on the numbers typed in above.
 * The typed numbers stay as the fallback when a read fails.
 */
async function repriceLive(mark: OffBookMark): Promise<OffBookMark> {
  if (mark.amount <= 0) return mark;
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mark.address}`,
    );
    if (!res.ok) return mark;
    const json = (await res.json()) as {
      pairs?: Array<{
        priceUsd?: string;
        marketCap?: number;
        fdv?: number;
        liquidity?: { usd?: number };
      }>;
    };
    const pair = (json.pairs ?? [])
      .slice()
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const priceUsd = Number(pair?.priceUsd ?? 0);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return mark;

    const valueUsd = mark.amount * priceUsd;
    const unrealizedUsd = valueUsd - mark.investedUsd;
    return {
      ...mark,
      priceUsd,
      marketCapUsd: pair?.marketCap ?? pair?.fdv ?? mark.marketCapUsd,
      valueUsd,
      unrealizedUsd,
      unrealizedPct:
        mark.investedUsd > 0 ? (unrealizedUsd / mark.investedUsd) * 100 : 0,
      at: new Date().toISOString(),
    };
  } catch {
    return mark;
  }
}

export async function readOffBook(): Promise<OffBook> {
  const now = Date.now();
  if (now - lastFetchedAt < OFF_BOOK_TTL_MS) return lastOffBook;
  lastFetchedAt = now;
  try {
    const positions = await Promise.all([TUDOU, YOUBAO, HODL].map(repriceLive));
    lastOffBook = rollUp(positions);
  } catch {
    lastOffBook = DEFAULT_OFF_BOOK;
  }
  return lastOffBook;
}

/** Synchronous lookup used while stitching live marks into thesis rows. */
export function lastOffBookMark(symbol: string): OffBookMark | null {
  return lastOffBook?.positions.find((p) => p.symbol === symbol) ?? null;
}
