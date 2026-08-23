/**
 * The signing boundary: open brain, locked hand.
 *
 * Everything omo uses to decide is in this repository and readable: market
 * reads, research, gating, risk sizing, the thesis book, the pre-commit hash,
 * the exit manager. That is the brain, and it is open on purpose, because a
 * claim about process is only worth what an outsider can audit.
 *
 * The one thing that is not in the repository is the secret that authorises a
 * transfer of value. It is supplied to the running process as an environment
 * variable and never written to a file, a log, a database row or a response
 * body. A repository cannot hold a spending key and still be publishable, so
 * the code holds the shape of the key and the environment holds the key.
 *
 * The consequence is precise and worth stating plainly: reading this repository
 * tells you exactly how a decision is formed and exactly what will be signed,
 * and gives you no ability to sign anything. Auditability and custody are
 * different problems, and they are solved separately here.
 *
 * What remains checkable without the key:
 *
 *   1. the decision hash lands on chain before the fill exists
 *   2. the revealed decision hashes to the published commitment
 *   3. the fill names the mint the commitment named
 *   4. the fill is signed by the published wallet
 *
 * Those four checks run against public Solana RPC in `verify.server.ts`, so the
 * chain is the trust layer rather than this file. The key proves nothing; the
 * signatures do.
 *
 * Arming is a runtime property, not a code property. `isArmed()` reports whether
 * a signer is present in the process, and `/api/public/disclosure.json`
 * republishes that answer unedited. The flag is derived from the environment, so
 * no deploy can turn it on and no edit here can fake it.
 */

import type { Signer } from "./keys.server";

/**
 * The contract the pipeline depends on. Any custody arrangement that can produce
 * a detached signature over the bytes of a transaction satisfies it: a local
 * keypair, a remote signing service, an HSM, a hardware wallet. The pipeline is
 * written against this shape and never against a particular secret's storage.
 */
export type TransactionSigner = Signer;

/**
 * Where a signature can come from. Recorded for documentation and disclosure
 * wording; the verification path does not care, because it checks the signature
 * on chain rather than the story about its origin.
 */
export type SignerCustody = "process-env" | "remote-service" | "hardware" | "absent";

/** The provenance rule, in one sentence, for anything that reports signing state. */
export const SIGNER_BOUNDARY_NOTE =
  "decision logic is public in this repository; the signing secret is held in the runtime environment only. every fill is checkable against the published wallet on chain without access to that secret.";
