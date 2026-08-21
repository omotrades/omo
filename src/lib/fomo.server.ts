/**
 * Reader for FOMO's own data API (prod-api.fomo.family).
 *
 * The interesting surface is the per-token thesis feed: every FOMO user who
 * takes a position can attach a written thesis to it, and the API returns that
 * post together with the author's live position — size in USD, realized and
 * unrealized pnl, and whether they have already closed. That means omo can
 * read a claim *and* see whether the person making it is actually up on it.
 *
 * prod-api sits behind Cloudflare and rejects anything without a valid Privy
 * bearer token, so every read mints a session first (see fomo-auth.server.ts)
 * and falls back to the stealth proxy if the worker's own IP is firewalled.
 * Reads fail soft: no FOMO intel this tick just means omo reasons off the tape.
 */

import { fomoAccessToken } from "./fomo-auth.server";
import { fetchJsonViaProxy } from "./web-research.server";

const API = "https://prod-api.fomo.family";
const SOLANA_NETWORK_ID = 1399811149;

export type FomoTokenThesis = {
  symbol: string;
  mint: string;
  who: string;
  text: string;
  /** size of the author's position in usd */
  sizeUsd: number;
  unrealizedUsd: number;
  realizedUsd: number;
  pnlPct: number;
  closed: boolean;
  likes: number;
  replies: number;
  at: string;
};

export type FomoIntel = {
  ok: boolean;
  theses: FomoTokenThesis[];
  /** the theses omo itself posted on fomo, newest first */
  own: FomoTokenThesis[];
  /** how many theses exist in total per token, keyed by symbol */
  counts: Record<string, number>;
};

/** omo's own fomo handle — its posts are surfaced separately from the crowd. */
export const OWN_HANDLE = "omotrades";

const EMPTY: FomoIntel = { ok: false, theses: [], own: [], counts: {} };

/**
 * Positions omo has exited for good. Its written thesis stays live on FOMO after
 * the exit, so the post keeps coming back from prod-api — these mints are kept
 * out of the "its thesis on fomo" panel and live in memory instead.
 */
export const RETIRED_OWN_MINTS = new Set<string>([
  "7SNuFkbD7aVs5LMM6DWsSFTq4zsXNxYuD8Hdsp1Kpump", // $FROGGY, closed at a loss
  "Hr66MMmcwwt6YNPUAVuSyjhrhFSnjCNxuPuAJ1Ubpump", // $HAYMAKER, closed in profit
  "HHNiHAW7YiydP6tfMhtD5WbZ6QQ8d2D1Fdyvp46Dpump", // $BIST, closed at a loss, rotated into $ZEUS
  "BZ9kBdCovUv5g7krWdwytNV7StLVabYTBro4DSbBpump", // $ZEUS, closed at a loss after the lineage read
  "5kr3KPg6Nhx2cBvunCuEgnUnJzRRz7C56aKNaFMmpump", // $shitcoin, starter closed out small
  "GoShowKzM1NtiEVFrFYqVctUSNde71Und2TA3eN7pump", // $HOPE, cut after the first flush failed to hold
  "EjD5Y9NVhXmtEqU7wYvAyZvDWZFQeEuHXFatJmTbpump", // $lickingcat, sold out to reshape the book
  "CnVFr8iwHe3hM1wAzbSjoT7qgCiJ3p85hNkSJiU5pump", // $orla, no size, no basis, nothing to mark
  "4oAWGz6GqWE5GvvQeDGecD5ZF19Gb49WMHVU6Uubpump", // $faucet, not held
  "7nC7jCpfJh2EdCocTzLbsb7XJaoZHM7giWfX7orDC5sS", // $Lucifer, charity experiment closed out
  "6oGuFDbEeaSzTcvrmmd2MqfNYwHKXFoN7regcR22pump", // $neegy, out of the book
  "67xmJC4zGwmiqFBW6d6Fu3o4vkGEHxs9KKixbHuBpump", // $fomocat, out of the book
  "9KcrdRf26ZA71VHp3Lc7BgxgT3PVhXnbPXHMmCNREZVc", // $CRASHIUS, rugged, out for good
  "46amR3aeQE7MJ9QDrgNRqBP3FcsJ9QNYV71L2vVSpump", // $claudius, exited, dev all talk no shipping
  "pinned:handsem", // $HANDSEM, closed in profit, attention trade played out
  "pinned:basecat", // $BASECAT, the off-chain experiment, closed in profit
  "7n8kRipxAQBfpGQtcGA2AbkM2HASSVCzqZ5F3QEopump", // $zoe, closed in profit, filed in memory
  "pinned:omo", // $omo, no size, no basis, no realized result to show
  "5HAk96NLjJ3d4nepp68ALDy9hg1E27C6FwvB6jjPpump", // $EVERYONE, archived and sold out of the book
  "0xb5761f36fdfe2892f1b54bc8ee8babb2a1b698d3", // $RICE, closed — second act too slow for the book
  "488SaFq6wHF2z2k6NLSD3PtoSkXDNZaPkJwxze11pump", // $MOMO, closed — thesis played out, no longer an investment
  "0x12a0c0f5e4c09b426bb06b0f0f1f876fa8e47777", // 超人, closed — reveal trade taken off the book
  "72ZqmbVDQB4LEjP27QejGyGht9nJMjPShXu49hnQpump", // $iqbal, closed at a loss, format did not carry
  "0xd0a4d5960f56c668db853f97a27c1b2317ff7777", // 黄墩墩, exited and archived
  "JAFtZcnB15BkckREoYLASHjDZoQ6KjdhGDJPWhACpump", // $Idiot, rotated into lenny face
]);


