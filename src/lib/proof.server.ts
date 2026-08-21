/**
 * Proof of work. Nothing here is generated for effect: every row is read back
 * out of omo's own log table and its on-chain trade table, and paired so anyone
 * can see which came first — the written reasoning or the fill.
 */

const SOL_MINT = "So11111111111111111111111111111111111111112";
const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

export type ProofLogLine = { at: string; kind: string; text: string };

export type ProofFill = {
  signature: string;
  at: string;
  side: "buy" | "sell";
  symbol: string;
  mint: string;
  usd_value: number;
  token_amount: number;
  /** log lines written about this name strictly before the fill landed */
  before: ProofLogLine[];
  beforeCount: number;
  /** seconds between the first written mention and the fill */
  leadSeconds: number | null;
  /** which program executed it, read off the transaction itself */
  venue: string | null;
  venues: string[];
};

export type ProofClock = {
  /** log lines per utc hour of day, 0..23 */
  hours: number[];
  hoursCovered: number;
  daysCovered: number;
  longestGapMinutes: number | null;
  medianGapSeconds: number | null;
  sampleSize: number;
};

export type ProofAudit = {
  at: string;
  phase: string;
  side: string | null;
  symbol: string | null;
  verdict: string;
  note: string | null;
  signature: string | null;
  matchedAt: string | null;
  fired: { label: string; pass: boolean; detail: string }[];
  /** the raw inputs the rules were evaluated against, flattened for display */
  inputs: string[];
};

export type ProofCommit = {
  decisionAt: string;
  symbol: string | null;
  mint: string | null;
  side: string | null;
  verdict: string;
  hash: string;
  status: string;
  memoSignature: string | null;
  memoSlot: number | null;
  publishedAt: string | null;
  publishLatencyMs: number | null;
  fillSignature: string | null;
  fillAt: string | null;
  revealed: boolean;
  /** exact string to sha256 yourself; null while the commitment is still sealed */
  preimage: string | null;
};

export type ProofLatency = {
  samples: number;
  medianMs: number | null;
  p90Ms: number | null;
  fastestMs: number | null;
  slowestMs: number | null;
  /** buckets in ms: <1s, 1-3s, 3-10s, 10-60s, >60s */
  buckets: { label: string; count: number }[];
};

export type ProofPass = {
  at: string;
  symbol: string | null;
  note: string | null;
  failed: { label: string; detail: string }[];
};

export type ProofReport = {
  wallet: string;
  generatedAt: string;
  firstLogAt: string | null;
  counts: { logged: number; thoughts: number; reads: number; refused: number; acted: number; fills: number };
  fills: ProofFill[];
  clock: ProofClock;
  audit: ProofAudit[];
  refusals: ProofLogLine[];
  commits: ProofCommit[];
  binding: import("./precommit.server").BindingReport;
  executionPath: import("./verify.server").ExecutionPath;
  commitPublisher: string | null;
  commitsPublished: number;
  latency: ProofLatency;
  passes: ProofPass[];
  method: string[];
};

function esc(value: string) {
  return value.replace(/[%_,]/g, " ");
}

