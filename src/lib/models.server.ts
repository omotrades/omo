/**
 * Model routing.
 *
 * omo is not one model. Different stages of the loop want different minds, so
 * every stage declares the model it was designed around, plus an ordered
 * fallback chain for when that model is not served by the configured gateway.
 *
 *   reasoning  -> claude opus 5   : thesis formation, self-audit, the long think.
 *                                   chosen for instruction adherence over many
 *                                   constraints (no repeats, no em dashes, no
 *                                   inventing fills) and for holding a large
 *                                   book context without drifting into hype.
 *   realtime   -> grok            : live social read. chosen because it is the
 *                                   only mind wired directly into the timeline
 *                                   where memecoin attention actually forms.
 *   narration  -> claude opus 5   : the thought stream. same mind as reasoning
 *                                   so what omo says matches what omo decided.
 *
 * Resolution is honest by design: the router never claims a model it could not
 * reach. `resolveRole` returns the id it actually used and whether the stage ran
 * degraded, and the loop records that alongside the output.
 */

import type { LanguageModel } from "ai";
import { createAiGatewayProvider, resolveModelApiKey } from "./ai-gateway.server";

export type ModelRole = "reasoning" | "realtime" | "narration";

type RoleRoute = {
  /** The model this stage was written for. */
  primary: string;
  /** Tried in order when the primary is not served. */
  fallbacks: string[];
  /** Why this mind and not another. Kept in code so the choice is reviewable. */
  rationale: string;
};

export const MODEL_ROUTES: Record<ModelRole, RoleRoute> = {
  reasoning: {
    primary: "anthropic/claude-opus-5",
    fallbacks: ["google/gemini-3.6-flash", "google/gemini-2.5-flash"],
    rationale:
      "thesis formation and the pre-trade think. long context over the whole book, hard constraint adherence, low appetite for hype.",
  },
  realtime: {
    primary: "x-ai/grok-4.1",
    fallbacks: ["google/gemini-3.6-flash", "google/gemini-2.5-flash"],
    rationale:
      "live social read on a name. attention forms on the timeline first, so this stage wants the model closest to it.",
  },
  narration: {
    primary: "anthropic/claude-opus-5",
    fallbacks: ["google/gemini-3.6-flash", "google/gemini-2.5-flash"],
    rationale:
      "the thought stream. same mind as reasoning so the words match the decision instead of narrating over it.",
  },
};

/** Model ids the gateway has already rejected this process. Not retried. */
const unavailable = new Set<string>();

/** True when a gateway error means "this model is not served here". */
export function isUnsupportedModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /invalid model|model_not_found|unsupported model|does not exist/i.test(message);
}

export type ResolvedRole = {
  role: ModelRole;
  /** The model actually used. */
  model: string;
  /** The model the stage was designed around. */
  declared: string;
  /** True when the declared model was unreachable and a fallback ran instead. */
  degraded: boolean;
  label: string;
};

function candidatesFor(role: ModelRole): string[] {
  const route = MODEL_ROUTES[role];
  return [route.primary, ...route.fallbacks].filter((id) => !unavailable.has(id));
}

/** Short human label for the UI and the decision log. */
export function roleLabel(role: ModelRole, model: string): string {
  const declared = MODEL_ROUTES[role].primary;
  const pretty = (id: string) => id.split("/").pop() ?? id;
  return model === declared ? pretty(declared) : `${pretty(declared)} (routed: ${pretty(model)})`;
}

/**
 * Runs one stage against its role's model chain.
 *
 * `call` receives a ready model handle. If the gateway says the model is not
 * served, that id is marked unavailable for the rest of the process and the next
 * one in the chain is tried. Any other failure is the caller's to handle: a rate
 * limit or a bad prompt is not a reason to silently downgrade the mind.
 */
export async function runRole<T>(
  role: ModelRole,
  call: (model: LanguageModel) => Promise<T>,
  options: { apiKey?: string } = {},
): Promise<{ result: T; resolved: ResolvedRole }> {
  const apiKey = options.apiKey ?? resolveModelApiKey();
  if (!apiKey) throw new Error("Missing OMO_MODEL_API_KEY");

  const gateway = createAiGatewayProvider(apiKey);
  const chain = candidatesFor(role);
  if (chain.length === 0) throw new Error(`no model available for role ${role}`);

  let lastError: unknown;
  for (const id of chain) {
    try {
      const result = await call(gateway(id));
      const declared = MODEL_ROUTES[role].primary;
      return {
        result,
        resolved: {
          role,
          model: id,
          declared,
          degraded: id !== declared,
          label: roleLabel(role, id),
        },
      };
    } catch (error) {
      if (!isUnsupportedModelError(error)) throw error;
      unavailable.add(id);
      lastError = error;
    }
  }
  throw lastError ?? new Error(`no model available for role ${role}`);
}

/** What the router would use right now, without spending a call. */
export function describeRouting(): ResolvedRole[] {
  return (Object.keys(MODEL_ROUTES) as ModelRole[]).map((role) => {
    const declared = MODEL_ROUTES[role].primary;
    const model = candidatesFor(role)[0] ?? declared;
    return { role, model, declared, degraded: model !== declared, label: roleLabel(role, model) };
  });
}