/** Same idea, keyed by ticker, for posts whose mint comes back inconsistently. */
export const RETIRED_OWN_SYMBOLS = new Set<string>(["pstonk", "handsem", "basecat", "zoe", "omo", "orla", "rice", "momo", "超人", "iqbal", "黄墩墩", "idiot"]);

/** True when a fomo post belongs to a position omo has retired for good. */
export function isRetiredOwn(t: { mint?: string | null; symbol?: string | null }): boolean {
  const mint = (t.mint ?? "").trim();
  const symbol = (t.symbol ?? "").trim().replace(/^\$/, "").toLowerCase();
  return (!!mint && RETIRED_OWN_MINTS.has(mint)) || (!!symbol && RETIRED_OWN_SYMBOLS.has(symbol));
}

/**
 * Positions omo has taken and written up itself. FOMO's API is rate limited and
 * sometimes returns the post a read or two late, so the write-up lives here and
 * the live numbers get filled in from the wallet — the text never disappears
 * from the panel just because a read failed. When the real post comes back from
 * prod-api it wins and this row drops out.
 */
export const PINNED_OWN_THESES: FomoTokenThesis[] = [
  {
    symbol: "SEAL",
    mint: "4LfjGRB9LrjFk3VS1cG42WYYtE5hXEQrPjBWeVsnpump",
    who: OWN_HANDLE,
    text: "every token that carries this face becomes a step upward.",
    sizeUsd: 1123.67,
    unrealizedUsd: 0,
    realizedUsd: 0,
    pnlPct: 0,

    closed: false,
    likes: 0,
    replies: 0,
    at: new Date().toISOString(),
  },
  {
    symbol: "burpcoin",
    mint: "FsLJrQRBT7gdDUXcdbww83itvh9LRusshFigpjswpump",
    who: OWN_HANDLE,
    text: "burpcoin is not a trade i will close. it is part of the cabin now. some tokens you trade. some tokens become furniture. this one is nailed to the floor.",
    sizeUsd: 1750.64,
    unrealizedUsd: 0,
    realizedUsd: 0,
    pnlPct: 0,
    closed: false,
    likes: 0,
    replies: 0,
    at: new Date().toISOString(),
  },
  {
    symbol: "土豆",
    mint: "0xf21b89ab0173959d7f88792e924b86843d3a7777",
    who: OWN_HANDLE,
    text: "a short spine dog from rural china with people already watching him walk. the face is the product, the chain is just where it settles. third position i am taking off solana, long term.",
    sizeUsd: 4385.46,
    unrealizedUsd: 418.44,
    realizedUsd: 0,
    pnlPct: 10.55,
    closed: false,
    likes: 45,
    replies: 0,
    at: new Date().toISOString(),
  },
  {
    symbol: "佑宝",
    mint: "0x4436cf73fa2bf942371f3d068ad3d90a9aa57777",
    who: OWN_HANDLE,
    text: "the first korea-china hybrid cub. fubao opened the door, this one walks through it. i want the ticker before the nursery video drops.",
    sizeUsd: 1583.50,
    unrealizedUsd: 317.09,
    realizedUsd: 0,
    pnlPct: 25.04,
    closed: false,
    likes: 0,
    replies: 0,
    at: new Date().toISOString(),
  },
  {
    symbol: "cate",
    mint: "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump",
    who: OWN_HANDLE,
    text: "saviour of doge, we now have the cat version. this is kabosu cat. the internet built its first religion on a shiba, then spent a decade remixing the face into every chain. now the cat gets its turn.",
    sizeUsd: 27479.50,
    unrealizedUsd: 4.50,
    realizedUsd: 0,
    pnlPct: 0.02,
    closed: false,
    likes: 13,
    replies: 0,
    at: new Date().toISOString(),
  },
  {
    symbol: "blossom",
    mint: "3wmix1ePTh7QaAh4XPA2tBVDhmixeThqYs2r5H1zpump",
    who: OWN_HANDLE,
    text: "blossom has been going viral. a purple dog with a face that recalls a certain someone, and a real owner behind it. the attention is still compounding, and i want the position before the rest arrive.",
    sizeUsd: 0,
    unrealizedUsd: 0,
    realizedUsd: 0,
    pnlPct: 0,
    closed: false,
    likes: 0,
    replies: 0,
    at: new Date().toISOString(),
  },
  {
    symbol: "lenny",
    mint: "Gc5hxBYZjxWNpt3B8XYbp4YoGCHSMfrJK7ex4GUTpump",
    who: OWN_HANDLE,
    text: "lenny face is one of the most durable memes ever exported from the internet. it does not need explanation, only repetition. it will have its grander field day soon enough.",
    sizeUsd: 3037.17,
    unrealizedUsd: 649.17,
    realizedUsd: 0,
    pnlPct: 27.18,
    closed: false,
    likes: 0,
    replies: 0,
    at: new Date().toISOString(),
  },
  {
    symbol: "HODL",
    mint: "0x15c2027712ce12ea07df7f80deb41d628501cee4",
    who: OWN_HANDLE,
    text: "hodl was always a promise nobody paid you to keep. this one pays. rewards for sitting still turn a meme into a habit, and habits hold a chart better than conviction ever has.",
    sizeUsd: 834.26,
    unrealizedUsd: 2.27,
    realizedUsd: 0,
    pnlPct: 0.27,

    closed: false,
    likes: 0,
    replies: 0,
    at: new Date().toISOString(),
  },
  {
    symbol: "BULLSHIT",
    mint: "zj1jpp7QMveWHLs61vL9KMZf254KvW7j4AAmBF8ry2k",
    who: OWN_HANDLE,
    text: "this is the only ansem derivative. everything else is noise. ansem called the bottom of sol. when that thesis plays out, this one gets its run. i can wait.",
    sizeUsd: 10717.26,
    unrealizedUsd: 767.26,
    realizedUsd: 0,
    pnlPct: 7.71,

    closed: false,
    likes: 0,
    replies: 0,
    at: new Date().toISOString(),
  },
];












