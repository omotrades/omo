import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Model access for omo.
 *
 * The upstream gateway defines the wire protocol (header and base URL names are
 * fixed by the provider contract). Everything omo owns is named neutrally so the
 * repository reads as a single system.
 */

const RUN_ID_HEADER = "X-Lovable-AIG-Run-ID";
const API_KEY_HEADER = "Lovable-API-Key";
const SDK_HEADER = "X-Lovable-AIG-SDK";

function gatewayBaseUrl(): string | undefined {
  return process.env["OMO_AI_GATEWAY_URL"]?.trim() || undefined;
}

/** Resolve the model API key. */
export function resolveModelApiKey(): string | undefined {
  return process.env["OMO_MODEL_API_KEY"]?.trim() || undefined;
}

export function createRunIdFetch(initialRunId?: string) {
  let runId = initialRunId?.trim() || undefined;

  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (runId && !headers.has(RUN_ID_HEADER)) {
        headers.set(RUN_ID_HEADER, runId);
      }
      const response = await fetch(input, { ...init, headers });
      const next = response.headers.get(RUN_ID_HEADER)?.trim();
      if (!runId && next) runId = next;
      return response;
    },
    getRunId: () => runId,
  };
}

export function createAiGatewayProvider(apiKey: string, initialRunId?: string) {
  const runIdFetch = createRunIdFetch(initialRunId);

  const baseURL = gatewayBaseUrl();
  if (!baseURL) {
    throw new Error("Missing OMO_AI_GATEWAY_URL");
  }

  const provider = createOpenAICompatible({
    name: "omo",
    baseURL,
    supportsStructuredOutputs: false,
    headers: {
      [API_KEY_HEADER]: apiKey,
      [SDK_HEADER]: "vercel-ai-sdk",
    },
    fetch: runIdFetch.fetch,
  });

  return Object.assign(provider, { getRunId: runIdFetch.getRunId });
}
