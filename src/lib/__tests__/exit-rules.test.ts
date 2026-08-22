import { describe, expect, it } from "vitest";
import { EXIT_LIMITS, evaluateExitRules, evaluateSellGate, type ExitInputs } from "../exit.server";

/**
 * The exit rules are the half of the loop that closes risk, so they are pinned
 * here: a rule nobody can replay is not a rule.
 */
const base: ExitInputs = {
  symbol: "$TEST",
  mint: "TestMint111111111111111111111111111111111111",
  unrealizedPct: 5,
  peakPct: 5,
  trimsTaken: 0,
  holdDays: 1,
  positionUsd: 1_000,
  liquidityUsd: 120_000,
  volumeUsd: 90_000,
  buys: 400,
  sells: 300,
  chg6h: 4,
};

describe("evaluateExitRules", () => {
  it("holds when nothing fires", () => {
    const decision = evaluateExitRules(base);
    expect(decision.fraction).toBe(0);
    expect(decision.fired).toEqual([]);
  });

  it("closes the whole position on the hard stop", () => {
    const decision = evaluateExitRules({ ...base, unrealizedPct: EXIT_LIMITS.stopLossPct - 1 });
    expect(decision.fraction).toBe(1);
    expect(decision.fired).toContain("exit_stop_loss");
  });

  it("only arms the trailing stop after a real run", () => {
    const early = evaluateExitRules({ ...base, peakPct: 40, unrealizedPct: -5 });
    expect(early.fired).not.toContain("exit_trailing_stop");
    const armed = evaluateExitRules({ ...base, peakPct: 120, unrealizedPct: 70 });
    expect(armed.fraction).toBe(1);
    expect(armed.fired).toContain("exit_trailing_stop");
  });

  it("exits on a liquidity break even while in profit", () => {
    const decision = evaluateExitRules({ ...base, unrealizedPct: 50, liquidityUsd: 4_000 });
    expect(decision.fraction).toBe(1);
    expect(decision.fired).toContain("exit_liquidity_break");
  });

  it("exits when price and flow both break", () => {
    const decision = evaluateExitRules({ ...base, chg6h: -40, buys: 100, sells: 300 });
    expect(decision.fraction).toBe(1);
  });

  it("takes profit in tranches and does not retake a tranche", () => {
    const first = evaluateExitRules({ ...base, unrealizedPct: 150 });
    expect(first.tranche).toBe(0);
    expect(first.fraction).toBeCloseTo(0.33);
    const again = evaluateExitRules({ ...base, unrealizedPct: 150, trimsTaken: 1 });
    expect(again.fraction).toBe(0);
  });

  it("prefers a full exit over a trim when risk is breaking", () => {
    const decision = evaluateExitRules({ ...base, unrealizedPct: 150, peakPct: 400 });
    expect(decision.fraction).toBe(1);
    expect(decision.tranche).toBeNull();
  });

  it("closes a thesis that neither worked nor broke", () => {
    const decision = evaluateExitRules({
      ...base,
      holdDays: EXIT_LIMITS.staleDays + 1,
      unrealizedPct: 2,
      volumeUsd: 900,
    });
    expect(decision.fraction).toBe(1);
  });
});

describe("evaluateSellGate", () => {
  it("passes a clean exit", () => {
    const gate = evaluateSellGate({ clipUsd: 500, minutesSinceLastExit: null, exitsToday: 0, tranche: null, trimsTaken: 0 });
    expect(gate.every((rule) => rule.pass)).toBe(true);
  });

  it("blocks dust clips, cooldown breaches and the daily ceiling", () => {
    const dust = evaluateSellGate({ clipUsd: 5, minutesSinceLastExit: null, exitsToday: 0, tranche: null, trimsTaken: 0 });
    expect(dust.find((r) => r.id === "gate_min_clip")?.pass).toBe(false);

    const hot = evaluateSellGate({ clipUsd: 500, minutesSinceLastExit: 2, exitsToday: 0, tranche: null, trimsTaken: 0 });
    expect(hot.find((r) => r.id === "gate_cooldown")?.pass).toBe(false);

    const busy = evaluateSellGate({
      clipUsd: 500,
      minutesSinceLastExit: null,
      exitsToday: EXIT_LIMITS.maxExitsPerDay,
      tranche: null,
      trimsTaken: 0,
    });
    expect(busy.find((r) => r.id === "gate_daily_exits")?.pass).toBe(false);
  });
});
