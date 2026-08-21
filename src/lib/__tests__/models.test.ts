import { describe, expect, it } from "vitest";

import {
  MODEL_ROUTES,
  describeRouting,
  isUnsupportedModelError,
  roleLabel,
} from "../models.server";

describe("model routing", () => {
  it("declares claude opus 5 for reasoning and narration", () => {
    expect(MODEL_ROUTES.reasoning.primary).toBe("anthropic/claude-opus-5");
    expect(MODEL_ROUTES.narration.primary).toBe("anthropic/claude-opus-5");
  });

  it("declares grok for the live social read", () => {
    expect(MODEL_ROUTES.realtime.primary).toMatch(/^x-ai\/grok/);
  });

  it("gives every role a fallback chain and a written rationale", () => {
    for (const route of Object.values(MODEL_ROUTES)) {
      expect(route.fallbacks.length).toBeGreaterThan(0);
      expect(route.rationale.length).toBeGreaterThan(20);
    }
  });

  it("recognises an unsupported-model gateway error", () => {
    expect(isUnsupportedModelError(new Error("invalid model: anthropic/claude-opus-5"))).toBe(true);
    expect(isUnsupportedModelError(new Error("rate limit exceeded"))).toBe(false);
  });

  it("labels a routed call without hiding the declared model", () => {
    expect(roleLabel("reasoning", "anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(roleLabel("reasoning", "google/gemini-3.6-flash")).toContain("routed");
  });

  it("describes routing for every role", () => {
    const routing = describeRouting();
    expect(routing.map((entry) => entry.role).sort()).toEqual([
      "narration",
      "realtime",
      "reasoning",
    ]);
  });
});
