/**
 * The whole loop, in order, in one file.
 *
 * Everything the proof page claims happens in this sequence. The individual
 * pieces live in their own modules; this is the spine that joins them so the
 * order of operations is legible instead of inferred:
 *
 *   read      scan solana memecoins from public dex data, read the fomo board
 *             and the thesis text a name is carrying, search the open web for
 *             what is actually driving attention.
 *   think     the model turns those inputs into a written thesis: why this name,
 *             what would make it wrong, what size. written before any order.
 *   gate      the exact same rule set the audit log publishes is evaluated
 *             against the exact same inputs. any failed rule is a refusal, and
 *             refusals are recorded as loudly as fills.
 *   seal      the passing decision, the rules, the inputs and a random nonce are
 *             hashed. only the hash is published, into a solana memo, so a
 *             validator timestamps the decision before an order exists.
 *   execute   a route for that mint is quoted from a public router, the returned
 *             transaction is signed locally with the wallet key, and the bytes go
 *             to mainnet rpc. no platform call anywhere in the sequence, which is
 *             why fomo having no api changes nothing.
 *   journal   the confirmed signature is written to the trade journal and bound
 *             back to the commitment it filled.
 *   reveal    twenty minutes later the plaintext is opened. anyone can sha256 it
 *             and match the memo already sitting in an earlier confirmed block.
 *
 * Run the whole thing with `runDecisionCycle`. Without OMO_TRADING_KEY every step
 * still runs and the decision is still sealed on chain; execution reports
 * "unarmed" rather than pretending.
 */

import type { AuditRule } from "./audit.server";
import { MAX_ORDER_USD, type OrderResult } from "./execute.server";

export type CycleStep = {
  step: "read" | "think" | "gate" | "seal" | "execute" | "journal" | "reveal";
  ok: boolean;
  detail: string;
};

export type CycleOutcome = {
  at: string;
  symbol: string | null;
  mint: string | null;
  side: "buy" | "sell" | null;
  thesis: string | null;
  rules: AuditRule[];
  refusedOn: string[];
  commitHash: string | null;
  memoSignature: string | null;
  order: OrderResult | null;
  steps: CycleStep[];
};

/**
 * Crowd heat, 0..100, read off how much written conviction a name is carrying on
 * the fomo board. It is a count of real theses, not a sentiment guess: no theses
 * means nobody has put their reasoning behind it yet.
 */
function crowdHeat(intel: import("./fomo.server").FomoIntel | null, totalTheses: number) {
  const written = (intel?.theses.length ?? 0) + totalTheses;
  return Math.max(0, Math.min(100, Math.round(20 + written * 8)));
}

/** Ticket sizing. Conviction scales the ticket; nothing scales past the ceiling. */
function ticketUsd(cash: number, conviction: number) {
  const base = Math.min(cash * 0.15, MAX_ORDER_USD);
  return Math.max(0, Math.round(base * Math.min(Math.max(conviction, 0), 1)));
}

