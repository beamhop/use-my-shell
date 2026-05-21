/**
 * Shared P2P protocol contract for use-my-shell.
 *
 * Imported by both the CLI host and the browser SPA so that trystero action
 * names and message payload shapes can never drift between the two sides.
 * Zero runtime dependencies — pure types, constants, and validators.
 */

/** Trystero `appId`. Must be identical on host and browser to share a room. */
export const APP_ID = "use-my-shell" as const;

/** Bumped on any breaking change to the message shapes below. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Trystero action names. Trystero limits action names to 12 bytes, so these
 * are kept short. Both peers must register every action before any peer joins.
 */
export const ACTIONS = Object.freeze({
  /** host -> browser: raw PTY output bytes. */
  output: "out",
  /** browser -> host: raw keystroke bytes. */
  input: "in",
  /** browser -> host: terminal size changed. */
  resize: "resize",
  /** browser -> host: handshake announcing the browser is present. */
  hello: "hello",
  /** host -> browser: session is live, terminal may render. */
  ready: "ready",
  /** either direction: graceful close. */
  bye: "bye",
} as const);

export type ActionName = (typeof ACTIONS)[keyof typeof ACTIONS];

// ---------------------------------------------------------------------------
// Message payloads
// ---------------------------------------------------------------------------

/**
 * JSON value as accepted by trystero actions. Control messages below carry an
 * index signature of this shape so they satisfy trystero's `DataPayload`
 * constraint (which requires plain objects to be JSON records).
 */
export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

/** host -> browser. Raw PTY output bytes; trystero chunks/serializes binary. */
export type OutputMessage = Uint8Array;

/** browser -> host. Raw keystroke bytes (UTF-8 encoded terminal input). */
export type InputMessage = Uint8Array;

/** browser -> host. New terminal dimensions in character cells. */
export type ResizeMessage = {
  cols: number;
  rows: number;
  [key: string]: JsonValue;
};

/** browser -> host. Sent once the browser sees the host peer. */
export type HelloMessage = {
  protocolVersion: number;
  [key: string]: JsonValue;
};

/** host -> browser. Sent after a valid hello; describes the live session. */
export type ReadyMessage = {
  protocolVersion: number;
  cols: number;
  rows: number;
  /** Shell command running inside the sandbox, e.g. "/bin/sh". */
  shell: string;
  /** Sandbox base image, e.g. "alpine". */
  image: string;
  [key: string]: JsonValue;
};

/** Either direction. Graceful teardown with a human-readable reason. */
export type ByeMessage = {
  reason: string;
  [key: string]: JsonValue;
};

// ---------------------------------------------------------------------------
// Validators / type guards
// ---------------------------------------------------------------------------

/**
 * Room codes are word-list triplets like `brave-otter-lake`: three lowercase
 * alphabetic words separated by hyphens. Used to reject malformed URLs before
 * attempting to join a room.
 */
const ROOM_CODE_RE = /^[a-z]+-[a-z]+-[a-z]+$/;

export function isValidRoomCode(value: unknown): value is string {
  return typeof value === "string" && ROOM_CODE_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isResizeMessage(value: unknown): value is ResizeMessage {
  return (
    isRecord(value) &&
    isFiniteNumber(value.cols) &&
    isFiniteNumber(value.rows) &&
    value.cols > 0 &&
    value.rows > 0
  );
}

export function isHelloMessage(value: unknown): value is HelloMessage {
  return isRecord(value) && isFiniteNumber(value.protocolVersion);
}

export function isReadyMessage(value: unknown): value is ReadyMessage {
  return (
    isRecord(value) &&
    isFiniteNumber(value.protocolVersion) &&
    isFiniteNumber(value.cols) &&
    isFiniteNumber(value.rows) &&
    typeof value.shell === "string" &&
    typeof value.image === "string"
  );
}

export function isByeMessage(value: unknown): value is ByeMessage {
  return isRecord(value) && typeof value.reason === "string";
}

/** Normalizes trystero binary payloads (which may arrive as ArrayBuffer). */
export function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

// ---------------------------------------------------------------------------
// ICE / TURN configuration
// ---------------------------------------------------------------------------

/** A single ICE server entry — shape of `RTCIceServer`. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** TURN credentials, supplied to both apps via environment variables. */
export interface TurnCredentials {
  /** TURN username (the metered.ca "username", or a coturn user). */
  username: string;
  /** TURN credential / password. */
  credential: string;
}

/**
 * Build the `iceServers` array for a WebRTC connection.
 *
 * Without TURN credentials, peers rely on trystero's default STUN-only
 * behavior — fine for most networks, but strict/symmetric NATs may fail.
 * Supplying TURN credentials adds relay candidates so a connection can fall
 * back to a media relay when direct/STUN paths do not work.
 *
 * The endpoint hosts default to metered.ca's global relay; pass `hosts` to
 * point at a self-hosted coturn instead. STUN and TURN over UDP/TCP and
 * TURN-over-TLS are all included so the widest range of networks is covered.
 */
export function buildIceServers(
  turn?: TurnCredentials,
  hosts: { stun?: string; turn?: string; turns?: string } = {},
): IceServer[] {
  const stunHost = hosts.stun ?? "stun.relay.metered.ca:80";
  const turnHost = hosts.turn ?? "global.relay.metered.ca";
  const turnsHost = hosts.turns ?? "global.relay.metered.ca:443";

  const servers: IceServer[] = [{ urls: `stun:${stunHost}` }];

  if (turn) {
    const auth = { username: turn.username, credential: turn.credential };
    servers.push(
      { urls: `turn:${turnHost}:80`, ...auth },
      { urls: `turn:${turnHost}:80?transport=tcp`, ...auth },
      { urls: `turn:${turnHost}:443`, ...auth },
      { urls: `turns:${turnsHost}?transport=tcp`, ...auth },
    );
  }

  return servers;
}
