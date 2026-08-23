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
 * The thesis book is state, not source. Open positions, their write-ups and the
 * retirement record all live in `public.omo_theses` and are published at
 * `/api/public/theses.json`. This module only borrows the reader, so the panel
 * renders a table anybody can query rather than an array baked into the bundle.
 *
 * The write-up stored against a mint wins over anything prod-api returns, so a
 * late or cached FOMO read can never make the panel drift from the book.
 */
export {
  pinnedTheses,
  ownThesisText,
  isRetiredOwn,
  refreshTheses,
  writeThesis,
  retireThesis,
  markTheses,
  thesisAuthorship,
} from "./theses.server";

import { isRetiredOwn } from "./theses.server";
















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