export async function runDecisionCycle(options: { rotation?: number; onBreak?: boolean } = {}): Promise<CycleOutcome> {
  const at = new Date().toISOString();
  const steps: CycleStep[] = [];
  const outcome: CycleOutcome = {
    at,
    symbol: null,
    mint: null,
    side: null,
    thesis: null,
    rules: [],
    refusedOn: [],
    commitHash: null,
    memoSignature: null,
    order: null,
    steps,
  };

  // ---- read -------------------------------------------------------------
  const { scanMemecoins, researchToken, describeResearch, describeCandidate } = await import(
    "./market.server"
  );
  const { readFomoIntel, describeFomoIntel, readTokenThesis } = await import("./fomo.server");
  const { getWalletSnapshot, fetchRecentTrades } = await import("./wallet.server");
  const { searchWeb, describeWebHits } = await import("./web-research.server");

  const [candidates, trades] = await Promise.all([
    scanMemecoins(options.rotation ?? 0),
    fetchRecentTrades(150),
  ]);
  const wallet = await getWalletSnapshot(trades, true);
  const candidate = candidates[0];
  if (!candidate) {
    steps.push({ step: "read", ok: false, detail: "screener returned nothing worth reading" });
    return outcome;
  }
  const [research, intel, boardThesis, web] = await Promise.all([
    researchToken(candidate.mint, candidate.symbol),
    readFomoIntel([{ mint: candidate.mint, symbol: candidate.symbol }], options.rotation ?? 0).catch(
      () => null,
    ),
    readTokenThesis(candidate.mint, candidate.symbol).catch(() => null),
    searchWeb(`${candidate.symbol} solana memecoin`, 5, true).catch(() => []),
  ]);
  outcome.symbol = candidate.symbol;
  outcome.mint = candidate.mint;
  steps.push({
    step: "read",
    ok: true,
    detail: `${candidate.symbol}: ${describeCandidate(candidate)}${research ? ` · ${describeResearch(research)}` : ""}`,
  });

  // ---- read the room (realtime role) ------------------------------------
  // Attention on a memecoin forms on the timeline before it shows on the tape,
  // so the social read runs on the realtime role (grok) and its output is
  // evidence handed to the reasoning stage, never a decision of its own.
  const { resolveModelApiKey } = await import("./ai-gateway.server");
  const { runRole } = await import("./models.server");
  const { generateText } = await import("ai");
  const apiKey = resolveModelApiKey();

  const social = apiKey
    ? await runRole(
        "realtime",
        (model) =>
          generateText({
            model,
            system:
              "you read live social attention on one token. in under 40 words: who is talking, whether the interest is organic or paid, and whether it is still building or already peaked. no price targets, no advice, lowercase, no em dashes. say 'no readable signal' when the material is thin.",
            prompt: [
              `name: ${candidate.symbol} (${candidate.mint})`,
              research ? describeResearch(research) : "",
              intel ? describeFomoIntel(intel) : "",
              web.length ? `web: ${describeWebHits(web)}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          }),
        { apiKey },
      )
        .then(({ result, resolved }) => ({ text: result.text.trim(), model: resolved }))
        .catch(() => null)
    : null;
  if (social?.text) {
    steps.push({ step: "read", ok: true, detail: `social (${social.model.label}): ${social.text}` });
  }

  // ---- think (reasoning role) -------------------------------------------
  const brief = [
    `name: ${candidate.symbol} (${candidate.mint})`,
    describeCandidate(candidate),
    research ? describeResearch(research) : "",
    boardThesis?.theses.length ? `fomo board theses: ${boardThesis.theses.map((t) => t.text).join(" | ")}` : "",
    intel ? describeFomoIntel(intel) : "",
    web.length ? `web: ${describeWebHits(web)}` : "",
    social?.text ? `live social read: ${social.text}` : "",
    `cash on hand: $${(wallet?.cash ?? 0).toFixed(2)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const thought = apiKey
    ? await runRole(
        "reasoning",
        (model) =>
          generateText({
            model,
            system:
              "you are omo. write a thesis for one name in under 60 words: why the attention exists, what would make you wrong, and end with buy or pass. lowercase, no em dashes, no hype.",
            prompt: brief,
          }),
        { apiKey },
      )
        .then(({ result, resolved }) => ({ text: result.text.trim(), model: resolved }))
        .catch(() => null)
    : null;
  const thesis = thought?.text ?? null;
  outcome.thesis = thesis;
  steps.push({
    step: "think",
    ok: Boolean(thesis),
    detail: thesis ? `${thought!.model.label}: ${thesis}` : "model gave nothing usable",
  });


  const wantsBuy = Boolean(thesis && /\bbuy\b/i.test(thesis) && !/\bpass\b/i.test(thesis));
  outcome.side = wantsBuy ? "buy" : null;

  // ---- gate -------------------------------------------------------------
  const { evaluateRules, ruleLabel } = await import("./audit.server");
  const { rules, inputs } = evaluateRules(
    candidate,
    research ?? undefined,
    wallet,
    crowdHeat(intel, boardThesis?.total ?? 0),
    Boolean(options.onBreak),
  );
  outcome.rules = rules;
  outcome.refusedOn = rules.filter((rule) => !rule.pass).map((rule) => ruleLabel(rule.id));
  const passed = outcome.refusedOn.length === 0 && wantsBuy;
  steps.push({
    step: "gate",
    ok: passed,
    detail: passed ? "every rule passed" : outcome.refusedOn.join(", ") || "thesis did not ask to buy",
  });

  // ---- seal -------------------------------------------------------------
  const { commitDecision, publishPendingCommitments, revealDueCommitments } = await import(
    "./precommit.server"
  );
  const commit = await commitDecision({
    decisionAt: at,
    symbol: candidate.symbol,
    mint: candidate.mint,
    side: wantsBuy ? "buy" : null,
    verdict: passed ? "act" : "pass",
    note: thesis,
    rules,
    inputs,
  });
  outcome.commitHash = commit?.hash ?? null;
  steps.push({
    step: "seal",
    ok: Boolean(commit?.hash),
    detail: commit?.hash ? `sha256 ${commit.hash}` : "commitment write failed",
  });

  // publishing is what makes the timestamp somebody else's, so it happens before
  // any order can be placed, never after.
  const published = await publishPendingCommitments(3);
  steps.push({
    step: "seal",
    ok: published > 0,
    detail: published > 0 ? `${published} hash(es) stamped on chain` : "nothing published this pass",
  });
  if (commit?.id) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("omo_commits")
      .select("memo_signature")
      .eq("id", commit.id)
      .maybeSingle();
    outcome.memoSignature = data?.memo_signature ?? null;
  }

  // ---- execute ----------------------------------------------------------
  if (passed && commit?.id) {
    const { placeOrder } = await import("./execute.server");
    const conviction = Math.min(1, crowdHeat(intel, boardThesis?.total ?? 0) / 100 + 0.3);
    const order = await placeOrder({
      commitId: commit.id,
      side: "buy",
      mint: candidate.mint,
      symbol: candidate.symbol,
      usd: ticketUsd(wallet?.cash ?? 0, conviction),
    });
    outcome.order = order;
    steps.push({
      step: "execute",
      ok: order.status === "filled",
      detail: order.status === "filled" ? `filled ${order.signature} via ${order.route.join(" > ") || "router"}` : order.reason,
    });
    steps.push({
      step: "journal",
      ok: order.status === "filled",
      detail:
        order.status === "filled"
          ? "fill written to the journal and bound to the sealed decision"
          : "nothing to journal, no confirmed fill",
    });
  } else {
    steps.push({ step: "execute", ok: false, detail: "no order: the decision did not clear the gate" });
  }

  // ---- reveal -----------------------------------------------------------
  const revealed = await revealDueCommitments().catch(() => 0);
  steps.push({
    step: "reveal",
    ok: true,
    detail: `${revealed} older commitment(s) opened for anyone to hash`,
  });

  const { linkAuditToFills } = await import("./audit.server");
  await linkAuditToFills().catch(() => null);

  return outcome;
}
