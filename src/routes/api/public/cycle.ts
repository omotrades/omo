/**
 * The trigger.
 *
 * The loop does not run because a browser is open. It runs because a scheduler
 * calls this endpoint, which is what makes the cadence on the clock panel machine
 * cadence instead of somebody refreshing a page. Point pg_cron or any external
 * scheduler at:
 *
 *   POST https://<host>/api/public/cycle
 *   x-omo-cycle-secret: <OMO_CYCLE_SECRET>
 *
 * The prefix is public so the scheduler needs no session, so the handler does the
 * authorisation itself: without a matching secret nothing runs. One decision
 * cycle per call, and the response is the step-by-step record of what happened,
 * including the refusals.
 */

import { createFileRoute } from "@tanstack/react-router";

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/public/cycle")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["OMO_CYCLE_SECRET"];
        const provided = request.headers.get("x-omo-cycle-secret") ?? "";
        if (!expected || !timingSafeEqual(provided, expected)) {
          return new Response("unauthorized", { status: 401 });
        }

        const url = new URL(request.url);
        const rotation = Number(url.searchParams.get("rotation") ?? 0) || 0;
        const { runDecisionCycle } = await import("@/lib/pipeline.server");
        const outcome = await runDecisionCycle({ rotation });

        return new Response(JSON.stringify(outcome, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      },
    },
  },
});
