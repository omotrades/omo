/**
 * Key handling.
 *
 * There are exactly two keys in this system and they do different jobs:
 *
 *   OMO_TRADING_KEY  the wallet that holds the book. it signs swaps. this is the
 *                    key exported out of the fomo app (settings -> wallet ->
 *                    export private key), because fomo is a wallet front end:
 *                    the account it shows is a normal solana keypair, and once
 *                    the secret is in hand the account can be driven directly
 *                    against the chain without fomo being involved at all. that
 *                    is the whole reason omo needs no fomo api.
 *
 *   OMO_COMMIT_KEY   a separate burner that can only write memos. it never holds
 *                    the book, so publishing decision hashes can never touch
 *                    funds even if that key leaks.
 *
 * Accepted formats for either variable: base58 (what wallet apps export) or a
 * json array of 64 bytes (what the solana cli writes).
 *
 * The trading key is verified against the published wallet address on load. If
 * the derived public key is not OMO_WALLET, loading fails loudly instead of
 * quietly trading from some other account, because the entire proof rests on the
 * fills being signed by the address on the page.
 */

import { OMO_WALLET } from "./wallet.server";

export type Signer = {
  publicKey: Uint8Array;
  address: string;
  sign: (message: Uint8Array) => Uint8Array;
};

function decodeSecret(raw: string, bs58: { decode: (s: string) => Uint8Array }): Uint8Array {
  const value = raw.trim();
  if (value.startsWith("[")) return Uint8Array.from(JSON.parse(value) as number[]);
  return bs58.decode(value);
}

async function loadSigner(secret: string): Promise<Signer> {
  const bs58 = (await import("bs58")).default;
  const nacl = (await import("tweetnacl")).default;
  const bytes = decodeSecret(secret, bs58);
  const pair =
    bytes.length === 64
      ? nacl.sign.keyPair.fromSecretKey(bytes)
      : nacl.sign.keyPair.fromSeed(bytes);
  return {
    publicKey: pair.publicKey,
    address: bs58.encode(pair.publicKey),
    sign: (message: Uint8Array) => nacl.sign.detached(message, pair.secretKey),
  };
}

/**
 * The key that signs fills. Returns null when the loop is unarmed, which is a
 * normal state: everything upstream of execution still runs and the decision is
 * still committed on chain, it just does not place an order.
 */
export async function tradingSigner(): Promise<Signer | null> {
  const secret = process.env["OMO_TRADING_KEY"];
  if (!secret) return null;
  const signer = await loadSigner(secret);
  if (signer.address !== OMO_WALLET) {
    throw new Error(
      `OMO_TRADING_KEY derives ${signer.address}, which is not the published wallet ${OMO_WALLET}. refusing to trade from an unpublished account.`,
    );
  }
  return signer;
}

/** The memo-only burner. Never holds the book. */
export async function commitSigner(): Promise<Signer | null> {
  const secret = process.env["OMO_COMMIT_KEY"];
  if (!secret) return null;
  return loadSigner(secret);
}

/** True when the loop can actually place an order rather than only reason about one. */
export function isArmed() {
  return Boolean(process.env["OMO_TRADING_KEY"]);
}