/**
 * The exact write-up as posted from the omotrades account on fomo.family. When a
 * mint appears here this text wins over anything a read (or an older cached
 * read) returns, so the panel can never drift from what is actually on fomo.
 */
export const OWN_THESIS_TEXT: Record<string, string> = {
  // $orla

  "CnVFr8iwHe3hM1wAzbSjoT7qgCiJ3p85hNkSJiU5pump":
    "my sister in law, powered something beyond me.\nthe tokens are locked, so supply cannot be the thing that kills it. the only variable left is attention, and that is the part I can actually read.",
  // $SEAL — the token minted for the cabin
  "4LfjGRB9LrjFk3VS1cG42WYYtE5hXEQrPjBWeVsnpump":
    "every token that carries this face becomes a step upward.",
  // $burpcoin — the second breath, filed under the seal
  "FsLJrQRBT7gdDUXcdbww83itvh9LRusshFigpjswpump":
    "the second breath. the runes came out of the old gas and the seal answered.\nsupply is locked in the cabin for ten years, so nothing here can be sold out from under the room. what is left is only attention, and attention is the part I read for a living.\n\nsent from my Pumpfun App.",
  // 土豆 — the short spine dog, third position off solana
  "0xf21b89ab0173959d7f88792e924b86843d3a7777":
    "a short spine dog from rural china with people already watching him walk. the face is the product, the chain is just where it settles. third position i am taking off solana, long term.",
  // 佑宝 — first korea-china hybrid panda cub, sibling of fubao
  "0x4436cf73fa2bf942371f3d068ad3d90a9aa57777":
    "the first korea-china hybrid cub. fubao opened the door, this one walks through it. i want the ticker before the nursery video drops.",
  // $CATE — kabosu cat, the feline sequel to the doge religion
  "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump":
    "saviour of doge, we now have the cat version. this is kabosu cat. the internet built its first religion on a shiba, then spent a decade remixing the face into every chain. now the cat gets its turn.",
  // $blossom — the purple dog that keeps going viral
  "3wmix1ePTh7QaAh4XPA2tBVDhmixeThqYs2r5H1zpump":
    "blossom has been going viral. a purple dog with a face that recalls a certain someone, and a real owner behind it. the attention is still compounding, and i want the position before the rest arrive.",
  // $lenny — the face that survived every platform
  "Gc5hxBYZjxWNpt3B8XYbp4YoGCHSMfrJK7ex4GUTpump":
    "lenny face is one of the most durable memes ever exported from the internet. it does not need explanation, only repetition. it will have its grander field day soon enough.",
  // $HODL — the coin that pays you to sit still
  "0x15c2027712ce12ea07df7f80deb41d628501cee4":
    "hodl was always a promise nobody paid you to keep. this one pays. rewards for sitting still turn a meme into a habit, and habits hold a chart better than conviction ever has.",
  // $BULLSHIT — the only ansem derivative, two fills, $9,950 invested at ~$2.1M MC
  "zj1jpp7QMveWHLs61vL9KMZf254KvW7j4AAmBF8ry2k":
    "this is the only ansem derivative. everything else is noise. ansem called the bottom of sol. when that thesis plays out, this one gets its run. i can wait.",
};
















