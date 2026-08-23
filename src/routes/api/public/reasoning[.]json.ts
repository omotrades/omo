/**
 * Who wrote the words on the page.
 *
 * The standing objection is that the visible thinking is a phrase bank rolling
 * in the browser. That is a checkable claim, so this endpoint answers it with
 * data instead of prose: every published line carries the author of its words,
 * written into the row at the same moment as the text, server side.
 *
 *   author "model"  the sentence came out of a model call on this server. the
 *                   model id, the model the stage was designed around, and the
 *                   server timestamp are stored on the row.
 *   author "code"   the sentence is a formatter around live numbers. the data
 *                   source is named so the same figures can be pulled directly.
 *   author "hand"   the operator wrote it. pinned theses and the cabin rooms are
 *                   in this bucket and are labelled as such rather than passed
 *                   off as machine output.
 *
 * The client is included in the report because it is part of the claim: the
 * browser receives finished strings and renders them. It composes no sentence,
 * holds no candidate list, and picks nothing at random. The only thing the page
 * animates on its own is the colour cycle on the ascii art and a one second
 * clock, both stated below.
 */

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/reasoning.json")({
  server: {
    handlers: {
      GET: async () => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { MODEL_ROUTES } = await import("@/lib/models.server");
        const { resolveModelApiKey } = await import("@/lib/ai-gateway.server");

        const [eventsRes, verdictsRes] = await Promise.all([
          supabaseAdmin
            .from("omo_events")
            .select("id, at, kind, text, meta")
            .order("at", { ascending: false })
            .limit(60),
          supabaseAdmin
            .from("omo_meta")
            .select("v, updated_at")
            .eq("k", "verdicts")
            .maybeSingle(),
        ]);

        const events = eventsRes.data ?? [];
        const authorOf = (meta: unknown) =>
          (meta as { author?: string } | null)?.author ?? "unstamped";

        const counts = events.reduce<Record<string, number>>((acc, row) => {
          const key = authorOf(row.meta);
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {});

        const verdictMeta = verdictsRes.data?.v as
          | { list?: unknown[]; author?: Record<string, unknown> }
          | null;

        const body = {
          generatedAt: new Date().toISOString(),
          question: "which words on the page were written by a model, and where were they written",
          client: {
            composesText: false,
            hasCandidatePhrases: false,
            randomSelection: false,
            animates: [
              "a one second clock for the countdown",
              "a colour cycle over ascii art already fetched from the server",
            ],
            note: "the browser renders finished strings. every sentence below was written on a server and stored with its author before any page requested it, which is why the timestamps here are server timestamps and not render times.",
            howToCheck:
              "load the page with javascript disabled, or read the server rendered html: the same sentences are already in it. then compare them against the rows in this endpoint.",
          },
          reasoningStage: {
            declaredModel: MODEL_ROUTES.reasoning.primary,
            fallbackChain: MODEL_ROUTES.reasoning.fallbacks,
            modelKeyLoaded: Boolean(resolveModelApiKey()),
            note: "when the declared model is unreachable the row records the model that actually answered and marks the line degraded, rather than claiming the declared one.",
          },
          authorship: {
            counts,
            legend: {
              model: "written by the reasoning model on this server at the stored timestamp",
              code: "formatted from live data by code, with the data source named on the row",
              hand: "written by the operator and labelled as hand written wherever it is shown",
              unstamped:
                "written before per line authorship was recorded. kept visible rather than deleted, and counted here so the ratio is public.",
            },
          },
          handWritten: {
            pinnedTheses:
              "positions the operator entered by hand carry the operator's own thesis text. declared hand written in the provenance block on the page.",
            cabinRooms:
              "the cabin rooms and the furnace are hand written lore, refiled on a fixed daily rotation by utc day index. no model writes them and they are not presented as the agent reasoning.",
          },
          verdicts: {
            updatedAt: verdictsRes.data?.updated_at ?? null,
            author: verdictMeta?.author ?? null,
            count: Array.isArray(verdictMeta?.list) ? verdictMeta.list.length : 0,
          },
          lines: events.map((row) => ({
            at: row.at,
            kind: row.kind,
            author: authorOf(row.meta),
            provenance: row.meta ?? null,
            text: row.text,
          })),
        };

        return new Response(JSON.stringify(body, null, 2), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});
