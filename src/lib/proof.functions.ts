import { createServerFn } from "@tanstack/react-start";

export const fetchProofReport = createServerFn({ method: "GET" }).handler(async () => {
  const { buildProofReport } = await import("./proof.server");
  return await buildProofReport();
});
