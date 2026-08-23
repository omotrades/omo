/**
 * The thesis book.
 *
 * A position's write-up is state, not source. It is created when omo (or the
 * operator, and the row says which) opens a position, revised while the position
 * lives, and retired when the position is closed. All of it lives in
 * `omo_theses` in the database and is published verbatim at
 * `/api/public/theses.json`, so the panel on the site is a render of a table
 * anybody can read rather than an array compiled into the bundle.
 *
 * Three consequences worth stating, because they are the point:
 *   - a thesis can change without a deploy, which is what "the agent writes it"
 *     has to mean if it means anything,
 *   - every row carries an author (`operator` or `model`) and, for model rows,
 *     the model that produced it,
 *   - retirement is a column, so the exit record stays queryable instead of
 *     being deleted from a set of strings.
 *
 * Live numbers still come from the wallet: size and pnl are refreshed against
 * the chain, never trusted from the row.
 */

import type { FomoTokenThesis } from "./fomo.server";

const OWN_HANDLE = "omotrades";
const REFRESH_MS = 30_000;

export type ThesisRow = {
  mint: string;
  symbol: string;
  thesis: string;
  sizeUsd: number;
  unrealizedUsd: number;
  realizedUsd: number;
  pnlPct: number;
  closed: boolean;
  retired: boolean;
  author: string;
  model: string | null;
  openedAt: string;
  updatedAt: string;
};

type Cache = {
  at: number;
  rows: ThesisRow[];
  open: FomoTokenThesis[];
  text: Record<string, string>;
  retiredMints: Set<string>;
  retiredSymbols: Set<string>;
};

const EMPTY: Cache = {
  at: 0,
  rows: [],
  open: [],
  text: {},
  retiredMints: new Set(),
  retiredSymbols: new Set(),
};

let cache: Cache = EMPTY;
let inflight: Promise<Cache> | null = null;

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function toRow(raw: Record<string, unknown>): ThesisRow {
  const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  return {
    mint: String(raw["mint"]),
    symbol: String(raw["symbol"]),
    thesis: String(raw["thesis"] ?? ""),
    sizeUsd: num(raw["size_usd"]),
    unrealizedUsd: num(raw["unrealized_usd"]),
    realizedUsd: num(raw["realized_usd"]),
    pnlPct: num(raw["pnl_pct"]),
    closed: Boolean(raw["closed"]),
    retired: Boolean(raw["retired"]),
    author: String(raw["author"] ?? "operator"),
    model: (raw["model"] as string | null) ?? null,
    openedAt: String(raw["opened_at"] ?? raw["created_at"] ?? new Date().toISOString()),
    updatedAt: String(raw["updated_at"] ?? new Date().toISOString()),
  };
}

function build(rows: ThesisRow[]): Cache {
  const open = rows.filter((r) => !r.retired && !r.closed);
  return {
    at: Date.now(),
    rows,
    open: open.map((r) => ({
      symbol: r.symbol,
      mint: r.mint,
      who: OWN_HANDLE,
      text: r.thesis,
      sizeUsd: r.sizeUsd,
      unrealizedUsd: r.unrealizedUsd,
      realizedUsd: r.realizedUsd,
      pnlPct: r.pnlPct,
      closed: false,
      likes: 0,
      replies: 0,
      at: r.updatedAt,
    })),
    text: Object.fromEntries(open.map((r) => [r.mint, r.thesis])),
    retiredMints: new Set(rows.filter((r) => r.retired).map((r) => r.mint)),
    retiredSymbols: new Set(
      rows.filter((r) => r.retired).map((r) => r.symbol.replace(/^\$/, "").toLowerCase()),
    ),
  };
}

/** Pulls the book from the database. One read in flight at a time per isolate. */
export async function refreshTheses(force = false): Promise<Cache> {
  if (!force && cache.at && Date.now() - cache.at < REFRESH_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const client = await db();
      const { data, error } = await client
        .from("omo_theses")
        .select("*")
        .order("updated_at", { ascending: false });
      if (error) throw new Error(error.message);
      cache = build((data ?? []).map((r) => toRow(r as Record<string, unknown>)));
    } catch (err) {
      // a failed read must never blank the panel: keep whatever this isolate has
      console.log(`[omo] thesis book read failed: ${(err as Error).message}`);
    } finally {
      inflight = null;
    }
    return cache;
  })();
  return inflight;
}

