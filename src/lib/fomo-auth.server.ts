/**
 * Session minting for FOMO's API.
 *
 * fomo.family authenticates with Privy. We hold a long-lived refresh token and
 * exchange it for a short-lived (≈1h) access token, which the API requires —
 * Cloudflare in front of prod-api also rejects requests without one. The token
 * is cached in memory and re-minted a minute before it expires.
 */

const PRIVY_APP_ID = "cm6h485o300n3zj9yl6vpedq7";
const SESSIONS = "https://auth.privy.io/api/v1/sessions";

let token: string | null = null;
let expiresAt = 0;
let inFlight: Promise<string | null> | null = null;

function jwtExp(jwt: string): number {
  try {
    const part = jwt.split(".")[1];
    if (!part) return 0;
    const pad = part + "=".repeat((4 - (part.length % 4)) % 4);
    const json = JSON.parse(atob(pad.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return typeof json.exp === "number" ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function mint(): Promise<string | null> {
  const refresh = process.env["FOMO_PRIVY_REFRESH_TOKEN"];
  if (!refresh) return null;
  try {
    const res = await fetch(SESSIONS, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "privy-app-id": PRIVY_APP_ID,
        "privy-client": "react-auth:2.28.1",
        origin: "https://fomo.family",
        referer: "https://fomo.family/",
      },
      body: JSON.stringify({ refresh_token: refresh }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.log(`[fomo-auth] session refresh failed ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { token?: string };
    if (!body.token) return null;
    token = body.token;
    expiresAt = jwtExp(body.token) || Date.now() + 45 * 60_000;
    console.log("[fomo-auth] minted session, valid for", Math.round((expiresAt - Date.now()) / 60_000), "min");
    return token;
  } catch (e) {
    console.log(`[fomo-auth] session refresh error ${String(e).slice(0, 120)}`);
    return null;
  }
}

/** A valid FOMO bearer token, or null if the session cannot be minted. */
export async function fomoAccessToken(): Promise<string | null> {
  if (token && Date.now() < expiresAt - 60_000) return token;
  if (!inFlight) {
    inFlight = mint().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
