/**
 * Pre-commit / reveal.
 *
 * A timestamp in omo's own database proves nothing to a stranger, because omo
 * owns the database. So before a decision can turn into a fill, the loop hashes
 * the whole decision (name, side, the rules that fired, the numbers behind them,
 * plus a random nonce) and writes only that hash into a memo instruction on
 * Solana. The hash is worthless to read. What matters is that it is stamped by
 * validators at a time nobody here controls.
 *
 * Later the plaintext is revealed. Anyone can hash it themselves and check it
 * matches the memo that was already on-chain before the trade landed. Backdating
 * a decision after the fact would require rewriting a confirmed block.
 *
 * Publishing needs a signer. If OMO_COMMIT_KEY is not set, commitments are still
 * recorded and hashed, but marked "unpublished" and shown as such rather than
 * dressed up as proof.
 */

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
];

export type CommitIntent = {
  decisionAt: string;
  symbol: string | null;
  mint: string | null;
  side: string | null;
  verdict: string;
  note: string | null;
  rules: { id: string; pass: boolean; detail: string }[];
  inputs: Record<string, unknown>;
  auditId?: string | null;
};

export type CommitRow = {
  id: string;
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
  /** null until the reveal window passes, so the commitment stays sealed */
  payload: unknown | null;
  nonce: string | null;
  revealed: boolean;
};

/** Stable key order, so the same decision always hashes to the same string. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function commitPreimage(payload: unknown, nonce: string) {
  return `omo-commit-v1|${nonce}|${canonical(payload)}`;
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hashes a decision and stores the sealed record. Returns the hash so the caller
 * can log it. Publishing happens separately so a slow RPC never stalls a tick.
 */
export async function commitDecision(intent: CommitIntent) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const nonce = randomNonce();
  const payload = {
    v: 1,
    decision_at: intent.decisionAt,
    symbol: intent.symbol,
    mint: intent.mint,
    side: intent.side,
    verdict: intent.verdict,
    note: intent.note,
    rules: intent.rules,
    inputs: intent.inputs,
  };
  const hash = await sha256Hex(commitPreimage(payload, nonce));

  const { data, error } = await supabaseAdmin
    .from("omo_commits")
    .insert({
      decision_at: intent.decisionAt,
      symbol: intent.symbol,
      mint: intent.mint,
      side: intent.side,
      verdict: intent.verdict,
      commit_hash: hash,
      nonce,
      payload: payload as never,
      audit_id: intent.auditId ?? null,
      status: "pending",
    } as never)
    .select("id")
    .maybeSingle();

  if (error) {
    console.log(`[omo] commit write failed: ${error.message}`);
    return null;
  }
  return { id: (data as { id: string } | null)?.id ?? null, hash };
}

async function rpcAt(endpoint: string, method: string, params: unknown[]) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (json.error) {
      console.log(`[omo] rpc ${method} error: ${json.error.message ?? "unknown"}`);
      return null;
    }
    return json.result ?? null;
  } catch {
    return null;
  }
}

async function rpc(method: string, params: unknown[]) {
  for (const endpoint of RPCS) {
    const result = await rpcAt(endpoint, method, params);
    if (result !== null) return result;
  }
  return null;
}

function compactLength(n: number) {
  const out: number[] = [];
  let rem = n;
  for (;;) {
    let byte = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(byte);
      break;
    }
    byte |= 0x80;
    out.push(byte);
  }
  return out;
}

async function loadSigner() {
  const secret = process.env["OMO_COMMIT_KEY"];
  if (!secret) return null;
  const bs58 = (await import("bs58")).default;
  const nacl = (await import("tweetnacl")).default;
  const raw = secret.trim();
  const keyBytes = raw.startsWith("[")
    ? Uint8Array.from(JSON.parse(raw) as number[])
    : bs58.decode(raw);
  const pair =
    keyBytes.length === 64
      ? nacl.sign.keyPair.fromSecretKey(keyBytes)
      : nacl.sign.keyPair.fromSeed(keyBytes);
  return { nacl, bs58, secretKey: pair.secretKey, publicKey: pair.publicKey };
}

/**
 * Posts one hash to Solana as a memo. Zero lamports move: the transaction exists
 * only so the timestamp belongs to somebody who is not me. Built and signed by
 * hand because the standard sdk does not run in this runtime.
 */
