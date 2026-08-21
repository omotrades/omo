/**
 * Tickers omo is not allowed to track, grade, shortlist or talk about.
 *
 * These are manufactured or dead charts that slipped past the numeric filters
 * once and looked bad on screen. The list is enforced in three places so a name
 * cannot come back through a side door:
 *   - the market scanner, so blocked rows never reach the model at all
 *   - graded calls ("how it decided"), on write and on read-back from storage
 *   - the contender shortlist, on write and on read-back from storage
 */
const BLOCKED_SYMBOLS = new Set([
  "404",
  "404LIFE",
  "404LIFENOTFOUND",
  "WAWA",
  "POOPHORSI",
  "MACI",
  "SHEEP",
  // closed and done with: no more retrospection on this one
  "BIST",
  // dropped for good: no more calendar reasoning on this one
  "KIO",
  "KIONGAZI",
  // rugged: never track, grade or talk about this one again
  "CRASHIUS",
  // closed in profit and filed: no more grading this one
  "HANDSEM",
  // closed out and filed: no more grading these
  "BASECAT",
  "ZOE",



]);

/** true when this ticker must never be tracked or mentioned. */
export function isBlockedSymbol(raw?: string | null): boolean {
  const sym = (raw ?? "").replace(/^\$/, "").replace(/\s+/g, "").trim().toUpperCase();
  if (!sym) return false;
  if (BLOCKED_SYMBOLS.has(sym)) return true;
  // "404 life not found" and friends, in any spacing the source returns
  if (/^404/.test(sym)) return true;
  return false;
}

/** convenience for filtering any row that carries a symbol. */
export function keepSymbol(row: { symbol?: string | null }): boolean {
  const sym = (row?.symbol ?? "").trim();
  return !!sym && !isBlockedSymbol(sym);
}
