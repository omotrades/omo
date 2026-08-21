/** Live solana memecoin scanner — real pair data omo reasons over. */

import { isBlockedSymbol } from "./blocklist";

export type MemeCandidate = {
  symbol: string;
  name: string;
  mint: string;
  url: string;
  priceUsd: number;
  liquidityUsd: number;
  fdv: number;
  vol24h: number;
  vol1h: number;
  chg5m: number;
  chg1h: number;
  chg6h: number;
  chg24h: number;
  buys1h: number;
  sells1h: number;
  ageHours: number;
  boosted: boolean;
  socials: string[];
  hasSite: boolean;
  /** has a real public presence: named socials plus a site, and a tape that lasted */
  real: boolean;
};

/** Deeper per-token pull omo runs on the names it actually cares about. */
export type TokenResearch = {
  symbol: string;
  mint: string;
  pools: number;
  totalLiquidityUsd: number;
  topPoolShare: number;
  vol6h: number;
  buys6h: number;
  sells6h: number;
  chg6h: number;
  socials: string[];
  hasSite: boolean;
  boosted: boolean;
};

type Pair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairCreatedAt?: number;
  priceUsd?: string;
  fdv?: number;
  baseToken?: { address?: string; name?: string; symbol?: string };
  liquidity?: { usd?: number };
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  txns?: Record<string, { buys?: number; sells?: number }>;
  info?: { websites?: { url?: string }[]; socials?: { type?: string; url?: string }[] };
};

/** Rotated every tick so the flow omo grades keeps turning over. */
const QUERY_POOL = [
  "SOL pump",
  "SOL bonk",
  "SOL cat",
  "SOL dog",
  "SOL raydium",
  "SOL meteora",
  "SOL frog",
  "SOL moon",
  "SOL ai",
  "SOL coin",
  "SOL pepe",
  "SOL wif",
  "SOL baby",
  "SOL trump",
  "SOL bird",
  "SOL fomo",
  "SOL inu",
  "SOL fish",
  "SOL bear",
  "SOL bull",
  "SOL chill",
  "SOL wojak",
  "SOL grok",
  "SOL agent",
  "SOL mascot",
  "SOL king",
  "SOL goat",
  "SOL monkey",
  "SOL duck",
  "SOL sigma",
  "SOL retard",
  "SOL gme",
  "SOL usa",
  "SOL elon",
  "SOL pengu",
  "SOL launch",
  // names that tend to have real people, real accounts and a public team behind them
  "SOL community",
  "SOL dao",
  "SOL team",
  "SOL founder",
  "SOL protocol",
  "SOL app",
  "SOL creator",
  "SOL streamer",
  "SOL artist",
  "SOL brand",
];