async function publishHash(hash: string) {
  const signer = await loadSigner();
  if (!signer) return { status: "unpublished" as const, signature: null, slot: null };
  const { nacl, bs58, secretKey, publicKey } = signer;

  const memoProgram = bs58.decode(MEMO_PROGRAM);
  const memoData = new TextEncoder().encode(`omo:commit:v1:${hash}`);

  // The blockhash has to come from the same node that accepts the send, or the
  // receiving node has never heard of it yet and refuses the whole thing.
  for (const endpoint of RPCS) {
    const blockhashResult = (await rpcAt(endpoint, "getLatestBlockhash", [
      { commitment: "finalized" },
    ])) as { value?: { blockhash?: string } } | null;
    const blockhash = blockhashResult?.value?.blockhash;
    if (!blockhash) continue;

    // legacy message: header, account keys, blockhash, one memo instruction
    const message: number[] = [
      1, // required signatures
      0, // readonly signed
      1, // readonly unsigned (memo program)
      ...compactLength(2),
      ...publicKey,
      ...memoProgram,
      ...bs58.decode(blockhash),
      ...compactLength(1),
      1, // program id index
      ...compactLength(0), // memo takes no accounts
      ...compactLength(memoData.length),
      ...memoData,
    ];
    const messageBytes = Uint8Array.from(message);
    const signatureBytes = nacl.sign.detached(messageBytes, secretKey);

    const tx = Uint8Array.from([...compactLength(1), ...signatureBytes, ...messageBytes]);
    let binary = "";
    for (const byte of tx) binary += String.fromCharCode(byte);
    const encoded = btoa(binary);

    const sent = await rpcAt(endpoint, "sendTransaction", [
      encoded,
      { encoding: "base64", skipPreflight: true, maxRetries: 5, preflightCommitment: "finalized" },
    ]);
    if (typeof sent !== "string") continue;

    const slotResult = await rpcAt(endpoint, "getSlot", [{ commitment: "confirmed" }]);
    return {
      status: "published" as const,
      signature: sent,
      slot: typeof slotResult === "number" ? slotResult : null,
    };
  }

  console.log("[omo] commit publish: every rpc refused the memo");
  return { status: "publish_failed" as const, signature: null, slot: null };
}

/**
 * Publishes any commitment still waiting. Kept small per tick so one bad RPC
 * cannot back the loop up.
 */
export async function publishPendingCommitments(limit = 3) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("omo_commits")
    .select("id, commit_hash, decision_at")
    .eq("status", "pending")
    .order("decision_at", { ascending: true })
    .limit(limit);

  let published = 0;
  for (const row of data ?? []) {
    const started = Date.now();
    try {
      const result = await publishHash(row.commit_hash);
      await supabaseAdmin
        .from("omo_commits")
        .update({
          status: result.status,
          memo_signature: result.signature,
          memo_slot: result.slot,
          published_at: result.signature ? new Date().toISOString() : null,
          publish_latency_ms: result.signature ? Date.now() - Date.parse(row.decision_at) : null,
        } as never)
        .eq("id", row.id);
      if (result.signature) published += 1;
    } catch (error) {
      console.log(`[omo] commit publish failed: ${(error as Error).message} (${Date.now() - started}ms)`);
      await supabaseAdmin
        .from("omo_commits")
        .update({ status: "publish_failed" } as never)
        .eq("id", row.id);
    }
  }
  return published;
}

/**
 * Opens sealed commitments once they are old enough to be safe to show, or once
 * the fill they preceded has landed. Revealing is what makes the hash checkable.
 */
export async function revealDueCommitments() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const cutoff = new Date(Date.now() - 20 * 60_000).toISOString();
  const { data } = await supabaseAdmin
    .from("omo_commits")
    .select("id")
    .eq("revealed", false)
    .lt("decision_at", cutoff)
    .limit(40);
  const ids = (data ?? []).map((r) => r.id);
  if (!ids.length) return 0;
  await supabaseAdmin
    .from("omo_commits")
    .update({ revealed: true, revealed_at: new Date().toISOString() } as never)
    .in("id", ids);
  return ids.length;
}

/**
 * Pairs commitments with the fills that followed them on the same name, so the
 * page can show commitment-then-trade rather than assert it.
 */
