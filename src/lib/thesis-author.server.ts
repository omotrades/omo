/**
 * Thesis re-authoring.
 *
 * A write-up that was typed once and never touched again is a static string with
 * extra steps, and a reader is right to treat it as one. This job walks the open
 * book on the live cadence and has the reasoning model rewrite any write-up that
 * is stale or that is not yet model authored, against the position's current
 * numbers and the current tape.
 *
 * What that changes, concretely:
 *   - every open row converges to `author = model` with the model id stored on
 *     it, because the text is regenerated rather than inherited,
 *   - a write-up advances when the position advances instead of describing the
 *     day it was opened,
 *   - the rewrite is a database write, so it reaches the page and
 *     `/api/public/theses.json` without a deploy.
 *
 * The rewrite is deliberately not allowed to invent a position: it only ever
 * touches rows that already exist and are open, and it never changes size, pnl
 * or the retirement flag. Those come from the chain.
 */

const STALE_MS = 6 * 60 * 60 * 1000;
/** how many rows one pass may rewrite, so a tick never turns into a batch job */
const PER_PASS = 2;

export type Restatement = {
  symbol: string;
  mint: string;
  model: string;
  before: string;
  after: string;
};

function isStale(updatedAt: string) {
  const t = Date.parse(updatedAt);
  return !Number.isFinite(t) || Date.now() - t > STALE_MS;
}

/**
 * Rewrites the write-ups that need it. Returns what it changed so the caller can
 * log it into the decision stream. Never throws.
 */
export async function restateTheses(): Promise<Restatement[]> {
  const out: Restatement[] = [];
  try {
    const { refreshTheses, writeThesis, thesisBook } = await import("./theses.server");
    const { resolveModelApiKey } = await import("./ai-gateway.server");
    const apiKey = resolveModelApiKey();
    if (!apiKey) return out;

    await refreshTheses(true);
    const open = thesisBook().rows.filter((row) => !row.retired && !row.closed);
    const due = open
      .filter((row) => row.author !== "model" || isStale(row.updatedAt))
      // oldest text first, so nothing sits unrevised while newer rows churn
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      .slice(0, PER_PASS);
    if (!due.length) return out;

    const { runRole } = await import("./models.server");
    const { generateText } = await import("ai");
    const { researchToken } = await import("./market.server");



    for (const row of due) {
      const tape = await researchToken(row.mint, row.symbol).catch(() => null);
      const brief = [
        `name: ${row.symbol} (${row.mint})`,
        `position: $${row.sizeUsd.toFixed(0)} open, unrealized $${row.unrealizedUsd.toFixed(0)} (${row.pnlPct.toFixed(1)}%), realized $${row.realizedUsd.toFixed(0)}`,
        `opened: ${row.openedAt}`,
        `current write-up: ${row.thesis || "none on file"}`,
        tape ? `tape: ${JSON.stringify(tape).slice(0, 1200)}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const result = await runRole(
        "reasoning",
        (model) =>
          generateText({
            model,
            system:
              "you are omo, holding this position. rewrite the write-up in under 60 words so it reflects where the position is now: why it is still on, what has changed since it was opened, and the single condition that takes you out. advance the argument, do not restate the old text. lowercase, no em dashes, no hype, no price targets.",
            prompt: brief,
          }),
        { apiKey },
      ).catch(() => null);

      const text = result?.result.text.trim();
      if (!text || text.length < 20) continue;

      const written = await writeThesis({
        mint: row.mint,
        symbol: row.symbol,
        thesis: text,
        author: "model",
        model: result!.resolved.model,
        sizeUsd: row.sizeUsd,
        unrealizedUsd: row.unrealizedUsd,
        realizedUsd: row.realizedUsd,
        pnlPct: row.pnlPct,
      });
      if (written) {
        out.push({
          symbol: row.symbol,
          mint: row.mint,
          model: result!.resolved.label,
          before: row.thesis,
          after: text,
        });
      }
    }
  } catch (error) {
    console.log(`[omo] thesis restatement failed: ${(error as Error).message}`);
  }
  return out;
}