/** Synchronous view of the book, for code paths that cannot await. */
export function thesisBook(): Cache {
  return cache;
}

/** Open positions, shaped like a fomo post so the panel needs no special case. */
export function pinnedTheses(): FomoTokenThesis[] {
  return cache.open;
}

/** The stored write-up per mint. The row is the only version that counts. */
export function ownThesisText(): Record<string, string> {
  return cache.text;
}

/** True when a post belongs to a position that has been retired for good. */
export function isRetiredOwn(t: { mint?: string | null; symbol?: string | null }): boolean {
  const mint = (t.mint ?? "").trim();
  const symbol = (t.symbol ?? "").trim().replace(/^\$/, "").toLowerCase();
  return (
    (!!mint && cache.retiredMints.has(mint)) || (!!symbol && cache.retiredSymbols.has(symbol))
  );
}

export type ThesisWrite = {
  mint: string;
  symbol: string;
  thesis: string;
  /** who produced the text: the operator, or a model, and which one */
  author: "operator" | "model";
  model?: string | null;
  sizeUsd?: number;
  unrealizedUsd?: number;
  realizedUsd?: number;
  pnlPct?: number;
};

/**
 * Opens or revises a thesis. Called by the operator when a position is taken by
 * hand, and by the reasoning loop when the model writes or rewrites one, which
 * is why the author is a required argument rather than a default.
 */
export async function writeThesis(input: ThesisWrite) {
  const client = await db();
  const { error } = await client
    .from("omo_theses")
    .upsert(
      {
        mint: input.mint,
        symbol: input.symbol,
        thesis: input.thesis,
        author: input.author,
        model: input.model ?? null,
        size_usd: input.sizeUsd ?? 0,
        unrealized_usd: input.unrealizedUsd ?? 0,
        realized_usd: input.realizedUsd ?? 0,
        pnl_pct: input.pnlPct ?? 0,
        closed: false,
        retired: false,
      } as never,
      { onConflict: "mint" },
    );
  if (error) {
    console.log(`[omo] thesis write failed: ${error.message}`);
    return false;
  }
  await refreshTheses(true);
  return true;
}

/** Marks a position closed and files the realized result against the write-up. */
export async function retireThesis(mint: string, realizedUsd: number, note?: string) {
  const client = await db();
  const patch: Record<string, unknown> = {
    closed: true,
    retired: true,
    realized_usd: realizedUsd,
    unrealized_usd: 0,
    size_usd: 0,
  };
  if (note) patch["thesis"] = note;
  const { error } = await client.from("omo_theses").update(patch as never).eq("mint", mint);
  if (error) {
    console.log(`[omo] thesis retire failed: ${error.message}`);
    return false;
  }
  await refreshTheses(true);
  return true;
}

/**
 * Pushes the live marks from the wallet back onto the row, so the stored book
 * and the chain agree and a reader of the table sees the same numbers as the
 * site rather than a snapshot from whenever the row was written.
 */
export async function markTheses(
  marks: { mint: string; sizeUsd: number; unrealizedUsd: number; pnlPct: number }[],
) {
  if (!marks.length) return 0;
  const client = await db();
  let written = 0;
  for (const mark of marks) {
    const { error } = await client
      .from("omo_theses")
      .update({
        size_usd: mark.sizeUsd,
        unrealized_usd: mark.unrealizedUsd,
        pnl_pct: mark.pnlPct,
      } as never)
      .eq("mint", mark.mint);
    if (!error) written += 1;
  }
  if (written) await refreshTheses(true);
  return written;
}

/** Author counts, so the site can state provenance instead of asserting it. */
export function thesisAuthorship() {
  const rows = cache.rows;
  return {
    total: rows.length,
    open: rows.filter((r) => !r.retired && !r.closed).length,
    retired: rows.filter((r) => r.retired).length,
    byAuthor: rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.author] = (acc[r.author] ?? 0) + 1;
      return acc;
    }, {}),
    source: "public.omo_theses",
    endpoint: "/api/public/theses.json",
  };
}