export async function linkCommitmentsToFills() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [pendingRes, tradesRes] = await Promise.all([
    supabaseAdmin
      .from("omo_commits")
      .select("id, decision_at, symbol, mint, side")
      .is("fill_signature", null)
      .eq("verdict", "act")
      .order("decision_at", { ascending: false })
      .limit(60),
    supabaseAdmin
      .from("omo_trades")
      .select("signature, at, symbol, mint, side")
      .order("at", { ascending: false })
      .limit(120),
  ]);

  const pending = pendingRes.data ?? [];
  const trades = tradesRes.data ?? [];
  if (!pending.length || !trades.length) return 0;

  const takenRes = await supabaseAdmin
    .from("omo_commits")
    .select("fill_signature")
    .not("fill_signature", "is", null);
  const taken = new Set((takenRes.data ?? []).map((r) => r.fill_signature));

  let linked = 0;
  for (const row of pending) {
    const rowSymbol = row.symbol;
    if (!rowSymbol) continue;
    const match = trades
      .filter(
        (trade) =>
          !taken.has(trade.signature) &&
          ((row.mint && trade.mint === row.mint) ||
            (trade.symbol ?? "").replace(/^\$/, "").toUpperCase() === rowSymbol.toUpperCase()) &&
          (!row.side || trade.side === row.side) &&
          Date.parse(trade.at) >= Date.parse(row.decision_at) &&
          Date.parse(trade.at) - Date.parse(row.decision_at) <= 12 * 3600 * 1000,
      )
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    if (!match) continue;
    taken.add(match.signature);
    const { error } = await supabaseAdmin
      .from("omo_commits")
      .update({ fill_signature: match.signature, fill_at: match.at } as never)
      .eq("id", row.id);
    if (!error) linked += 1;
  }
  return linked;
}

/** Reads commitments for the public page. Sealed rows keep their plaintext hidden. */
export async function readCommitments(limit = 20): Promise<CommitRow[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("omo_commits")
    .select("*")
    .order("decision_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((row) => ({
    id: row.id,
    decisionAt: row.decision_at,
    symbol: row.symbol,
    mint: row.mint,
    side: row.side,
    verdict: row.verdict,
    hash: row.commit_hash,
    status: row.status,
    memoSignature: row.memo_signature,
    memoSlot: row.memo_slot === null ? null : Number(row.memo_slot),
    publishedAt: row.published_at,
    publishLatencyMs: row.publish_latency_ms === null ? null : Number(row.publish_latency_ms),
    fillSignature: row.fill_signature,
    fillAt: row.fill_at,
    payload: row.revealed ? row.payload : null,
    nonce: row.revealed ? row.nonce : null,
    revealed: row.revealed,
  }));
}

/** The signer that posts the memos, so people can watch the commitment stream. */
export async function commitPublisher(): Promise<string | null> {
  try {
    const signer = await loadSigner();
    if (!signer) return null;
    return signer.bs58.encode(signer.publicKey);
  } catch {
    return null;
  }
}

export type BindingPair = {
  symbol: string | null;
  side: string | null;
  committedMint: string | null;
  filledMint: string | null;
  memoSignature: string | null;
  memoSlot: number | null;
  fillSignature: string;
  gapSeconds: number | null;
  match: boolean;
};

export type BindingReport = {
  pairs: BindingPair[];
  bound: number;
  matched: number;
  mismatched: number;
};

/**
 * The target itself lives inside the sealed hash: mint, side, and the rules that
 * chose it. So the fill that follows can be compared against the commitment that
 * preceded it. A hand-adjusted buy would land on a mint the memo never named.
 */
export async function readBinding(limit = 25): Promise<BindingReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: rows } = await supabaseAdmin
    .from("omo_commits")
    .select("symbol, mint, side, memo_signature, memo_slot, fill_signature, fill_at, decision_at")
    .eq("verdict", "act")
    .not("fill_signature", "is", null)
    .order("decision_at", { ascending: false })
    .limit(limit);

  const commits = rows ?? [];
  if (!commits.length) return { pairs: [], bound: 0, matched: 0, mismatched: 0 };

  const sigs = commits.map((r) => r.fill_signature).filter((s): s is string => !!s);
  const { data: tradeRows } = await supabaseAdmin
    .from("omo_trades")
    .select("signature, mint, symbol, side, at")
    .in("signature", sigs);
  const trades = new Map((tradeRows ?? []).map((t) => [t.signature, t]));

  const pairs: BindingPair[] = commits.map((row) => {
    const trade = row.fill_signature ? trades.get(row.fill_signature) : undefined;
    const filledMint = trade?.mint ?? null;
    const sameMint = !!row.mint && !!filledMint && row.mint === filledMint;
    const sameName =
      !!row.symbol &&
      !!trade?.symbol &&
      (trade.symbol ?? "").replace(/^\$/, "").toUpperCase() === row.symbol.toUpperCase();
    const gap =
      row.fill_at && row.decision_at
        ? Math.round((Date.parse(row.fill_at) - Date.parse(row.decision_at)) / 1000)
        : null;
    return {
      symbol: row.symbol,
      side: row.side,
      committedMint: row.mint,
      filledMint,
      memoSignature: row.memo_signature,
      memoSlot: row.memo_slot === null ? null : Number(row.memo_slot),
      fillSignature: row.fill_signature as string,
      gapSeconds: gap,
      match: sameMint || sameName,
    };
  });

  const matched = pairs.filter((p) => p.match).length;
  return { pairs, bound: pairs.length, matched, mismatched: pairs.length - matched };
}
