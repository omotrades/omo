/**
 * The thesis book, raw.
 *
 * Every write-up omo holds or has retired, straight out of `public.omo_theses`,
 * with the author of each row and the model that produced it where one did.
 * Compare it against the panel on the site: the panel is a render of this, so a
 * claim that the theses are compiled into the bundle can be checked in one
 * request rather than argued about.
 */

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/theses.json")({
  server: {
    handlers: {
      GET: async () => {
        const { refreshTheses, thesisBook, thesisAuthorship } = await import(
          "@/lib/theses.server"
        );
        await refreshTheses(true);
        const book = thesisBook();
        const body = {
          generatedAt: new Date().toISOString(),
          authorship: thesisAuthorship(),
          note: "size, unrealised and pnl are re-marked against the chain on every wallet sync, so these numbers are live rather than the values stored when the row was written.",
          open: book.rows.filter((r) => !r.retired && !r.closed),
          retired: book.rows.filter((r) => r.retired || r.closed),
        };
        return new Response(JSON.stringify(body, null, 2), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=15",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});
