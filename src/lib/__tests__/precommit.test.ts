import { describe, expect, it } from "vitest";
import { commitPreimage } from "../precommit.server";

/**
 * A hash over a non-deterministic encoding is not a commitment. These tests pin
 * the properties the commit/reveal sequence relies on.
 */
describe("commitPreimage", () => {
  const nonce = "0123456789abcdef0123456789abcdef";

  it("is version prefixed and carries the nonce", () => {
    expect(commitPreimage({ a: 1 }, nonce)).toBe(`omo-commit-v1|${nonce}|{"a":1}`);
  });

  it("is independent of key insertion order", () => {
    const a = commitPreimage({ symbol: "$CATE", side: "buy", usd: 2600 }, nonce);
    const b = commitPreimage({ usd: 2600, symbol: "$CATE", side: "buy" }, nonce);
    expect(a).toBe(b);
  });

  it("drops undefined but keeps null", () => {
    expect(commitPreimage({ a: 1, b: undefined }, nonce)).toBe(commitPreimage({ a: 1 }, nonce));
    expect(commitPreimage({ a: null }, nonce)).toContain('{"a":null}');
  });

  it("preserves array order", () => {
    expect(commitPreimage({ rules: ["a", "b"] }, nonce)).not.toBe(
      commitPreimage({ rules: ["b", "a"] }, nonce),
    );
  });

  it("serialises nested objects canonically", () => {
    expect(commitPreimage({ outer: { z: 1, a: { y: 2, b: 3 } } }, nonce)).toBe(
      `omo-commit-v1|${nonce}|{"outer":{"a":{"b":3,"y":2},"z":1}}`,
    );
  });

  it("changes when the nonce changes", () => {
    expect(commitPreimage({ a: 1 }, "aaaa")).not.toBe(commitPreimage({ a: 1 }, "bbbb"));
  });
});
