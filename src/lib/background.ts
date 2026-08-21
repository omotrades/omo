/**
 * The hosted app runs in a serverless worker: anything still pending when the
 * response is sent is killed. `waitUntil` is the only way to let a background
 * refresh finish, so the request entry hands its context here and the brain
 * registers its own jobs through `runInBackground`.
 */
type WaitUntil = (promise: Promise<unknown>) => void;

let waitUntil: WaitUntil | null = null;

export function setBackgroundHost(ctx: unknown) {
  const candidate = (ctx as { waitUntil?: unknown } | null)?.waitUntil;
  if (typeof candidate === "function") {
    waitUntil = (promise) => (candidate as WaitUntil).call(ctx, promise);
  }
}

export function runInBackground(promise: Promise<unknown>) {
  try {
    waitUntil?.(promise);
  } catch {
    /* the runtime refused to extend the request; the job still races the response */
  }
  return promise;
}
