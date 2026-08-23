/**
 * Risk budget.
 *
 * The published ceilings used to be two literals in the source, which is a fair
 * thing to point at: a ceiling that never moves is a ceiling that was chosen by
 * a person once and then left alone. It is now derived from the book on every
 * order, so the size of a ticket is a function of the equity the wallet actually
 * holds and of how the recent tape has treated it.
 *
 * The formula is code, not model output, on purpose: the model decides *whether*
 * to take a name, never how large it may go. What changed is that the numbers
 * are now computed from live state and published as computed, so a reader can
 * recompute them from the same public inputs:
 *
 *   per order   = equity * PER_ORDER_FRACTION, scaled by the drawdown factor,
 *                 clamped to [MIN_TICKET_USD, HARD_ORDER_CEILING_USD]
 *   per day     = per order * DAY_MULTIPLE, clamped to HARD_DAILY_CEILING_USD
 *
 * The drawdown factor is the only adaptive term: a book that is under water on
 * open risk trades smaller until that risk is off. That is the same behaviour a
 * desk would impose, expressed as arithmetic anybody can check.
 */

/** fraction of equity a single ticket may commit at full conviction */
const PER_ORDER_FRACTION = 0.035;
/** how many full-size tickets a single day may contain */
const DAY_MULTIPLE = 4;
/** absolute stops, so a bad equity read can never authorise a large order */
const HARD_ORDER_CEILING_USD = 3_000;
const HARD_DAILY_CEILING_USD = 12_000;
const MIN_TICKET_USD = 25;

export type RiskBudget = {
  equityUsd: number;
  /** 0.5 .. 1, shrinks while open risk is under water */
  drawdownFactor: number;
  maxOrderUsd: number;
  maxDailyUsd: number;
  /** the arithmetic, published so the numbers are reproducible */
  formula: string;
  derived: boolean;
};

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

/** Pure form, so it can be recomputed off the public equity number. */
export function computeBudget(equityUsd: number, unrealizedUsd: number): RiskBudget {
  const equity = Number.isFinite(equityUsd) && equityUsd > 0 ? equityUsd : 0;
  const openDrawdownPct = equity > 0 ? Math.min(0, unrealizedUsd) / equity : 0;
  // -20% of equity in open losses halves the ticket; anything flat or green is full size
  const drawdownFactor = clamp(1 + openDrawdownPct * 2.5, 0.5, 1);

  const maxOrderUsd = equity
    ? Math.round(clamp(equity * PER_ORDER_FRACTION * drawdownFactor, MIN_TICKET_USD, HARD_ORDER_CEILING_USD))
    : MIN_TICKET_USD;
  const maxDailyUsd = Math.round(clamp(maxOrderUsd * DAY_MULTIPLE, MIN_TICKET_USD, HARD_DAILY_CEILING_USD));

  return {
    equityUsd: Math.round(equity),
    drawdownFactor: Number(drawdownFactor.toFixed(3)),
    maxOrderUsd,
    maxDailyUsd,
    formula: `per order = equity ${Math.round(equity)} * ${PER_ORDER_FRACTION} * drawdown factor ${drawdownFactor.toFixed(
      3,
    )}, clamped to [${MIN_TICKET_USD}, ${HARD_ORDER_CEILING_USD}]; per day = per order * ${DAY_MULTIPLE}, clamped to ${HARD_DAILY_CEILING_USD}`,
    derived: equity > 0,
  };
}

/**
 * Live form: reads the shared wallet snapshot written by the loop, then computes.
 * Never throws; with no readable book it returns the minimum ticket, which fails
 * closed rather than open.
 */
export async function riskBudget(): Promise<RiskBudget> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("omo_meta")
      .select("v")
      .eq("k", "wallet")
      .maybeSingle();
    const wallet = (data as { v?: { equity?: number; unrealizedPnl?: number } } | null)?.v ?? null;
    return computeBudget(Number(wallet?.equity ?? 0), Number(wallet?.unrealizedPnl ?? 0));
  } catch {
    return computeBudget(0, 0);
  }
}
