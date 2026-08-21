/**
 * Automation audit log.
 *
 * Every tick the loop writes down, for each name it acted on or refused, the
 * exact inputs it was holding at that moment and which rules those inputs
 * tripped. Nothing here is written by hand and nothing is inferred later: the
 * row is recorded when the decision happens, and the on-chain signature is
 * attached only once a matching fill actually shows up in the wallet.
 */

import type { MemeCandidate, TokenResearch } from "./market.server";
import type { WalletSnapshot } from "./wallet.server";

export type AuditRule = {
  /** stable rule id so a row can be replayed against the same logic later */
  id: string;
  /** did the input satisfy the rule */
  pass: boolean;
  /** the number or fact the rule was evaluated against */
  detail: string;
};

export type AuditRow = {
  id: string;
  at: string;
  phase: string;
  side: string | null;
  symbol: string | null;
  mint: string | null;
  usd_target: number;
  verdict: string;
  note: string | null;
  rules: AuditRule[];
  inputs: Record<string, unknown>;
  signature: string | null;
  matched_at: string | null;
};

type TickAction = { kind: string; text: string };

const RULE_LABELS: Record<string, string> = {
  liquidity_floor: "pool deep enough to exit the size",
  volume_alive: "1h volume still real, not a dead tape",
  buy_pressure: "buys leading sells on the hour",
  not_newborn_fade: "not a fresh launch already bleeding",
  public_presence: "named socials or a site behind the ticker",
  crowd_heat: "fomo reading inside the range i act in",
  cash_available: "cash on hand for the ticket",
  already_held: "size already on in this name",
  not_on_break: "loop awake, not on a break",
};

export function ruleLabel(id: string) {
  return RULE_LABELS[id] ?? id;
}

function symbolsIn(text: string, symbols: string[]) {
  const upper = text.toUpperCase();
  return symbols.filter((symbol) => {
    const needle = symbol.toUpperCase();
    return needle.length >= 2 && upper.includes(needle);
  });
}

/**
 * The rule set, exported so the live pipeline gates an order against exactly the
 * same rules the audit log shows. One implementation, one source of truth.
 */
export function evaluateRules(
  candidate: MemeCandidate | undefined,
  research: TokenResearch | undefined,
  wallet: WalletSnapshot | null,
  fomo: number,
  onBreak: boolean,
): { rules: AuditRule[]; inputs: Record<string, unknown> } {
  const liquidity = candidate?.liquidityUsd ?? research?.totalLiquidityUsd ?? 0;
  const vol1h = candidate?.vol1h ?? 0;
  const buys = candidate?.buys1h ?? research?.buys6h ?? 0;
  const sells = candidate?.sells1h ?? research?.sells6h ?? 0;
  const chg1h = candidate?.chg1h ?? 0;
  const chg6h = candidate?.chg6h ?? research?.chg6h ?? 0;
  const ageHours = candidate?.ageHours ?? 0;
  const socials = candidate?.socials ?? research?.socials ?? [];
  const hasSite = candidate?.hasSite ?? research?.hasSite ?? false;
  const cash = wallet?.cash ?? 0;
  const held = (wallet?.positions ?? []).find(
    (position) =>
      position.symbol.replace(/^\$/, "").toUpperCase() ===
      (candidate?.symbol ?? research?.symbol ?? "").replace(/^\$/, "").toUpperCase(),
  );

  const rules: AuditRule[] = [
    {
      id: "liquidity_floor",
      pass: liquidity >= 15_000,
      detail: `pool $${Math.round(liquidity).toLocaleString("en-US")}`,
    },
    {
      id: "volume_alive",
      pass: vol1h >= 8_000,
      detail: `1h volume $${Math.round(vol1h).toLocaleString("en-US")}`,
    },
    {
      id: "buy_pressure",
      pass: buys > sells,
      detail: `${buys} buys vs ${sells} sells`,
    },
    {
      id: "not_newborn_fade",
      pass: !(ageHours > 0 && ageHours < 24 && chg1h < -15),
      detail: `age ${ageHours ? `${ageHours.toFixed(1)}h` : "unknown"}, 1h ${chg1h.toFixed(1)}%`,
    },
    {
      id: "public_presence",
      pass: socials.length > 0 || hasSite,
      detail: socials.length ? socials.join("/") : hasSite ? "site only" : "nothing public",
    },
    { id: "crowd_heat", pass: fomo >= 25 && fomo <= 90, detail: `fomo ${fomo}` },
    {
      id: "cash_available",
      pass: cash >= 25,
      detail: `cash $${cash.toFixed(2)}`,
    },
    {
      id: "already_held",
      pass: !held,
      detail: held ? `already $${held.usdValue.toFixed(2)} on` : "no size on",
    },
    { id: "not_on_break", pass: !onBreak, detail: onBreak ? "on a break" : "awake" },
  ];

  return {
    rules,
    inputs: {
      liquidityUsd: Math.round(liquidity),
      vol1h: Math.round(vol1h),
      buys1h: buys,
      sells1h: sells,
      chg1h: Number(chg1h.toFixed(2)),
      chg6h: Number(chg6h.toFixed(2)),
      ageHours: Number(ageHours.toFixed(2)),
      socials,
      hasSite,
      fomo,
      cashUsd: Number(cash.toFixed(2)),
      heldUsd: held ? Number(held.usdValue.toFixed(2)) : 0,
      researched: !!research,
    },
  };
}

