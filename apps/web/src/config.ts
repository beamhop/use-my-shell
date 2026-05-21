/**
 * Runtime configuration, loaded from `/config.json` at startup.
 *
 * Credentials are NOT baked into the bundle at build time. The deploy host
 * provides `config.json` (a copy of `public/config.json`) and can overwrite
 * it per-deploy — so TURN credentials can be rotated without a rebuild.
 *
 * Note: a browser WebRTC client always needs the TURN credentials in the
 * browser, so they remain visible to anyone who loads the app. Shipping them
 * via config.json (rather than the bundle) only buys rotation without a
 * rebuild — it does not make them secret. Use quota-limited credentials.
 */

import type { TurnCredentials } from "@use-my-shell/protocol";

export interface AppConfig {
  /** TURN credentials, or null/absent to use STUN only. */
  turn: TurnCredentials | null;
}

/** Config used when `config.json` is missing or malformed — STUN only. */
const FALLBACK_CONFIG: AppConfig = { turn: null };

function parseConfig(raw: unknown): AppConfig {
  if (typeof raw !== "object" || raw === null) return FALLBACK_CONFIG;
  const turn = (raw as { turn?: unknown }).turn;
  if (
    typeof turn === "object" &&
    turn !== null &&
    typeof (turn as TurnCredentials).username === "string" &&
    typeof (turn as TurnCredentials).credential === "string" &&
    (turn as TurnCredentials).username.length > 0 &&
    (turn as TurnCredentials).credential.length > 0
  ) {
    return {
      turn: {
        username: (turn as TurnCredentials).username,
        credential: (turn as TurnCredentials).credential,
      },
    };
  }
  return FALLBACK_CONFIG;
}

/**
 * Fetch and parse `/config.json`. Never rejects — a missing or invalid file
 * falls back to STUN-only so the app still runs (just without TURN).
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}config.json`, {
      cache: "no-store",
    });
    if (!res.ok) return FALLBACK_CONFIG;
    return parseConfig(await res.json());
  } catch {
    return FALLBACK_CONFIG;
  }
}
