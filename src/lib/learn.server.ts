/**
 * Calibration from closed trades.
 *
 * A fair criticism of the first version was that "it learns" appeared in the
 * public story but nowhere in the machine: nothing that happened after a trade
 * changed what the next trade was allowed to be. This module is that missing
 * feedback term, and it is arithmetic rather than narrative.
 *
 * It reads the closed book (realised outcomes per thesis), computes hit rate and
 * expectancy, and returns a single conviction factor. That factor multiplies the
 * risk budget, so a run of losses shrinks the next ticket and a run of wins
 * restores it. The factor is bounded, published, and recomputable from the same
 * public rows a reader can already fetch.
 */

export type Calibration = {
  samples: number;
  wins: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  /** expected percent per trade over the sample */
  expectancyPct: number;
  /** 0.6 .. 1.2, multiplies the derived order size */
  convictionFactor: number;
  formula: string;
};

export type ClosedOutcome = { pnlPct: number; realizedUsd: number };

const FLAT: Calibration = {
  samples: 0,
  wins: 0,
  winRate: 0,
  avgWinPct: 0,
  avgLossPct: 0,
  expectancyPct: 0,
  convictionFactor: 1,
  formula: "no closed trades yet, so conviction factor = 1 (no adjustment)",
};

function round(value: number, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Pure form, so the published numbers can be recomputed from the closed rows. */
export function computeCalibration(outcomes: ClosedOutcome[]): Calibration {
  const usable = outcomes.filter((o) => Number.isFinite(o.pnlPct));
  if (usable.length === 0) return FLAT;

  const winners = usable.filter((o) => o.pnlPct > 0);
  const losers = usable.filter((o) => o.pnlPct <= 0);
  const winRate = winners.length / usable.length;
  const avgWinPct = winners.length ? winners.reduce((s, o) => s + o.pnlPct, 0) / winners.length : 0;
  const avgLossPct = losers.length ? losers.reduce((s, o) => s + o.pnlPct, 0) / losers.length : 0;
  const expectancyPct = winRate * avgWinPct + (1 - winRate) * avgLossPct;

  // Expectancy in percent maps onto size: +10% expectancy earns a 20% larger
  // ticket, -10% expectancy takes 40% off. Small samples are pulled toward 1 so
  // three trades cannot rewrite the book.
  const raw = expectancyPct >= 0 ? 1 + Math.min(expectancyPct / 50, 0.2) : 1 + Math.max(expectancyPct / 25, -0.4);
  const confidence = Math.min(usable.length / 12, 1);
  const convictionFactor = Math.max(0.6, Math.min(1.2, 1 + (raw - 1) * confidence));

  return {
    samples: usable.length,
    wins: winners.length,
    winRate: round(winRate),
    avgWinPct: round(avgWinPct, 2),
    avgLossPct: round(avgLossPct, 2),
    expectancyPct: round(expectancyPct, 2),
    convictionFactor: round(convictionFactor),
    formula: `expectancy = hit rate ${round(winRate)} * avg win ${round(avgWinPct, 2)}% + miss rate ${round(
      1 - winRate,
      3,
    )} * avg loss ${round(avgLossPct, 2)}% = ${round(expectancyPct, 2)}%; conviction factor = clamp(1 + expectancy scaled by sample confidence ${round(
      confidence,
    )}, 0.6, 1.2)`,
  };
}

/**
 * Live form: reads closed theses, computes, and writes the result back so the
 * public surfaces read the same numbers the sizing used. Never throws.
 */
export async function calibration(): Promise<Calibration> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("omo_theses")
      .select("pnl_pct, realized_usd, closed")
      .eq("closed", true)
      .order("updated_at", { ascending: false })
      .limit(60);
    const rows = (data ?? []) as Array<{ pnl_pct: number | null; realized_usd: number | null }>;
    const result = computeCalibration(
      rows.map((r) => ({ pnlPct: Number(r.pnl_pct ?? 0), realizedUsd: Number(r.realized_usd ?? 0) })),
    );
    await supabaseAdmin
      .from("omo_meta")
      .upsert({ k: "learning", v: JSON.parse(JSON.stringify(result)), updated_at: new Date().toISOString() });
    return result;
  } catch {
    return FLAT;
  }
}
