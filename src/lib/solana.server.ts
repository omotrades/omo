/**
 * The small amount of Solana plumbing this app needs, written by hand.
 *
 * The official web3.js sdk assumes a node process, so in this runtime the
 * transaction bytes are handled directly. That is less code than it sounds like:
 * a signed transaction is a compact-array of signatures followed by the message
 * the signatures cover, and signing is ed25519 over those message bytes.
 */

export const RPCS = [
  process.env["SOLANA_RPC_URL"],
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
].filter((url): url is string => Boolean(url));

export async function rpcAt<T>(endpoint: string, method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) {
      console.log(`[solana] ${method}: ${json.error.message ?? "unknown error"}`);
      return null;
    }
    return json.result ?? null;
  } catch {
    return null;
  }
}

export async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  for (const endpoint of RPCS) {
    const result = await rpcAt<T>(endpoint, method, params);
    if (result !== null) return result;
  }
  return null;
}

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Solana's shortvec length prefix. */
export function compactLength(n: number) {
  const out: number[] = [];
  let rem = n;
  for (;;) {
    let byte = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(byte);
      break;
    }
    byte |= 0x80;
    out.push(byte);
  }
  return out;
}

/**
 * A router hands back a serialized transaction with the signature slots left
 * blank. The layout is [shortvec count][64 bytes per signature][message], so the
 * message begins right after the blank slots and is exactly what gets signed.
 * The signature is written back into the first slot, which is the fee payer's:
 * the wallet.
 */
export function signSerializedTransaction(
  serialized: Uint8Array,
  sign: (message: Uint8Array) => Uint8Array,
): Uint8Array {
  let offset = 0;
  let count = 0;
  let shift = 0;
  for (;;) {
    const byte = serialized[offset];
    if (byte === undefined) throw new Error("malformed transaction: no signature count");
    offset += 1;
    count |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  if (count < 1) throw new Error("malformed transaction: no signature slots");

  const signaturesStart = offset;
  const messageStart = signaturesStart + count * 64;
  const message = serialized.subarray(messageStart);
  const signature = sign(message);
  if (signature.length !== 64) throw new Error("signature must be 64 bytes");

  const out = new Uint8Array(serialized);
  out.set(signature, signaturesStart);
  return out;
}

export async function latestBlockhash(endpoint: string) {
  const result = await rpcAt<{ value?: { blockhash?: string; lastValidBlockHeight?: number } }>(
    endpoint,
    "getLatestBlockhash",
    [{ commitment: "confirmed" }],
  );
  return result?.value ?? null;
}

export async function sendRawTransaction(endpoint: string, signed: Uint8Array) {
  return rpcAt<string>(endpoint, "sendTransaction", [
    toBase64(signed),
    { encoding: "base64", skipPreflight: true, maxRetries: 3, preflightCommitment: "confirmed" },
  ]);
}

export type Confirmation = {
  confirmed: boolean;
  slot: number | null;
  blockTime: string | null;
  err: string | null;
};

/**
 * Polls until the network either confirms or rejects the signature. A send that
 * is never confirmed is not a fill and must never be journalled as one.
 */
export async function confirmSignature(signature: string, timeoutMs = 60_000): Promise<Confirmation> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statuses = await rpc<{
      value?: ({ slot?: number; confirmationStatus?: string; err?: unknown } | null)[];
    }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const status = statuses?.value?.[0];
    if (status) {
      if (status.err) {
        return { confirmed: false, slot: status.slot ?? null, blockTime: null, err: JSON.stringify(status.err) };
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        const tx = await rpc<{ blockTime?: number | null; slot?: number }>("getTransaction", [
          signature,
          { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" },
        ]);
        return {
          confirmed: true,
          slot: tx?.slot ?? status.slot ?? null,
          blockTime: tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString(),
          err: null,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { confirmed: false, slot: null, blockTime: null, err: "not confirmed before timeout" };
}
