import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/verify.json")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const raw = Number(url.searchParams.get("limit") ?? 8);
        const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 25) : 8;
        const { buildVerifyReport } = await import("@/lib/verify.server");
        const report = await buildVerifyReport(limit);
        return new Response(JSON.stringify(report, null, 2), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=30",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});