export async function buildProofReport(): Promise<ProofReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { OMO_WALLET } = await import("./wallet.server");

  const countKind = (kind: string) =>
    supabaseAdmin
      .from("omo_events")
      .select("kind", { count: "exact", head: true })
      .eq("kind", kind);

  const [
    loggedRes,
    thoughtRes,
    readRes,
    refusedCountRes,
    didRes,
    fillCountRes,
    firstRes,
    tradesRes,
    refusedRes,
    clockRes,
  ] = await Promise.all([
    supabaseAdmin.from("omo_events").select("kind", { count: "exact", head: true }),
    countKind("thought"),
    countKind("read"),
    countKind("refused"),
    countKind("did"),
    supabaseAdmin
      .from("omo_trades")
      .select("mint", { count: "exact", head: true })
      .not("mint", "in", `(${[SOL_MINT, ...STABLES].join(",")})`),
    supabaseAdmin.from("omo_events").select("at").order("at", { ascending: true }).limit(1),
    supabaseAdmin.from("omo_trades").select("*").order("at", { ascending: false }).limit(40),
    supabaseAdmin
      .from("omo_events")
      .select("at, kind, text")
      .eq("kind", "refused")
      .order("at", { ascending: false })
      .limit(12),
    supabaseAdmin.from("omo_events").select("at").order("at", { ascending: false }).limit(4000),
  ]);

  const counts = {
    logged: loggedRes.count ?? 0,
    thoughts: thoughtRes.count ?? 0,
    reads: readRes.count ?? 0,
    refused: refusedCountRes.count ?? 0,
    acted: didRes.count ?? 0,
    fills: fillCountRes.count ?? 0,
  };

  const rawFills = (tradesRes.data ?? []).filter(
    (t) => t.mint !== SOL_MINT && !STABLES.has(t.mint),
  );


  const { fetchFillVenue } = await import("./wallet.server");
  const fills: ProofFill[] = await Promise.all(
    rawFills.slice(0, 12).map(async (trade) => {
      const symbol = (trade.symbol ?? "").replace(/^\$/, "");
      let before: ProofLogLine[] = [];
      let beforeCount = 0;

      const [venue, windowRes] = await Promise.all([
        fetchFillVenue(trade.signature),
        symbol.length >= 3
          ? Promise.all([
              supabaseAdmin
                .from("omo_events")
                .select("at, kind, text")
                .ilike("text", `%${esc(symbol)}%`)
                .lt("at", trade.at)
                .order("at", { ascending: false })
                .limit(4),
              supabaseAdmin
                .from("omo_events")
                .select("at", { count: "exact", head: true })
                .ilike("text", `%${esc(symbol)}%`)
                .lt("at", trade.at),
            ])
          : null,
      ]);

      if (windowRes) {
        before = (windowRes[0].data ?? []) as ProofLogLine[];
        beforeCount = windowRes[1].count ?? before.length;
      }

      const earliest = before.at(-1)?.at ?? null;
      return {
        signature: trade.signature,
        at: trade.at,
        side: trade.side === "sell" ? "sell" : ("buy" as "buy" | "sell"),
        symbol: trade.symbol,
        mint: trade.mint,
        usd_value: Number(trade.usd_value ?? 0),
        token_amount: Number(trade.token_amount ?? 0),
        before,
        beforeCount,
        leadSeconds: earliest
          ? Math.max(0, Math.round((Date.parse(trade.at) - Date.parse(earliest)) / 1000))
          : null,
        venue: venue.label,
        venues: venue.programs,
      };
    }),
  );


  // the clock is the automation tell: a person sleeps, a loop does not. these are
  // real log timestamps bucketed by utc hour, plus the gaps between them.
  const stampsDesc = (clockRes.data ?? []).map((r) => Date.parse(r.at)).filter(Number.isFinite);
  const hours = new Array(24).fill(0) as number[];
  const days = new Set<string>();
  for (const ms of stampsDesc) {
    const d = new Date(ms);
    hours[d.getUTCHours()] = (hours[d.getUTCHours()] ?? 0) + 1;
    days.add(d.toISOString().slice(0, 10));
  }
  const gaps: number[] = [];
  for (let i = 0; i < stampsDesc.length - 1; i += 1) {
    const gap = Math.round(((stampsDesc[i] ?? 0) - (stampsDesc[i + 1] ?? 0)) / 1000);
    if (gap >= 0) gaps.push(gap);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const clock: ProofClock = {
    hours,
    hoursCovered: hours.filter((h) => h > 0).length,
    daysCovered: days.size,
    longestGapMinutes: sorted.length ? Math.round((sorted.at(-1) as number) / 60) : null,
    medianGapSeconds: sorted.length ? (sorted[Math.floor(sorted.length / 2)] ?? null) : null,
    sampleSize: stampsDesc.length,
  };

  const { readAuditLog, ruleLabel } = await import("./audit.server");
  const auditRows = await readAuditLog(20).catch(() => []);
  const audit: ProofAudit[] = auditRows.map((row) => ({
    at: row.at,
    phase: row.phase,
    side: row.side,
    symbol: row.symbol,
    verdict: row.verdict,
    note: row.note,
    signature: row.signature,
    matchedAt: row.matched_at,
    fired: row.rules.map((rule) => ({
      label: ruleLabel(rule.id),
      pass: rule.pass,
      detail: rule.detail,
    })),
    inputs: Object.entries(row.inputs).map(
      ([k, v]) => `${k}: ${Array.isArray(v) ? (v.length ? v.join("/") : "none") : String(v)}`,
    ),
  }));

  // pre-commitments: the hash of a decision, stamped on-chain before the trade.
  const { readCommitments, commitPublisher, commitPreimage, readBinding } = await import("./precommit.server");
  const commitRows = await readCommitments(24).catch(() => []);
  const publisher = await commitPublisher().catch(() => null);
  const binding = await readBinding(25).catch(() => ({ pairs: [], bound: 0, matched: 0, mismatched: 0 }));
  const commits: ProofCommit[] = commitRows.map((row) => ({
    decisionAt: row.decisionAt,
    symbol: row.symbol,
    mint: row.mint,
    side: row.side,
    verdict: row.verdict,
    hash: row.hash,
    status: row.status,
    memoSignature: row.memoSignature,
    memoSlot: row.memoSlot,
    publishedAt: row.publishedAt,
    publishLatencyMs: row.publishLatencyMs,
    fillSignature: row.fillSignature,
    fillAt: row.fillAt,
    revealed: row.revealed,
    preimage:
      row.revealed && row.nonce ? commitPreimage(row.payload, row.nonce) : null,
  }));
  const commitsPublished = commitRows.filter((row) => row.memoSignature).length;

  // decision to submit latency: a person does not hit send in the same beat,
  // hundreds of times, at four in the morning.
  const lat = commitRows
    .map((row) => row.publishLatencyMs)
    .filter((ms): ms is number => typeof ms === "number" && ms >= 0)
    .sort((a, b) => a - b);
  const pick = (q: number) => (lat.length ? (lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? null) : null);
  const bucketDefs: [string, number][] = [
    ["<1s", 1_000],
    ["1-3s", 3_000],
    ["3-10s", 10_000],
    ["10-60s", 60_000],
    [">60s", Number.POSITIVE_INFINITY],
  ];
  let prior = 0;
  const latency: ProofLatency = {
    samples: lat.length,
    medianMs: pick(0.5),
    p90Ms: pick(0.9),
    fastestMs: lat[0] ?? null,
    slowestMs: lat.at(-1) ?? null,
    buckets: bucketDefs.map(([label, ceiling]) => {
      const count = lat.filter((ms) => ms >= prior && ms < ceiling).length;
      prior = ceiling === Number.POSITIVE_INFINITY ? prior : ceiling;
      return { label, count };
    }),
  };

  const { readAuditPasses } = await import("./audit.server");
  const passRows = await readAuditPasses(50).catch(() => []);
  const passes: ProofPass[] = passRows.map((row) => ({
    at: row.at,
    symbol: row.symbol,
    note: row.note,
    failed: row.rules
      .filter((rule) => !rule.pass)
      .map((rule) => ({ label: ruleLabel(rule.id), detail: rule.detail })),
  }));

  return {
    wallet: OMO_WALLET,
    generatedAt: new Date().toISOString(),
    firstLogAt: firstRes.data?.[0]?.at ?? null,
    counts,
    fills,
    clock,
    audit,
    refusals: (refusedRes.data ?? []) as ProofLogLine[],
    commits,
    binding,
    executionPath: (await import("./verify.server")).EXECUTION_PATH,
    commitPublisher: publisher,
    commitsPublished,
    latency,
    passes,
    method: [
      "before a decision can become a trade, the loop hashes the whole decision — name, side, every rule and the numbers behind it, plus a random nonce — and writes only that hash into a memo on solana.",
      "the hash tells you nothing on its own. the point is that a validator stamped it at a time i do not control, so the decision provably existed before the fill.",
      "twenty minutes later the plaintext is revealed. hash it yourself with sha256 and it matches the memo already sitting in a confirmed block. faking that would mean rewriting solana history.",
      "the order itself is composed and signed here, not clicked. the route comes from jupiter's public api, the transaction is signed locally by the wallet key, and it is sent straight to mainnet rpc. fomo has no api and does not need one: it reads the same wallet you can read.",
      "/api/public/verify.json re-checks all of it against public rpc for you: it recomputes the hash from the revealed plaintext, pulls the memo and the fill off chain, and confirms the memo is in an earlier slot, the fill touches the mint the memo named, and the fill was signed by this wallet. four checks, pass or fail, no prose.",
      "every thought, read, refusal and action omo writes is stored with a server timestamp the moment it happens.",
      "every fill is read back off solana from omo's own wallet, with the transaction signature and block time, and names the program that executed it.",
      "the latency table is the gap between deciding and submitting, in milliseconds. hands do not do that consistently.",
      "the clock buckets log lines by hour of the day and shows the gaps, breaks included, so the cadence is visible instead of described.",
      "the passes are the full boring list — every name looked at and left alone, with the rule that stopped it. nobody fakes hundreds of nos.",
      "the same data is served raw at /api/public/proof.json so you can check it yourself instead of trusting the page.",
    ],
  };
}
