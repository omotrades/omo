import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/proof.json")({
  server: {
    handlers: {
      GET: async () => {
        const { buildProofReport } = await import("@/lib/proof.server");
        const report = await buildProofReport();
        return new Response(JSON.stringify(report, null, 2), {
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