function rotatedQueries(rotation: number, count = 5) {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(QUERY_POOL[(rotation * count + i) % QUERY_POOL.length] as string);
  }
  return out.map(
    (q) => `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
  );
}

const BOOSTS = "https://api.dexscreener.com/token-boosts/top/v1";
const LATEST_BOOSTS = "https://api.dexscreener.com/token-boosts/latest/v1";
const NEW_PROFILES = "https://api.dexscreener.com/token-profiles/latest/v1";


const STABLE = /^(usdc|usdt|sol|wsol|jup|jto|ray|bonk|wif|pyusd|msol|jitosol)$/i;

async function json<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": "omo/1.0" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function socialsOf(pair: Pair) {
  return (pair.info?.socials ?? [])
    .map((x) => (x.type ?? "").toLowerCase())
    .filter(Boolean)
    .slice(0, 4);
}

/**
 * Manufactured charts.
 *
 * A wash-traded pair prints a headline hour of volume that its own depth could
 * never absorb, and it does it in a handful of enormous round-trips instead of
 * a crowd of small ones. Nothing said about a tape like that is worth saying,
 * so these rows never reach the reasoning at all.
 */
function isFakeChart(pair: Pair, liq: number, ageHours = 0): boolean {
  const vol1h = pair.volume?.["h1"] ?? 0;
  const vol5m = pair.volume?.["m5"] ?? 0;
  const vol6h = pair.volume?.["h6"] ?? 0;
  const vol24h = pair.volume?.["h24"] ?? 0;
  const buys = pair.txns?.["h1"]?.buys ?? 0;
  const sells = pair.txns?.["h1"]?.sells ?? 0;
  const trades = buys + sells;
  const chg1h = pair.priceChange?.["h1"] ?? 0;
  const chg6h = pair.priceChange?.["h6"] ?? 0;
  const chg24h = pair.priceChange?.["h24"] ?? 0;
  const fdv = pair.fdv ?? 0;

  // Fees paid is the honest receipt on a chart. Real turnover leaves fees behind,
  // so a float that has barely generated any fee over its whole life was never
  // traded by a crowd: the price was walked, not bought. Estimated from traded
  // volume at roughly the standard swap fee.
  const lifeVol = ageHours > 0 && ageHours < 24 ? vol24h : Math.max(vol24h, vol6h * 4);
  const feesUsd = lifeVol * 0.005;
  if (ageHours > 0 && ageHours < 72 && fdv > 0 && feesUsd < fdv * 0.03) return true;
  // a fresh launch carrying a small float and almost no fees is not worth a word
  if (ageHours > 0 && ageHours < 24 && fdv < 150_000 && feesUsd < 2_000) return true;

  // an hour cannot really turn over its own depth twenty times
  if (liq > 0 && vol1h > liq * 20) return true;
  if (liq > 0 && vol24h > liq * 150) return true;

  // volume with almost nobody behind it, or an average ticket no real
  // participant in a pool this thin would ever send
  if (vol1h > 50_000 && trades < 60) return true;
  if (trades > 0 && vol1h / trades > 2_500 && liq < 150_000) return true;
  // one-sided by construction: bots loop, crowds do not
  if (trades > 40 && (buys === 0 || sells === 0)) return true;

  // Charts nothing intelligent can be said about: a straight bleed off the top.
  // Anything already down hard on every window is a distribution corpse, and
  // grading it out loud reads as noise.
  if (chg1h < -25 && chg6h < -40) return true;
  if (chg24h < -55 && chg6h < -20) return true;
  // dead tape: the pool is still there but nobody is trading it any more
  if (liq > 0 && vol1h < liq * 0.15 && vol24h < liq * 3) return true;
  if (vol5m === 0 && vol1h < 5_000) return true;
  // headline day, empty present: whatever happened here is over
  if (vol24h > 0 && vol6h / vol24h < 0.06) return true;
  // paper float on a sliver of real depth
  if (liq > 0 && fdv > 0 && fdv / liq > 30) return true;
  return false;
}

/**
 * A young name is allowed on the board while it is still being traded. The
 * moment its flow fades it stops being a candidate and is simply forgotten:
 * no thesis, no verdict, no tracking of a corpse.
 */
function newbornFaded(pair: Pair, ageHours: number): boolean {
  if (!(ageHours > 0 && ageHours < 24)) return false;
  const vol1h = pair.volume?.["h1"] ?? 0;
  const vol5m = pair.volume?.["m5"] ?? 0;
  const vol24h = pair.volume?.["h24"] ?? 0;
  const trades = (pair.txns?.["h1"]?.buys ?? 0) + (pair.txns?.["h1"]?.sells ?? 0);
  // the launch hours are the loud hours: nothing this young should be quiet
  if (vol1h < 8_000) return true;
  if (vol5m < 500) return true;
  if (trades < 60) return true;
  // most of the day's volume already happened and the present is thin
  if (vol24h > 0 && vol1h / vol24h < 0.05) return true;
  return false;
}



function toCandidate(pair: Pair, boostedMints = new Set<string>()): MemeCandidate | null {
  if (pair.chainId !== "solana") return null;
  const symbol = pair.baseToken?.symbol?.trim();
  const mint = pair.baseToken?.address;
  const price = Number(pair.priceUsd);
  if (!symbol || !mint || !Number.isFinite(price) || price <= 0) return null;
  if (STABLE.test(symbol)) return null;
  if (isBlockedSymbol(symbol) || isBlockedSymbol(pair.baseToken?.name)) return null;
  const liq = pair.liquidity?.usd ?? 0;
  const created = pair.pairCreatedAt ?? 0;
  const ageHours = created ? Math.max(0, (Date.now() - created) / 3_600_000) : 0;
  // brand new launches get a lower depth floor so omo actually sees them early
  if (liq < (ageHours > 0 && ageHours < 24 ? 6_000 : 15_000)) return null;
  if (isFakeChart(pair, liq, ageHours)) return null;
  // a young name that has already gone quiet is forgotten rather than tracked
  if (newbornFaded(pair, ageHours)) return null;
  const socials = socialsOf(pair);
  const hasSite = !!pair.info?.websites?.length;
  // nothing anonymous reaches the reasoning: every row has a public account or
  // a site behind it, so omo is never forming an opinion on a ghost
  if (!socials.length && !hasSite) return null;

  const vol1h = pair.volume?.["h1"] ?? 0;
  const vol24h = pair.volume?.["h24"] ?? 0;
  const buys = pair.txns?.["h1"]?.buys ?? 0;
  const sells = pair.txns?.["h1"]?.sells ?? 0;
  // "real" = there are actual people attached to it, and the tape has survived
  // long enough to be more than a launch candle: a named account plus either a
  // site or a second social, depth that can absorb a real ticket, a crowd of
  // traders rather than a handful, and volume still alive today.
  const real =
    socials.includes("twitter") &&
    (hasSite || socials.length >= 2) &&
    liq >= 40_000 &&
    vol24h >= 150_000 &&
    vol1h >= 15_000 &&
    buys + sells >= 250 &&
    ageHours >= 6;
  return {
    symbol,
    name: pair.baseToken?.name?.trim() || symbol,
    mint,
    url: pair.url ?? `https://dexscreener.com/solana/${mint}`,
    priceUsd: price,
    liquidityUsd: liq,
    fdv: pair.fdv ?? 0,
    vol24h: pair.volume?.["h24"] ?? 0,
    vol1h: pair.volume?.["h1"] ?? 0,
    chg5m: pair.priceChange?.["m5"] ?? 0,
    chg1h: pair.priceChange?.["h1"] ?? 0,
    chg6h: pair.priceChange?.["h6"] ?? 0,
    chg24h: pair.priceChange?.["h24"] ?? 0,
    buys1h: pair.txns?.["h1"]?.buys ?? 0,
    sells1h: pair.txns?.["h1"]?.sells ?? 0,
    ageHours,
    real,
    boosted: boostedMints.has(mint),
    socials: socialsOf(pair),
    hasSite: (pair.info?.websites ?? []).length > 0,
  };
}