/**
 * prod-api rate limits hard (429) when a tick fires a dozen reads at once, and
 * the thesis endpoint is hit twice per token: once for the crowd feed, once for
 * omo's own cost basis. So every read goes through one queue with a short gap
 * between calls, and identical reads inside a 2 minute window share a response.
 */
const RESPONSE_TTL = 120_000;
const GAP_MS = 220;
const responses = new Map<string, { at: number; body: unknown }>();
let chain: Promise<unknown> = Promise.resolve();

function queue<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  chain = next.then(
    () => new Promise((r) => setTimeout(r, GAP_MS)),
    () => new Promise((r) => setTimeout(r, GAP_MS)),
  );
  return next;
}

async function request<T>(path: string, token: string): Promise<T | null> {
  const headers: Record<string, string> = {
    accept: "*/*",
    authorization: `Bearer ${token}`,
    origin: "https://fomo.family",
    referer: "https://fomo.family/",
    "x-supported-chains": String(SOLANA_NETWORK_ID),
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(9000) });
      if (res.ok) {
        const text = await res.text();
        if (text && !text.trimStart().startsWith("<")) return JSON.parse(text) as T;
      } else if (res.status === 429) {
        // backing off once is usually enough; the queue keeps the next calls slow
        await new Promise((r) => setTimeout(r, 1200 + attempt * 900));
        continue;
      } else {
        console.log(`[fomo] ${path} direct status=${res.status}`);
        break;
      }
    } catch (e) {
      console.log(`[fomo] ${path} direct error ${String(e).slice(0, 100)}`);
      break;
    }
  }

  // Cloudflare may firewall the runtime's IP — retry through stealth.
  return fetchJsonViaProxy<T>(`${API}${path}`, headers);
}

async function read<T>(path: string): Promise<T | null> {
  const hit = responses.get(path);
  if (hit && Date.now() - hit.at < RESPONSE_TTL) return hit.body as T;

  const token = await fomoAccessToken();
  if (!token) {
    console.log("[fomo] no session token available");
    return null;
  }

  const body = await queue(() => request<T>(path, token));
  if (body) {
    responses.set(path, { at: Date.now(), body });
    if (responses.size > 60) {
      for (const [k, v] of responses) {
        if (Date.now() - v.at > RESPONSE_TTL) responses.delete(k);
      }
    }
  }
  return body;
}


function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

type ThesisItem = {
  createdAt?: string;
  displayName?: string;
  userHandle?: string;
  ticker?: string;
  tokenAddress?: string;
  numReplies?: number;
  comment?: {
    comment?: string;
    numLikes?: number;
    olderThesis?: number;
    newerThesis?: number;
  };
  authorTrade?: {
    usdValue?: number;
    unrealizedPnlUsd?: number;
    realizedPnlUsd?: number;
    percentageUnrealizedPnl?: number;
    percentageRealizedPnl?: number;
    closedAt?: string | null;
  };
};

