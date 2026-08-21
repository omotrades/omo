import { describe, expect, it } from "vitest";
import { evaluateRules, ruleLabel } from "../audit.server";
import type { MemeCandidate } from "../market.server";
import type { WalletSnapshot } from "../wallet.server";

const passing: MemeCandidate = {
  symbol: "$TEST",
  name: "test",
  mint: "So11111111111111111111111111111111111111112",
  url: "https://example.com",
  priceUsd: 0.001,
  liquidityUsd: 120_000,
  fdv: 2_000_000,
  vol24h: 400_000,
  vol1h: 45_000,
  chg5m: 0.4,
  chg1h: 3.2,
  chg6h: 9.1,
  chg24h: 22,
  buys1h: 420,
  sells1h: 210,
  ageHours: 96,
  boosted: false,
  socials: ["x"],
  hasSite: true,
  real: true,
};

const wallet = { cash: 5_000, positions: [] } as unknown as WalletSnapshot;

const ruleOf = (rules: { id: string; pass: boolean }[], id: string) =>
  rules.find((rule) => rule.id === id);

describe("evaluateRules", () => {
  it("passes every rule on a healthy candidate", () => {
    const { rules } = evaluateRules(passing, undefined, wallet, 55, false);
    expect(rules.filter((rule) => !rule.pass)).toEqual([]);
  });

  it("refuses a thin pool", () => {
    const { rules } = evaluateRules({ ...passing, liquidityUsd: 4_000 }, undefined, wallet, 55, false);
    expect(ruleOf(rules, "liquidity_floor")?.pass).toBe(false);
  });

  it("refuses a dead tape", () => {
    const { rules } = evaluateRules({ ...passing, vol1h: 500 }, undefined, wallet, 55, false);
    expect(ruleOf(rules, "volume_alive")?.pass).toBe(false);
  });

  it("refuses when sells lead buys", () => {
    const { rules } = evaluateRules({ ...passing, buys1h: 10, sells1h: 90 }, undefined, wallet, 55, false);
    expect(ruleOf(rules, "buy_pressure")?.pass).toBe(false);
  });

  it("refuses a newborn already bleeding", () => {
    const { rules } = evaluateRules(
      { ...passing, ageHours: 3, chg1h: -40 },
      undefined,
      wallet,
      55,
      false,
    );
    expect(ruleOf(rules, "not_newborn_fade")?.pass).toBe(false);
  });

  it("allows an older token that is down on the hour", () => {
    const { rules } = evaluateRules({ ...passing, ageHours: 400, chg1h: -40 }, undefined, wallet, 55, false);
    expect(ruleOf(rules, "not_newborn_fade")?.pass).toBe(true);
  });

  it("refuses a ticker with no public presence", () => {
    const { rules } = evaluateRules(
      { ...passing, socials: [], hasSite: false },
      undefined,
      wallet,
      55,
      false,
    );
    expect(ruleOf(rules, "public_presence")?.pass).toBe(false);
  });

  it("refuses crowd heat outside the acting range", () => {
    expect(ruleOf(evaluateRules(passing, undefined, wallet, 5, false).rules, "crowd_heat")?.pass).toBe(false);
    expect(ruleOf(evaluateRules(passing, undefined, wallet, 98, false).rules, "crowd_heat")?.pass).toBe(false);
  });

  it("refuses without cash on hand", () => {
    const broke = { cash: 1, positions: [] } as unknown as WalletSnapshot;
    expect(ruleOf(evaluateRules(passing, undefined, wallet, 55, false).rules, "cash_available")?.pass).toBe(true);
    expect(ruleOf(evaluateRules(passing, undefined, broke, 55, false).rules, "cash_available")?.pass).toBe(false);
  });

  it("refuses a name it already holds", () => {
    const held = {
      cash: 5_000,
      positions: [{ symbol: "TEST", usdValue: 1_200 }],
    } as unknown as WalletSnapshot;
    expect(ruleOf(evaluateRules(passing, undefined, held, 55, false).rules, "already_held")?.pass).toBe(false);
  });

  it("refuses while on a break", () => {
    expect(ruleOf(evaluateRules(passing, undefined, wallet, 55, true).rules, "not_on_break")?.pass).toBe(false);
  });

  it("records the inputs the decision was made on", () => {
    const { inputs } = evaluateRules(passing, undefined, wallet, 55, false);
    expect(inputs).toMatchObject({
      liquidityUsd: 120_000,
      vol1h: 45_000,
      buys1h: 420,
      sells1h: 210,
      fomo: 55,
      hasSite: true,
      researched: false,
    });
  });

  it("has a human label for every rule it emits", () => {
    const { rules } = evaluateRules(passing, undefined, wallet, 55, false);
    for (const rule of rules) expect(ruleLabel(rule.id)).not.toBe(rule.id);
  });
});