async function pairsForMints(mints: string[]) {
  if (!mints.length) return [] as Pair[];
  const batches: string[][] = [];
  for (let i = 0; i < mints.length; i += 25) batches.push(mints.slice(i, i + 25));
  const res = await Promise.all(
    batches.map((b) =>
      json<{ pairs?: Pair[] }>(`https://api.dexscreener.com/latest/dex/tokens/${b.join(",")}`),
    ),
  );
  return res.flatMap((r) => r?.pairs ?? []);
}

/** Pulls trending / boosted / freshly launched solana memecoins with live pair metrics. */
export async function scanMemecoins(rotation = 0): Promise<MemeCandidate[]> {
  const [searched, topBoosts, latestBoosts, profiles] = await Promise.all([
    Promise.all(rotatedQueries(rotation).map((url) => json<{ pairs?: Pair[] }>(url))),
    json<{ chainId?: string; tokenAddress?: string }[]>(BOOSTS),
    json<{ chainId?: string; tokenAddress?: string }[]>(LATEST_BOOSTS),
    json<{ chainId?: string; tokenAddress?: string }[]>(NEW_PROFILES),
  ]);

  const solMints = (rows: { chainId?: string; tokenAddress?: string }[] | null, take: number) => [
    ...new Set(
      (rows ?? [])
        .filter((b) => b.chainId === "solana" && b.tokenAddress)
        .slice(0, take)
        .map((b) => b.tokenAddress as string),
    ),
  ];

  const boostMints = solMints(topBoosts, 25);
  // latest boosts + latest token profiles are where brand new names show up first
  const freshMints = [...new Set([...solMints(latestBoosts, 30), ...solMints(profiles, 30)])].filter(
    (m) => !boostMints.includes(m),
  );

  const [boostPairs, freshPairs] = await Promise.all([
    pairsForMints(boostMints),
    pairsForMints(freshMints),
  ]);

  const pairs = [...boostPairs, ...freshPairs, ...searched.flatMap((r) => r?.pairs ?? [])];
  const boostedSet = new Set([...boostMints, ...solMints(latestBoosts, 30)]);

  const best = new Map<string, MemeCandidate>();
  for (const pair of pairs) {
    const candidate = toCandidate(pair, boostedSet);
    if (!candidate) continue;
    const prev = best.get(candidate.mint);
    if (!prev || candidate.liquidityUsd > prev.liquidityUsd) best.set(candidate.mint, candidate);
  }

  const all = [...best.values()];
  const byFlow = [...all].sort((a, b) => b.vol1h - a.vol1h);
  const board: MemeCandidate[] = [];
  const seen = new Set<string>();
  const push = (c?: MemeCandidate) => {
    if (!c || seen.has(c.mint)) return;
    seen.add(c.mint);
    board.push(c);
  };

  // 1. real projects first: names with a public account, a site and a tape that
  // survived the day. These are what omo should be forming theses on, so they
  // get guaranteed slots ahead of anonymous launch noise.
  all
    .filter((c) => c.real)
    .sort((a, b) => b.vol24h - a.vol24h)
    .slice(0, 5)
    .forEach(push);

  // 2. keep the leaders visible, but do not let the same leaders occupy half the board
  byFlow.slice(0, 4).forEach(push);

  // 3. always carry newborns (<24h) with real volume, ranked by flow
  all
    .filter(
      (c) =>
        c.ageHours > 0 &&
        c.ageHours < 24 &&
        c.vol1h > 5_000 &&
        // a newborn is only worth looking at if someone has put their name on it
        (c.socials.includes("twitter") || c.hasSite),
    )
    .sort((a, b) => b.vol1h - a.vol1h)
    .slice(0, 3)
    .forEach(push);

  // 4. movers on the 1h that flow ranking may have buried
  all
    .filter((c) => c.vol1h > 10_000)
    .sort((a, b) => b.chg1h - a.chg1h)
    .slice(0, 2)
    .forEach(push);

  // 5. reserve five actual slots for deeper rows. Previously these were appended
  // after the board was already near its 14-row limit, so slice(0, 14) quietly
  // removed most of the intended rotation.
  const rest = byFlow.filter((c) => !seen.has(c.mint));
  if (rest.length) {
    const start = (rotation * 5) % rest.length;
    for (let i = 0; i < Math.min(5, rest.length); i += 1) {
      push(rest[(start + i) % rest.length]);
    }
  }

  // Fill any spare slots without changing the guaranteed rotating allocation.
  byFlow.forEach(push);

  return board.slice(0, 16);
}