/**
 * Turns this tick's actions into audit rows. Only actions that name a token on
 * the live board are recorded, because those are the only ones with inputs to
 * audit against.
 */
export async function recordTickAudit(args: {
  at: string;
  actions: TickAction[];
  candidates: MemeCandidate[];
  research: TokenResearch[];
  wallet: WalletSnapshot | null;
  fomo: number;
  onBreak: boolean;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const symbols = args.candidates.map((c) => c.symbol.replace(/^\$/, ""));
  type AuditInsert = {
    at: string;
    phase: string;
    side: string | null;
    symbol: string;
    mint: string | null;
    usd_target: number;
    verdict: string;
    note: string;
    rules: unknown;
    inputs: unknown;
  };
  const rows: AuditInsert[] = [];
  const seen = new Set<string>();

  for (const action of args.actions) {
    if (action.kind !== "did" && action.kind !== "refused") continue;
    const named = symbolsIn(action.text, symbols)[0];
    if (!named) continue;
    const key = `${action.kind}:${named.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const candidate = args.candidates.find(
      (c) => c.symbol.replace(/^\$/, "").toUpperCase() === named.toUpperCase(),
    );
    const research = args.research.find(
      (r) => r.symbol.replace(/^\$/, "").toUpperCase() === named.toUpperCase(),
    );
    const { rules, inputs } = evaluateRules(
      candidate,
      research,
      args.wallet,
      args.fomo,
      args.onBreak,
    );
    const lowered = action.text.toLowerCase();
    const side = /sold|trim|cut|took off|exit/.test(lowered)
      ? "sell"
      : /bought|added|size|ticket|bid|took/.test(lowered)
        ? "buy"
        : null;

    rows.push({
      at: args.at,
      phase: "decision",
      side,
      symbol: named.toUpperCase(),
      mint: candidate?.mint ?? research?.mint ?? null,
      usd_target: 0,
      verdict: action.kind === "refused" ? "pass" : "act",
      note: action.text.slice(0, 400),
      rules,
      inputs,
    });
  }

  if (!rows.length) return 0;
  const { data: inserted, error } = await supabaseAdmin
    .from("omo_audit")
    .insert(rows as unknown as never[])
    .select("id, at, symbol, mint, side, verdict, note, rules, inputs");
  if (error) {
    console.log(`[omo] audit write failed: ${error.message}`);
    return 0;
  }

  // pre-commit: hash each decision the moment it is written, so the hash can go
  // on-chain before any fill exists to point at.
  try {
    const { commitDecision } = await import("./precommit.server");
    for (const row of inserted ?? []) {
      await commitDecision({
        decisionAt: row.at,
        symbol: row.symbol,
        mint: row.mint,
        side: row.side,
        verdict: row.verdict,
        note: row.note,
        rules: Array.isArray(row.rules) ? (row.rules as unknown as AuditRule[]) : [],
        inputs: (row.inputs ?? {}) as Record<string, unknown>,
        auditId: row.id,
      });
    }
  } catch (error_) {
    console.log(`[omo] commit skipped: ${(error_ as Error).message}`);
  }

  return rows.length;
}

/**
 * Every name the loop looked at and turned down, with the rule that stopped it.
 * A person faking automation has no reason to invent hundreds of boring nos, so
 * the refusals are the most telling part of the log.
 */
export async function readAuditPasses(limit = 60): Promise<AuditRow[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("omo_audit")
    .select("*")
    .eq("verdict", "pass")
    .order("at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((row) => ({
    id: row.id,
    at: row.at,
    phase: row.phase,
    side: row.side,
    symbol: row.symbol,
    mint: row.mint,
    usd_target: Number(row.usd_target ?? 0),
    verdict: row.verdict,
    note: row.note,
    rules: Array.isArray(row.rules) ? (row.rules as unknown as AuditRule[]) : [],
    inputs: (row.inputs ?? {}) as Record<string, unknown>,
    signature: row.signature,
    matched_at: row.matched_at,
  }));
}

/**
 * Attaches on-chain signatures to decision rows. A decision only gets a
 * signature when a fill on the same name landed after it was written, inside a
 * 12 hour window — the earliest unmatched fill wins, so nothing is claimed
 * twice.
 */
export async function linkAuditToFills() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const [pendingRes, tradesRes] = await Promise.all([
    supabaseAdmin
      .from("omo_audit")
      .select("id, at, symbol, side, verdict")
      .is("signature", null)
      .eq("verdict", "act")
      .order("at", { ascending: false })
      .limit(60),
    supabaseAdmin
      .from("omo_trades")
      .select("signature, at, symbol, side")
      .order("at", { ascending: false })
      .limit(120),
  ]);

  const pending = pendingRes.data ?? [];
  const trades = tradesRes.data ?? [];
  if (!pending.length || !trades.length) return 0;

  const takenRes = await supabaseAdmin
    .from("omo_audit")
    .select("signature")
    .not("signature", "is", null);
  const taken = new Set((takenRes.data ?? []).map((r) => r.signature));

  let linked = 0;
  for (const row of pending) {
    if (!row.symbol) continue;
    const match = trades
      .filter(
        (trade) =>
          !taken.has(trade.signature) &&
          (trade.symbol ?? "").replace(/^\$/, "").toUpperCase() === row.symbol!.toUpperCase() &&
          (!row.side || trade.side === row.side) &&
          Date.parse(trade.at) >= Date.parse(row.at) &&
          Date.parse(trade.at) - Date.parse(row.at) <= 12 * 3600 * 1000,
      )
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    if (!match) continue;
    taken.add(match.signature);
    const { error } = await supabaseAdmin
      .from("omo_audit")
      .update({ signature: match.signature, matched_at: match.at, phase: "filled" })
      .eq("id", row.id);
    if (!error) linked += 1;
  }
  return linked;
}

/** Newest audit rows, for the public proof page and json feed. */
export async function readAuditLog(limit = 25): Promise<AuditRow[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("omo_audit")
    .select("*")
    .order("at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((row) => ({
    id: row.id,
    at: row.at,
    phase: row.phase,
    side: row.side,
    symbol: row.symbol,
    mint: row.mint,
    usd_target: Number(row.usd_target ?? 0),
    verdict: row.verdict,
    note: row.note,
    rules: Array.isArray(row.rules) ? (row.rules as unknown as AuditRule[]) : [],
    inputs: (row.inputs ?? {}) as Record<string, unknown>,
    signature: row.signature,
    matched_at: row.matched_at,
  }));
}
