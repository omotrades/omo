import { describe, expect, it } from "vitest";
import { compactLength, fromBase64, toBase64 } from "../solana.server";

describe("compactLength (shortvec)", () => {
  it("encodes single-byte lengths", () => {
    expect(compactLength(0)).toEqual([0]);
    expect(compactLength(1)).toEqual([1]);
    expect(compactLength(127)).toEqual([127]);
  });

  it("continues into a second byte past 127", () => {
    expect(compactLength(128)).toEqual([0x80, 0x01]);
    expect(compactLength(256)).toEqual([0x80, 0x02]);
  });

  it("continues into a third byte past 16383", () => {
    expect(compactLength(16384)).toEqual([0x80, 0x80, 0x01]);
  });
});

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });

  it("round-trips a signature-sized buffer", () => {
    const bytes = new Uint8Array(64).map((_, i) => (i * 7) % 256);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });
});