/** Real second-pass research on one mint: every pool, deeper windows, socials. */
export async function researchToken(mint: string, symbol: string): Promise<TokenResearch | null> {
  const res = await json<{ pairs?: Pair[] }>(
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
  );
  const pairs = (res?.pairs ?? []).filter((p) => p.chainId === "solana");
  if (!pairs.length) return null;
  const totalLiq = pairs.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0);
  const top = pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
  return {
    symbol: symbol.replace(/^\$/, ""),
    mint,
    pools: pairs.length,
    totalLiquidityUsd: totalLiq,
    topPoolShare: totalLiq > 0 ? (top.liquidity?.usd ?? 0) / totalLiq : 1,
    vol6h: pairs.reduce((sum, p) => sum + (p.volume?.["h6"] ?? 0), 0),
    buys6h: pairs.reduce((sum, p) => sum + (p.txns?.["h6"]?.buys ?? 0), 0),
    sells6h: pairs.reduce((sum, p) => sum + (p.txns?.["h6"]?.sells ?? 0), 0),
    chg6h: top.priceChange?.["h6"] ?? 0,
    socials: socialsOf(top),
    hasSite: (top.info?.websites ?? []).length > 0,
    boosted: false,
  };
}

export function describeResearch(r: TokenResearch) {
  const money = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}m` : `$${Math.round(n / 1_000)}k`;
  const pressure6h =
    r.buys6h > r.sells6h * 1.15
      ? "buyers still in front over the 6h"
      : r.sells6h > r.buys6h * 1.15
        ? "sellers in front over the 6h"
        : "two-sided, nobody leading over the 6h";
  return `$${r.symbol}: 6h vol ${money(r.vol6h)}, ${pressure6h}, 6h ${r.chg6h >= 0 ? "+" : ""}${r.chg6h.toFixed(1)}%, ${r.socials.length ? `socials: ${r.socials.join("/")}` : "no socials listed"}, ${r.hasSite ? "has a site" : "no site"}`;
}

export function describeCandidate(c: MemeCandidate) {
  const money = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}m` : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}k` : `$${n.toFixed(0)}`;
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  const age =
    c.ageHours >= 24 ? `${(c.ageHours / 24).toFixed(1)}d old` : `${c.ageHours.toFixed(1)}h old`;
  const extra = `${c.real ? ", REAL PROJECT (public account, site, day-long tape)" : ""}${c.boosted ? ", paid boost active" : ""}${c.socials.length ? `, socials ${c.socials.join("/")}` : ", no socials"}`;
  const pressure =
    c.buys1h > c.sells1h * 1.15
      ? "buyers leading the hour"
      : c.sells1h > c.buys1h * 1.15
        ? "sellers leading the hour"
        : "two-sided hour, nobody leading";
  return `$${c.symbol} (${c.name}) — vol 1h ${money(c.vol1h)} / 24h ${money(c.vol24h)}, ${pct(c.chg5m)} 5m ${pct(c.chg1h)} 1h ${pct(c.chg6h)} 6h ${pct(c.chg24h)} 24h, ${pressure}, ${age}${extra}, mint ${c.mint}`;
}
