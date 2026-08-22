/**
 * The exit record, raw.
 *
 * Entries are only half the loop. This endpoint publishes the other half: the
 * exit rule set with its thresholds, every stored high-water mark and tranche
 * counter the trailing stop is judged against, and every confirmed sell bound
 * back to the commitment that preceded it. Read-only, no session, so anyone can
 * check that a sell was sealed before it happened.
 */

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/exits.json")({
  server: {
    handlers: {
      GET: async () => {
        const { EXIT_LIMITS, exitRuleLabel } = await import("@/lib/exit.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const [marksRes, sellsRes, commitsRes] = await Promise.all([
          supabaseAdmin
            .from("omo_position_marks")
            .select("mint, symbol, peak_pct, peak_at, trims_taken, last_exit_at, first_seen_at")
            .order("updated_at", { ascending: false })
            .limit(50),
          supabaseAdmin
            .from("omo_trades")
            .select("signature, at, symbol, mint, usd_value, token_amount")
            .eq("side", "sell")
            .order("at", { ascending: false })
            .limit(25),
          supabaseAdmin
            .from("omo_commits")
            .select("decision_at, symbol, mint, commit_hash, memo_signature, memo_slot, fill_signature, fill_at, revealed, payload")
            .eq("side", "sell")
            .order("decision_at", { ascending: false })
            .limit(25),
        ]);

        const body = {
          generatedAt: new Date().toISOString(),
          limits: EXIT_LIMITS,
          rules: [
            "exit_stop_loss",
            "exit_trailing_stop",
            "exit_liquidity_break",
            "exit_thesis_invalidated",
            "exit_take_profit",
            "exit_stale_thesis",
            "gate_min_clip",
            "gate_cooldown",
            "gate_daily_exits",
            "gate_tranche_unused",
          ].map((id) => ({ id, means: exitRuleLabel(id) })),
          marks: marksRes.data ?? [],
          sells: sellsRes.data ?? [],
          sellCommitments: commitsRes.data ?? [],
        };

        return new Response(JSON.stringify(body, null, 2), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=15",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});
