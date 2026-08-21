/**
 * Real web research for omo, routed through the Firecrawl connector gateway.
 *
 * Two jobs:
 *  1. `searchWeb` — live web search (X posts, articles, token pages) so omo's
 *     reasoning is grounded in something other than raw price data.
 *  2. `fetchJsonViaProxy` — scrape a JSON endpoint from a residential/stealth
 *     IP. fomo.family's API firewalls datacenter IPs, so direct fetches from
 *     the worker 403; this gets through some of the time.
 *
 * Every call fails soft: research is a bonus, never a hard dependency.
 */

function gatewayUrl(): string | undefined {
  return process.env["OMO_CONNECTOR_GATEWAY_URL"]?.trim() || undefined;
}

function creds(): { gateway: string; connection: string } | null {
  const gateway = process.env["OMO_MODEL_API_KEY"]?.trim();
  const connection = process.env["FIRECRAWL_API_KEY"];
  if (!gateway || !connection) return null;
  return { gateway, connection };
}

async function call<T>(path: string, body: unknown, timeoutMs = 25000): Promise<T | null> {
  const c = creds();
  const base = gatewayUrl();
  if (!c || !base) return null;
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.gateway}`,
        "X-Connection-Api-Key": c.connection,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.log(`[research] ${path} failed ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.log(`[research] ${path} error ${String(e).slice(0, 120)}`);
    return null;
  }
}

export type WebHit = {
  title: string;
  url: string;
  snippet: string;
};

type SearchResponse = {
  data?: unknown;
};

function asRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    for (const v of Object.values(payload as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** Live web search. `recent` limits results to the last 24h for narrative work. */
export async function searchWeb(query: string, limit = 5, recent = true): Promise<WebHit[]> {
  const payload = await call<SearchResponse>("/search", {
    query,
    limit,
    ...(recent ? { tbs: "qdr:d" } : {}),
  });
  if (!payload) return [];
  return asRows(payload.data)
    .map((r) => ({
      title: str(r["title"]).slice(0, 140),
      url: str(r["url"]),
      snippet: str(r["description"] ?? r["markdown"]).slice(0, 320),
    }))
    .filter((h) => h.title || h.snippet)
    .slice(0, limit);
}

type ScrapeResponse = {
  data?: { rawHtml?: string; markdown?: string; metadata?: { statusCode?: number } };
};

/**
 * Pull a JSON endpoint through the stealth proxy and parse it.
 * Used as the fallback path when a host blocks the worker's own IP.
 */
export async function fetchJsonViaProxy<T>(
  url: string,
  headers: Record<string, string> = {},
): Promise<T | null> {
  const payload = await call<ScrapeResponse>("/scrape", {
    url,
    formats: ["rawHtml"],
    onlyMainContent: false,
    proxy: "stealth",
    headers: {
      accept: "application/json",
      ...headers,
    },
  });
  const raw = payload?.data?.rawHtml ?? payload?.data?.markdown ?? "";
  const status = payload?.data?.metadata?.statusCode;
  if (!raw || raw.trimStart().startsWith("<")) {
    console.log(`[research] proxy ${url} blocked status=${status ?? "?"}`);
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Scrape a normal page down to clean text omo can reason over. */
export async function readPage(url: string, chars = 2500): Promise<string> {
  const payload = await call<ScrapeResponse>("/scrape", {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
    proxy: "stealth",
  });
  const md = payload?.data?.markdown ?? "";
  return md.replace(/\n{3,}/g, "\n\n").slice(0, chars);
}

export function describeWebHits(hits: WebHit[]): string {
  if (!hits.length) return "";
  return hits.map((h) => `- ${h.title || h.url}: ${h.snippet}`).join("\n");
}
