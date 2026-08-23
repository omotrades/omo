/**
 * Disclosure.
 *
 * A proof layer that only reports its successes is marketing. This module
 * reports the state of the machine as it actually is, including the parts that
 * are unflattering, so nobody has to reverse engineer them out of the bundle:
 *
 *   - whether the loop is armed at all, and therefore whether any fill on the
 *     page was placed by this code or by a human hand in the same wallet,
 *   - how many fills exist versus how many are bound to a sealed commitment,
 *     and the count of unbound fills stated plainly rather than omitted,
 *   - which commitments are sealed but carry no side or mint, which are the ones
 *     that can never bind to a fill,
 *   - how many high-water marks the trailing stop has to trail from,
 *   - which surfaces are model written and which are written by hand.
 *
 * Everything here is read-only and derived from the same tables the public
 * endpoints read.
 */

export type Disclosure = {
  generatedAt: string;
  armed: boolean;
  armedMeaning: string;
  fills: {
    total: number;
    boundToCommitment: number;
    unbound: number;
    note: string;
  };
  commitments: {
    total: number;
    bindable: number;
    unbindable: number;
    published: number;
    revealed: number;
    orderIntents: number;
    declineIntents: number;
    note: string;
  };
  positionMarks: {
    stored: number;
    lastMarkedAt: string | null;
    freshestMarkAgeSeconds: number | null;
    note: string;
  };
  reasoning: {
    modelKeyLoaded: boolean;
    note: string;
    perLineAuthorship: string;
  };
  limits: {
    maxOrderUsd: number;
    rolling24hUsd: number;
    note: string;
  };
  provenance: {
    modelWritten: string[];
    handWritten: string[];
    note: string;
  };
};

export async function buildDisclosure(): Promise<Disclosure> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { isArmed } = await import("./keys.server");

  const table = (name: "omo_trades" | "omo_commits" | "omo_position_marks") =>
    supabaseAdmin.from(name).select("*", { count: "exact", head: true });

  const [trades, marks, commits, bound, bindable, published, revealed] = await Promise.all([
    table("omo_trades"),
    table("omo_position_marks"),
    table("omo_commits"),
    table("omo_commits").not("fill_signature", "is", null),
    table("omo_commits").not("side", "is", null).not("mint", "is", null),
    table("omo_commits").not("memo_signature", "is", null),
    table("omo_commits").filter("revealed", "is", true),
  ]);

  const totalFills = trades.count ?? 0;
  const boundFills = bound.count ?? 0;
  const totalCommits = commits.count ?? 0;
  const bindableCommits = bindable.count ?? 0;

  const { resolveModelApiKey } = await import("./ai-gateway.server");
  const modelKeyLoaded = !!resolveModelApiKey();

  const { data: latestMark } = await supabaseAdmin
    .from("omo_position_marks")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const freshestMark = (latestMark as { updated_at: string } | null)?.updated_at ?? null;

  const [orderIntents, declineIntents] = await Promise.all([
    supabaseAdmin.from("omo_commits").select("id", { count: "exact", head: true }).eq("intent", "order"),
    supabaseAdmin.from("omo_commits").select("id", { count: "exact", head: true }).eq("intent", "decline"),
  ]);



  return {
    generatedAt: new Date().toISOString(),
    armed: isArmed(),
    armedMeaning: isArmed()
      ? "a trading key is loaded, so this code can place orders in the published wallet."
      : "no trading key is loaded. the loop reads, reasons, gates, seals on chain and reveals, but it cannot place an order. any fill in the journal predates arming or was placed by a human in the same wallet, and is not evidence that this code traded.",
    fills: {
      total: totalFills,
      boundToCommitment: boundFills,
      unbound: Math.max(0, totalFills - boundFills),
      note: "a fill is bound only when a sealed commitment naming the same mint and side was published on chain before it. unbound fills are published as unbound and are not claimed as machine executed.",
    },
    commitments: {
      total: totalCommits,
      bindable: bindableCommits,
      unbindable: Math.max(0, totalCommits - bindableCommits),
      published: published.count ?? 0,
      revealed: revealed.count ?? 0,
      orderIntents: orderIntents.count ?? 0,
      declineIntents: declineIntents.count ?? 0,
      note: "the sealed label 'order' or 'decline' is inside the hash, so it cannot be reinterpreted later. only an order intent can ever bind to a fill. a decline is a decision not to trade: no fill exists for it, and a reader should not count it as a trade that failed to appear. unbindable rows are historical, sealed before observations were separated from order intents; they carry no side or mint, so nothing can satisfy them.",
    },
    positionMarks: {
      stored: marks.count ?? 0,
      lastMarkedAt: freshestMark,
      freshestMarkAgeSeconds: freshestMark
        ? Math.max(0, Math.round((Date.now() - Date.parse(freshestMark)) / 1000))
        : null,
      note: "high-water marks the trailing stop trails from. written on the live cadence for every open position above the minimum clip, armed or not and independent of the reasoning layer, so the number the trailing rule trails from is always readable here.",
    },
    reasoning: {
      modelKeyLoaded: modelKeyLoaded,
      note: modelKeyLoaded
        ? "a model key is loaded, so the think, the social read and the exit notes are model written on the live cadence."
        : "no model key is loaded. nothing on the page is model written right now, and any text shown is hand written. stated here rather than implied.",
      perLineAuthorship:
        "/api/public/reasoning.json publishes every recent line with the author stored on the row: which model wrote it, or which data source a code formatted line came from. the browser composes no text and holds no candidate phrases, and the server rendered html carries the same sentences.",
    },
    limits: {
      maxOrderUsd: 3000,
      rolling24hUsd: 12000,
      note: "these ceilings bind orders this code places. positions in the wallet larger than the per-order ceiling were built by hand before arming, or across several tickets, and are not claimed as machine placed.",
    },
    provenance: {
      modelWritten: [
        "the pre-trade think and thesis text",
        "the live social read",
        "exit notes on trims and closes",
      ],
      handWritten: [
        "the pinned theses entered by the operator",
        "every rule threshold in the entry and exit gates",
      ],
      note: "rule thresholds are code and never model output. any displayed text from the model is labelled as live where it appears."
    },
  };
}
