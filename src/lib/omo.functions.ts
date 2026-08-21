import { createServerFn } from "@tanstack/react-start";

export const fetchOmoState = createServerFn({ method: "GET" }).handler(async () => {
  const { getOmoState } = await import("./omo-brain.server");
  return await getOmoState();
});
