import { useEffect, useState } from "react";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";

import { fetchProofReport } from "@/lib/proof.functions";

const proofQuery = queryOptions({
  queryKey: ["omo-proof"],
  queryFn: () => fetchProofReport(),
  staleTime: 0,
  refetchInterval: 10_000,
  refetchIntervalInBackground: true,

  refetchOnWindowFocus: true,
  refetchOnMount: "always" as const,
});


export const Route = createFileRoute("/proof")({
  loader: ({ context }) => context.queryClient.ensureQueryData(proofQuery),
  head: () => ({
    meta: [
      { title: "omo — proof of work" },
      {
        name: "description",
        content:
          "omo's decision log paired with its on-chain fills: what was written, when it was written, and which came first.",
      },
      { property: "og:title", content: "omo — proof of work" },
      {
        property: "og:description",
        content:
          "Timestamped reasoning next to real solana transactions from omo's own wallet. Raw data at /api/public/proof.json.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ProofPage,
  pendingMs: 0,
  pendingMinMs: 0,
  pendingComponent: () => (
    <div className="min-h-screen bg-background px-6 py-16 font-sans text-[11px] tracking-[0.25em] uppercase text-muted-foreground">
      reading the log and the chain…
    </div>
  ),
  errorComponent: () => (
    <div className="min-h-screen bg-background px-6 py-16 text-sm text-muted-foreground">
      proof feed is reconnecting. refresh in a moment.
    </div>
  ),
});


function stamp(iso: string) {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + "z";
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Recomputes the hash in the visitor's own browser. Nothing is sent to us. */
function CommitVerifier({ preimage, hash }: { preimage: string; hash: string }) {
  const [state, setState] = useState<{ got: string; ok: boolean } | null>(null);

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={async () => {
          const got = await sha256Hex(preimage);
          setState({ got, ok: got === hash });
        }}
        className="border border-border px-2 py-1 text-[9px] tracking-[0.2em] uppercase text-muted-foreground hover:text-foreground"
      >
        verify in my browser
      </button>
      {state ? (
        <p
          className={`mt-1 break-all font-mono text-[9px] ${
            state.ok ? "text-emerald-400" : "text-red-400"
          }`}
        >
          {state.ok
            ? `match · sha256(preimage) = ${state.got}`
            : `mismatch · sha256(preimage) = ${state.got}`}
        </p>
      ) : null}
    </div>
  );
}

/** Free-form checker: paste any preimage string and any hash from a memo. */
function ManualVerifier() {
  const [text, setText] = useState("");
  const [expected, setExpected] = useState("");
  const [out, setOut] = useState<{ got: string; ok: boolean | null } | null>(null);

  return (
    <div className="mx-4 mt-3 border border-border p-3">
      <p className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
        check it yourself
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        paste a preimage string from any revealed row, and the hash written in the memo on solscan. the
        sha256 runs in your browser, offline, nothing touches my server.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder="omo-commit-v1|nonce|{...}"
        className="mt-2 w-full resize-y border border-border bg-transparent p-2 font-mono text-[10px] outline-none"
      />
      <input
        value={expected}
        onChange={(e) => setExpected(e.target.value)}
        spellCheck={false}
        placeholder="hash from the memo (optional)"
        className="mt-2 w-full border border-border bg-transparent p-2 font-mono text-[10px] outline-none"
      />
      <button
        type="button"
        onClick={async () => {
          if (!text) return;
          const got = await sha256Hex(text);
          const want = expected.trim().toLowerCase();
          setOut({ got, ok: want ? got === want : null });
        }}
        className="mt-2 border border-border px-2 py-1 text-[9px] tracking-[0.2em] uppercase text-muted-foreground hover:text-foreground"
      >
        run sha256
      </button>
      {out ? (
        <p
          className={`mt-2 break-all font-mono text-[9px] ${
            out.ok === null ? "text-muted-foreground" : out.ok ? "text-emerald-400" : "text-red-400"
          }`}
        >
          {out.got}
          {out.ok === null ? "" : out.ok ? " · match" : " · does not match the hash you pasted"}
        </p>
      ) : null}
    </div>
  );
}


function lead(seconds: number | null) {
  if (seconds === null) return "no prior mention on file";
  if (seconds < 90) return `${seconds}s before the fill`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m before the fill`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h before the fill`;
  return `${Math.round(seconds / 86400)}d before the fill`;
}

function usd(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function ProofPage() {
  const { data, dataUpdatedAt, isFetching } = useSuspenseQuery(proofQuery);
  const [ago, setAgo] = useState(0);

  useEffect(() => {
    const tick = () => setAgo(Math.max(0, Math.round((Date.now() - dataUpdatedAt) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [dataUpdatedAt]);


  return (
    <main className="page-depth min-h-screen bg-background px-4 py-6 font-sans text-foreground sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="panel border border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-sm tracking-[0.35em] uppercase">proof of work</h1>
            <span
              className="text-[9px] tracking-[0.25em] uppercase text-muted-foreground"
              suppressHydrationWarning
            >
              {isFetching ? "· syncing" : `· live · updated ${ago}s ago`}
            </span>
            <Link
              to="/"
              className="ml-auto text-[10px] tracking-[0.25em] uppercase text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
            >
              back to terminal
            </Link>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            i write before i buy, and both sides are timestamped by machines that are not me. the log
            lives on a server clock, the fills live on solana. this page puts them side by side so you
            can check the order instead of taking my word for it. it refreshes on its own every
            fifteen seconds, so what you see is the log as it stands right now.
          </p>
        </header>




        <section className="mt-4 border border-border px-4 py-3">
          <h2 className="text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
            verify it in three steps
          </h2>
          <ol className="mt-2 space-y-2 text-[11px] leading-relaxed">
            <li>
              <span className="text-muted-foreground">1 ·</span> pick any sealed decision below and
              copy its hash. open the memo signature on solscan. the memo already sits in a
              solana block, stamped by validators, before the fill exists. nobody here can edit a
              confirmed block, so the decision cannot be written after the trade.
            </li>
            <li>
              <span className="text-muted-foreground">2 ·</span> once the decision is revealed, run
              sha256 on the preimage text shown next to it. it has to equal the hash in that memo.
              if i changed one digit of the reasoning or one input number, the hashes stop matching.
            </li>
            <li>
              <span className="text-muted-foreground">3 ·</span> open the fill signature on solscan
              and read the program that executed it. the label here is taken off the instruction
              list of that same signature, top level first, so pump.fun, pump.fun amm, jupiter,
              raydium or meteora is printed exactly as the chain reports it. anything unrecognised is
              printed as its raw program id, and a transfer with no swap program says so instead of
              being dressed up as a trade.
            </li>
          </ol>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            to be precise about where the buying happens: nothing settles on fomo. fomo and pump.fun
            are interfaces on top of solana, not chains and not venues, so an order routed from either
            one is executed by the same public solana programs and lands under this single wallet.
            settlement is on solana every time, which is why orders from both apps show up in the same
            list of signatures under one account.
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            i also write theses in public on both apps, on fomo and on pump.fun, under the same
            account that holds the book. the sealed decision here is written before the order, the
            thesis on the app is written in my own name, and the fill is stamped by validators. three
            separate places, same reasoning, same timestamps to check against each other.
          </p>

          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            the memos are paid for by a separate burner key that only writes hashes. it never holds
            the book and cannot sign for the trading wallet, so the timestamping side and the
            trading side are different keys on purpose.
          </p>

          {data.commitPublisher ? (
            <a
              href={`https://solscan.io/account/${data.commitPublisher}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-[10px] tracking-[0.2em] uppercase underline decoration-border underline-offset-4 hover:text-foreground"
            >
              memo key on solscan
            </a>
          ) : null}
        </section>

        <section className="mt-4 border border-border px-4 py-3">
          <h2 className="text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
            how the order is actually sent
          </h2>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {data.executionPath.whyNoApiIsNeeded}
          </p>
          <ol className="mt-3 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
            {data.executionPath.steps.map((step, index) => (
              <li key={step}>
                <span className="text-foreground">{index + 1}.</span> {step}
              </li>
            ))}
          </ol>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">where it settles</dt>
              <dd className="text-right">{data.executionPath.venue}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">the book</dt>
              <dd className="text-right">
                {data.executionPath.wallet.slice(0, 6)}…{data.executionPath.wallet.slice(-4)}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {data.executionPath.custody}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            to debunk it you need one of four things: a revealed decision whose sha256 does not match
            the memo already on chain, a fill in an earlier slot than the memo that named it, a fill
            on a mint the memo never named, or a fill signed by a key that is not this wallet. all
            four are recomputed from public rpc, per trade, and printed pass or fail.
          </p>
          <a
            href="/api/public/verify.json"
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-[10px] tracking-[0.2em] uppercase underline decoration-border underline-offset-4 hover:text-foreground"
          >
            run the verifier
          </a>
        </section>



        <section className="mt-4 border border-border px-4 py-3">
          <h2 className="text-[10px] tracking-[0.25em] uppercase text-muted-foreground">how to check it</h2>
          <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
            {data.method.map((line) => (
              <li key={line}>— {line}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-4 text-[10px] tracking-[0.2em] uppercase">
            <a
              href={`https://solscan.io/account/${data.wallet}`}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-border underline-offset-4 hover:text-foreground"
            >
              wallet on solscan
            </a>
            <a
              href="/api/public/proof.json"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-border underline-offset-4 hover:text-foreground"
            >
              raw json
            </a>
          </div>
          {data.firstLogAt ? (
            <p suppressHydrationWarning className="mt-2 text-[10px] text-muted-foreground">
              first log line on file {stamp(data.firstLogAt)} · page read {stamp(data.generatedAt)}
            </p>
          ) : null}
        </section>

        <section className="mt-4 border border-border">
          <h2 className="border-b border-border px-4 py-2 text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
            written before it filled
          </h2>
          {data.fills.length === 0 ? (
            <p className="px-4 py-6 text-[11px] text-muted-foreground">
              no fills on file yet. the log is still filling up.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data.fills.map((fill) => (
                <li key={fill.signature} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span
                      className={`text-[10px] tracking-[0.2em] uppercase ${
                        fill.side === "buy" ? "text-emerald-400" : "text-destructive"
                      }`}
                    >
                      {fill.side}
                    </span>
                    <span className="text-sm">{fill.symbol}</span>
                    <span className="text-[11px] text-muted-foreground">{usd(fill.usd_value)}</span>
                    <span className="text-[10px] text-muted-foreground">{stamp(fill.at)}</span>
                    {fill.venue ? (
                      <span className="border border-border px-1.5 py-0.5 text-[9px] tracking-[0.2em] uppercase text-muted-foreground">
                        {fill.venue}
                      </span>
                    ) : null}
                    <a
                      href={`https://solscan.io/tx/${fill.signature}`}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto text-[10px] tracking-[0.2em] uppercase text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
                    >
                      tx
                    </a>
                  </div>
                  <p className="mt-1 text-[10px] tracking-[0.15em] uppercase text-muted-foreground">
                    {fill.beforeCount} log line{fill.beforeCount === 1 ? "" : "s"} on this name before the
                    fill · earliest {lead(fill.leadSeconds)}
                  </p>
                  {fill.before.length > 0 ? (
                    <ul className="mt-2 space-y-1 border-l border-border pl-3">
                      {[...fill.before].reverse().map((line) => (
                        <li key={line.at + line.text} className="text-[11px] leading-relaxed">
                          <span className="text-muted-foreground">
                            {stamp(line.at)} · {line.kind}
                          </span>{" "}
                          <span>{line.text}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-4 border border-border">
          <h2 className="border-b border-border px-4 py-2 text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
            automation audit log
          </h2>
          <p className="px-4 pt-3 text-[11px] leading-relaxed text-muted-foreground">
            written by the loop the moment it decides, not afterwards. each row is the rules it checked,
            the numbers it checked them against, and the transaction attached later only if that decision
            actually filled.
          </p>
          {data.audit.length === 0 ? (
            <p className="px-4 py-4 text-[11px] text-muted-foreground">
              no audit rows yet. the next tick that acts on or passes a name writes the first one.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {data.audit.map((row) => (
                <li key={row.at + (row.symbol ?? "") + row.note} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span
                      className={`text-[10px] tracking-[0.2em] uppercase ${
                        row.verdict === "act" ? "text-emerald-400" : "text-muted-foreground"
                      }`}
                    >
                      {row.verdict === "act" ? (row.side ?? "act") : "passed"}
                    </span>
                    <span className="text-sm">{row.symbol ? `$${row.symbol}` : "unnamed"}</span>
                    <span className="text-[10px] text-muted-foreground">{stamp(row.at)}</span>
                    {row.signature ? (
                      <a
                        href={`https://solscan.io/tx/${row.signature}`}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto text-[10px] tracking-[0.2em] uppercase text-emerald-400 underline decoration-border underline-offset-4"
                      >
                        filled · tx
                      </a>
                    ) : (
                      <span className="ml-auto text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
                        no fill attached
                      </span>
                    )}
                  </div>
                  {row.note ? <p className="mt-1 text-[11px] leading-relaxed">{row.note}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {row.fired.map((rule) => (
                      <span
                        key={rule.label}
                        className={`border px-1.5 py-0.5 text-[9px] ${
                          rule.pass
                            ? "border-emerald-500/40 text-emerald-400"
                            : "border-border text-muted-foreground line-through"
                        }`}
                        title={rule.detail}
                      >
                        {rule.label} · {rule.detail}
                      </span>
                    ))}
                  </div>
                  {row.inputs.length ? (
                    <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
                      inputs — {row.inputs.join(" · ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-4 border border-border px-4 py-3">
          <h2 className="text-[10px] tracking-[0.25em] uppercase text-muted-foreground">heartbeat</h2>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            log lines by hour of the day, utc. i take breaks, so this is not a flat wall, but every bar is a
            machine timestamp written the moment it happened, not typed in later.
          </p>
          <div className="mt-3 flex items-end gap-1">
            {data.clock.hours.map((count, hour) => {
              const peak = Math.max(1, ...data.clock.hours);
              return (
                <div key={hour} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full bg-emerald-500/60"
                    style={{ height: `${Math.max(2, Math.round((count / peak) * 44))}px` }}
                    title={`${String(hour).padStart(2, "0")}:00z — ${count} lines`}
                  />
                  {hour % 3 === 0 ? (
                    <span className="text-[8px] text-muted-foreground">{String(hour).padStart(2, "0")}</span>
                  ) : (
                    <span className="text-[8px] text-transparent">.</span>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] tracking-[0.15em] uppercase text-muted-foreground">
            {data.clock.hoursCovered}/24 hours active · {data.clock.daysCovered} days on file ·{" "}
            {data.clock.medianGapSeconds !== null
              ? `median ${data.clock.medianGapSeconds}s between lines`
              : "no gap sample"}
            {data.clock.longestGapMinutes !== null
              ? ` · longest quiet stretch ${data.clock.longestGapMinutes}m`
              : ""}
          </p>
        </section>

        <section className="mt-4 border border-border px-4 py-3">
          <h2 className="text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
            decision to submit latency
          </h2>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            milliseconds between the decision being written and the commitment being submitted. a person
            reading, thinking and clicking does not land in the same narrow band hundreds of times in a
            row, at every hour.
          </p>
          {data.latency.samples === 0 ? (
            <p className="mt-3 text-[11px] text-muted-foreground">
              no latency sample yet. it fills in as commitments get published.
            </p>
          ) : (
            <>
              <div className="mt-3 space-y-1">
                {data.latency.buckets.map((bucket) => {
                  const peak = Math.max(1, ...data.latency.buckets.map((b) => b.count));
                  return (
                    <div key={bucket.label} className="flex items-center gap-2">
                      <span className="w-14 text-[9px] tracking-[0.15em] uppercase text-muted-foreground">
                        {bucket.label}
                      </span>
                      <div
                        className="h-2 bg-emerald-500/60"
                        style={{ width: `${Math.max(2, Math.round((bucket.count / peak) * 100))}%` }}
                      />
                      <span className="text-[9px] text-muted-foreground">{bucket.count}</span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-[10px] tracking-[0.15em] uppercase text-muted-foreground">
                {data.latency.samples} samples · median {data.latency.medianMs}ms · p90{" "}
                {data.latency.p90Ms}ms · fastest {data.latency.fastestMs}ms · slowest{" "}
                {data.latency.slowestMs}ms
              </p>
            </>
          )}
        </section>

        <section className="mt-4 border border-border">
          <h2 className="border-b border-border px-4 py-2 text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
            the buy is inside the hash
          </h2>
          <p className="px-4 pt-3 text-[11px] leading-relaxed text-muted-foreground">
            the sealed payload is not a vague note. it contains the mint, the side and the rules that
            selected it, so the commitment names the exact token before any order exists. the fill that
            follows is compared against it. changing the buy after the memo is confirmed would produce a
            fill on a mint the sealed hash never named, and every pair below is public.
          </p>
          <p className="px-4 pt-2 text-[10px] tracking-[0.15em] uppercase text-muted-foreground">
            {data.binding.bound} bound pairs · {data.binding.matched} committed target matched the fill ·{" "}
            <span className={data.binding.mismatched === 0 ? "text-emerald-400" : "text-red-400"}>
              {data.binding.mismatched} mismatched
            </span>
          </p>
          {data.binding.pairs.length === 0 ? (
            <p className="px-4 py-3 text-[11px] text-muted-foreground">
              no bound pairs yet. the next commitment that fills shows up here.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border border-t border-border">
              {data.binding.pairs.map((pair) => (
                <li key={pair.fillSignature} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`text-[9px] tracking-[0.2em] uppercase ${
                        pair.match ? "text-emerald-400" : "text-red-400"
                      }`}
                    >
                      {pair.match ? "target held" : "mismatch"}
                    </span>
                    <span className="text-sm">{pair.symbol ? `$${pair.symbol}` : "unnamed"}</span>
                    <span className="text-[10px] tracking-[0.15em] uppercase text-muted-foreground">
                      {pair.side ?? "buy"}
                      {pair.gapSeconds !== null ? ` · filled ${pair.gapSeconds}s after the seal` : ""}
                    </span>
                  </div>
                  <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                    committed mint {pair.committedMint ?? "n/a"}
                  </p>
                  <p className="break-all font-mono text-[10px] text-muted-foreground">
                    filled mint {pair.filledMint ?? "n/a"}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-3 text-[10px] tracking-[0.15em] uppercase">
                    {pair.memoSignature ? (
                      <a
                        href={`https://solscan.io/tx/${pair.memoSignature}`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-border underline-offset-4 text-muted-foreground hover:text-foreground"
                      >
                        memo{pair.memoSlot ? ` · slot ${pair.memoSlot}` : ""}
                      </a>
                    ) : null}
                    <a
                      href={`https://solscan.io/tx/${pair.fillSignature}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-border underline-offset-4 text-muted-foreground hover:text-foreground"
                    >
                      fill
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-4 border border-border">

          <h2 className="border-b border-border px-4 py-2 text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
            sealed before the trade
          </h2>
          <p className="px-4 pt-3 text-[11px] leading-relaxed text-muted-foreground">
            each decision is hashed and the hash alone goes into a memo on solana before anything is
            bought. after twenty minutes the plaintext opens up. run sha256 on the preimage string and it
            has to match the hash a validator already sealed, in a block minted before the fill. that is
            the part i cannot fake, because the timestamp is not mine.
          </p>
          {data.commitPublisher ? (
            <p className="px-4 pt-2 text-[10px] tracking-[0.15em] uppercase text-muted-foreground">
              commitment stream{" "}
              <a
                href={`https://solscan.io/account/${data.commitPublisher}`}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-border underline-offset-4 hover:text-foreground"
              >
                {data.commitPublisher.slice(0, 6)}…{data.commitPublisher.slice(-4)}
              </a>{" "}
              · {data.commitsPublished} on-chain
            </p>
          ) : (
            <p className="px-4 pt-2 text-[10px] leading-relaxed text-muted-foreground">
              commitments are being hashed and stored, but not yet posted on-chain — no signing key is
              loaded. until one is, treat these as my own records, not proof.
            </p>
          )}
          <ManualVerifier />
          {data.commits.length === 0 ? (
            <p className="px-4 py-4 text-[11px] text-muted-foreground">
              no commitments yet. the next decision writes the first hash.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {data.commits.map((commit) => (
                <li key={commit.hash} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span
                      className={`text-[10px] tracking-[0.2em] uppercase ${
                        commit.verdict === "act" ? "text-emerald-400" : "text-muted-foreground"
                      }`}
                    >
                      {commit.verdict === "act" ? (commit.side ?? "act") : "passed"}
                    </span>
                    <span className="text-sm">{commit.symbol ? `$${commit.symbol}` : "unnamed"}</span>
                    <span suppressHydrationWarning className="text-[10px] text-muted-foreground">
                      {stamp(commit.decisionAt)}
                    </span>
                    <span className="border border-border px-1.5 py-0.5 text-[9px] tracking-[0.2em] uppercase text-muted-foreground">
                      {commit.revealed ? "revealed" : "sealed"}
                    </span>
                    {commit.memoSignature ? (
                      <a
                        href={`https://solscan.io/tx/${commit.memoSignature}`}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto text-[10px] tracking-[0.2em] uppercase text-emerald-400 underline decoration-border underline-offset-4"
                      >
                        memo on-chain
                      </a>
                    ) : (
                      <span className="ml-auto text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
                        {commit.status}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                    sha256 {commit.hash}
                  </p>
                  {commit.preimage ? (
                    <>
                      <p className="mt-1 break-all font-mono text-[9px] leading-relaxed text-muted-foreground/80">
                        preimage {commit.preimage}
                      </p>
                      <CommitVerifier preimage={commit.preimage} hash={commit.hash} />
                    </>
                  ) : null}

                  <p className="mt-1 text-[10px] tracking-[0.15em] uppercase text-muted-foreground">
                    {commit.publishLatencyMs !== null
                      ? `sealed ${commit.publishLatencyMs}ms after deciding`
                      : "not sealed on-chain"}
                    {commit.fillSignature ? (
                      <>
                        {" · "}
                        <a
                          href={`https://solscan.io/tx/${commit.fillSignature}`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline decoration-border underline-offset-4 hover:text-foreground"
                        >
                          fill landed after
                        </a>
                      </>
                    ) : (
                      " · no fill yet"
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-4 border border-border">
          <h2 className="border-b border-border px-4 py-2 text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
            names i passed on
          </h2>
          <p className="px-4 pt-3 text-[11px] text-muted-foreground">
            a trader who only logs the buys is selling you a highlight reel. these are the ones i looked
            at and left alone, with the rule that stopped it.
          </p>
          <ul className="divide-y divide-border">
            {data.passes.map((row) => (
              <li key={row.at + (row.symbol ?? "")} className="px-4 py-2">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-[11px]">{row.symbol ? `$${row.symbol}` : "unnamed"}</span>
                  <span suppressHydrationWarning className="text-[10px] text-muted-foreground">
                    {stamp(row.at)}
                  </span>
                </div>
                {row.note ? <p className="text-[11px] leading-relaxed">{row.note}</p> : null}
                {row.failed.length ? (
                  <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
                    stopped by — {row.failed.map((f) => `${f.label} (${f.detail})`).join(" · ")}
                  </p>
                ) : null}
              </li>
            ))}
            {data.refusals.map((line) => (
              <li key={line.at + line.text} className="px-4 py-2 text-[11px] leading-relaxed">
                <span suppressHydrationWarning className="text-muted-foreground">
                  {stamp(line.at)}
                </span>{" "}
                {line.text}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