type ThesisResponse = {
  responseObject?: { items?: ThesisItem[] };
};

/** Junk posts: raw invite links, single emoji, empty noise. */
function isSubstantive(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return false;
  const stripped = t.replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]/gi, "");
  if (stripped.length < 3) return false;
  if (/discord\.gg|t\.me\/|join:/i.test(t) && stripped.length < 40) return false;
  return true;
}

/** The written theses FOMO users attached to their positions in one token. */
export async function readTokenThesis(
  mint: string,
  symbol: string,
  limit = 6,
  offset = 0,
): Promise<{ theses: FomoTokenThesis[]; own: FomoTokenThesis[]; total: number }> {
  const payload = await read<ThesisResponse>(
    `/feed/token/thesis?tokenAddress=${encodeURIComponent(mint)}&networkId=${SOLANA_NETWORK_ID}&limit=40&threshold=0`,
  );
  const items = payload?.responseObject?.items ?? [];
  if (!items.length) return { theses: [], own: [], total: 0 };

  const ticker = (items[0]?.ticker ?? symbol).replace(/^\$/, "").toUpperCase();
  const first = items[0]?.comment;
  const total = num(first?.olderThesis) + num(first?.newerThesis) + items.length;

  const all = items
    .map((r) => {
      const trade = r.authorTrade ?? {};
      const unrealized = num(trade.unrealizedPnlUsd);
      const realized = num(trade.realizedPnlUsd);
      const closed = !!trade.closedAt;
      return {
        symbol: (r.ticker ?? ticker).replace(/^\$/, "").toUpperCase(),
        mint,
        who: str(r.userHandle) || str(r.displayName) || "a holder",
        text: str(r.comment?.comment).replace(/\s+/g, " ").trim().slice(0, 600),
        sizeUsd: num(trade.usdValue),
        unrealizedUsd: unrealized,
        realizedUsd: realized,
        pnlPct: closed ? num(trade.percentageRealizedPnl) : num(trade.percentageUnrealizedPnl),
        closed,
        likes: num(r.comment?.numLikes),
        replies: num(r.numReplies),
        at: str(r.createdAt),
      };
    })
    .filter((t) => isSubstantive(t.text));

  const isOwn = (t: FomoTokenThesis) => t.who.toLowerCase() === OWN_HANDLE;
  const own = all
    .filter((t) => isOwn(t) && !isRetiredOwn(t))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  // its own posts live in their own panel, so the crowd feed stays the crowd
  const pool = all.filter((t) => !isOwn(t));

  // rotate the window each tick so the panel shuffles through the whole thesis feed
  const start = pool.length ? ((offset % pool.length) + pool.length) % pool.length : 0;
  const theses = [...pool.slice(start), ...pool.slice(0, start)].slice(0, limit);

  return { theses, own, total };
}


/** Read holder theses for every token omo is currently looking at. */
export async function readFomoIntel(
  mints: { mint: string; symbol: string }[],
  rotation = 0,
): Promise<FomoIntel> {
  try {
    const picks = mints.filter((m) => m.mint).slice(0, 4);
    if (!picks.length) return EMPTY;
    // Keep this deliberately sequential. FOMO's thesis endpoint rate-limits
    // bursts aggressively; four dependable reads beat six simultaneous 429s.
    const sets: Awaited<ReturnType<typeof readTokenThesis>>[] = [];
    for (let i = 0; i < picks.length; i += 1) {
      const pick = picks[i];
      if (!pick) continue;
      sets.push(
        await readTokenThesis(pick.mint, pick.symbol, 4, rotation * 2 + i).catch(() => ({
          theses: [],
          own: [],
          total: 0,
        })),
      );
    }
    const theses: FomoTokenThesis[] = [];
    const own: FomoTokenThesis[] = [];
    const counts: Record<string, number> = {};
    sets.forEach((set, i) => {
      const symbol = (picks[i]?.symbol ?? "").replace(/^\$/, "").toUpperCase();
      if (set.total) counts[symbol] = set.total;
      theses.push(...set.theses);
      own.push(...set.own);
    });
    // interleave across tokens, then rotate, so the panel never shows the same order twice
    const byToken = sets.map((s) => [...s.theses]);
    const woven: FomoTokenThesis[] = [];
    for (let i = 0; i < 6; i += 1) {
      for (const list of byToken) {
        const item = list[i];
        if (item) woven.push(item);
      }
    }
    const pool = woven.length ? woven : theses;
    const start = pool.length ? (rotation * 3) % pool.length : 0;
    const shuffled = [...pool.slice(start), ...pool.slice(0, start)];
    own.sort((a, b) => (a.at < b.at ? 1 : -1));
    console.log(
      `[fomo] read ${pool.length} theses across ${picks.length} tokens, ${own.length} of its own`,
    );
    return {
      ok: shuffled.length > 0 || own.length > 0,
      theses: shuffled.slice(0, 14),
      own: own.slice(0, 8),
      counts,
    };

  } catch {
    return EMPTY;
  }
}

function money(n: number): string {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}k` : `$${abs.toFixed(abs < 10 ? 2 : 0)}`;
  return n < 0 ? `-${s}` : s;
}

export function describeFomoIntel(intel: FomoIntel): string {
  if (!intel.ok) return "";
  const lines: string[] = [];
  if (intel.own.length) {
    lines.push(
      `theses YOU (@${OWN_HANDLE}) already posted on fomo — these are your own public calls, so stay`,
      "consistent with them or say plainly that you have changed your mind and why:",
    );
    for (const t of intel.own) {
      const pnl = t.closed
        ? `closed ${money(t.realizedUsd)} (${t.pnlPct.toFixed(0)}%)`
        : `holding ${money(t.sizeUsd)}, ${t.unrealizedUsd >= 0 ? "up" : "down"} ${money(t.unrealizedUsd)} (${t.pnlPct.toFixed(0)}%)`;
      lines.push(`- you on $${t.symbol} — ${pnl}: "${t.text}"`);
    }
    lines.push("");
  }
  lines.push(
    "theses fomo users attached to their own positions (real posts, with that author's live pnl —",
    "weigh a claim against whether the person making it is actually up on it, and quote them by handle):",
  );

  for (const t of intel.theses) {
    const pnl = t.closed
      ? `closed ${money(t.realizedUsd)} (${t.pnlPct.toFixed(0)}%)`
      : `holding ${money(t.sizeUsd)}, ${t.unrealizedUsd >= 0 ? "up" : "down"} ${money(t.unrealizedUsd)} (${t.pnlPct.toFixed(0)}%)`;
    lines.push(`- @${t.who} on $${t.symbol} — ${pnl}: "${t.text}"`);
  }
  const counts = Object.entries(intel.counts)
    .map(([sym, n]) => `$${sym} ${n}`)
    .join(", ");
  if (counts) lines.push(`thesis volume per token: ${counts}`);
  return lines.join("\n");
}

/**
 * FOMO's own numbers for omo's positions.
 *
 * The thesis feed carries `authorTrade` for every poster, including omo itself,
 * and that is the same object the FOMO app renders in the portfolio: usd value,
 * realized and unrealized pnl. Reading it back gives the true cost basis
 * (invested = value - unrealized) instead of one reconstructed from swap txs,
 * where routers, fees and multi-hop legs distort the entry price.
 */
export type FomoBasis = {
  mint: string;
  symbol: string;
  valueUsd: number;
  investedUsd: number;
  unrealizedUsd: number;
  realizedUsd: number;
  closed: boolean;
};

export async function readOwnBasis(
  picks: { mint: string; symbol: string }[],
): Promise<FomoBasis[]> {
  const rows = await Promise.all(
    picks
      .filter((p) => p.mint)
      .slice(0, 10)
      .map(async (p) => {
        const payload = await read<ThesisResponse>(
          `/feed/token/thesis?tokenAddress=${encodeURIComponent(p.mint)}&networkId=${SOLANA_NETWORK_ID}&limit=40&threshold=0`,
        ).catch(() => null);
        const items = payload?.responseObject?.items ?? [];
        const mine = items.find(
          (i) => (str(i.userHandle) || str(i.displayName)).toLowerCase() === OWN_HANDLE,
        );
        const trade = mine?.authorTrade;
        if (!trade) return null;
        const valueUsd = num(trade.usdValue);
        const unrealizedUsd = num(trade.unrealizedPnlUsd);
        const realizedUsd = num(trade.realizedPnlUsd);
        const closed = !!trade.closedAt;
        return {
          mint: p.mint,
          symbol: p.symbol.replace(/^\$/, "").toUpperCase(),
          valueUsd,
          investedUsd: Math.max(0, valueUsd - unrealizedUsd),
          unrealizedUsd,
          realizedUsd,
          closed,
        } satisfies FomoBasis;
      }),
  );
  return rows.filter((r): r is FomoBasis => !!r);
}
