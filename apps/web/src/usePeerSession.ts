/**
 * Trystero P2P session hook for the browser side.
 *
 * Owns the connection lifecycle and a small state machine. Because trystero
 * surfaces a wrong password only as a connection that never completes (a
 * mismatch silently fails to connect), the hook treats "no host appeared
 * within a timeout" as a prompt for a password.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { joinRoom } from "trystero";
import type { Room } from "trystero";
import {
  ACTIONS,
  APP_ID,
  PROTOCOL_VERSION,
  buildIceServers,
  isByeMessage,
  isReadyMessage,
  toUint8Array,
  type ByeMessage,
  type HelloMessage,
  type ReadyMessage,
  type ResizeMessage,
} from "@use-my-shell/protocol";
import type { AppConfig } from "./config.ts";

/** How long to wait for the host before assuming a password is needed. */
const HOST_TIMEOUT_MS = 8000;

export type SessionStatus =
  | "joining" // joined the room, waiting for the host peer
  | "password-required" // host never appeared — likely a password mismatch
  | "connected" // handshake complete, terminal is live
  | "disconnected" // host left or ended the session
  | "error"; // a fatal error occurred

export interface PeerSession {
  status: SessionStatus;
  /** Set once the host sends its `ready` handshake. */
  ready: ReadyMessage | null;
  /** Human-readable detail for the disconnected / error states. */
  detail: string | null;
  /** Send raw keystroke bytes to the host. */
  sendInput: (data: Uint8Array) => void;
  /** Register a sink for incoming PTY output bytes. */
  onOutput: (fn: (data: Uint8Array) => void) => void;
  /** Retry with a password (from the `password-required` state). */
  submitPassword: (password: string) => void;
  /** Rejoin the room from scratch (from `disconnected` / `error`). */
  reconnect: () => void;
}

interface Connection {
  room: Room;
  sendInput: (data: Uint8Array, peer?: string) => Promise<unknown>;
  sendResize: (msg: ResizeMessage, peer?: string) => Promise<unknown>;
  sendHello: (msg: HelloMessage, peer?: string) => Promise<unknown>;
  sendBye: (msg: ByeMessage, peer?: string) => Promise<unknown>;
}

export function usePeerSession(
  roomCode: string | null,
  config: AppConfig,
): PeerSession {
  const [status, setStatus] = useState<SessionStatus>("joining");
  const [ready, setReady] = useState<ReadyMessage | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  /** Bumped to force a fresh join attempt. */
  const [attempt, setAttempt] = useState(0);

  const connRef = useRef<Connection | null>(null);
  const outputSinkRef = useRef<((data: Uint8Array) => void) | null>(null);
  const passwordRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!roomCode) {
      setStatus("error");
      setDetail("No room code in the URL.");
      return;
    }

    setStatus("joining");
    setReady(null);
    setDetail(null);

    let room: Room;
    try {
      room = joinRoom(
        {
          appId: APP_ID,
          password: passwordRef.current,
          // STUN-only unless TURN credentials were provided in the runtime
          // config (`/config.json`), in which case relay candidates are added.
          rtcConfig: {
            iceServers: buildIceServers(config.turn ?? undefined),
          },
        },
        roomCode,
      );
    } catch (err) {
      setStatus("error");
      setDetail(err instanceof Error ? err.message : String(err));
      return;
    }

    // Register every action up front — both peers must agree on the set.
    const [sendInput] = room.makeAction<Uint8Array>(ACTIONS.input);
    const [, onOutput] = room.makeAction<Uint8Array>(ACTIONS.output);
    const [sendResize] = room.makeAction<ResizeMessage>(ACTIONS.resize);
    const [sendHello] = room.makeAction<HelloMessage>(ACTIONS.hello);
    const [, onReady] = room.makeAction<ReadyMessage>(ACTIONS.ready);
    const [sendBye, onBye] = room.makeAction<ByeMessage>(ACTIONS.bye);

    connRef.current = { room, sendInput, sendResize, sendHello, sendBye };

    // If the host never shows up, the most likely cause is a password
    // mismatch. Prompt for one (unless we already had a password set, in
    // which case it was wrong).
    const hostTimer = window.setTimeout(() => {
      setStatus((prev) => (prev === "joining" ? "password-required" : prev));
    }, HOST_TIMEOUT_MS);

    room.onPeerJoin((peerId) => {
      // The host appeared — announce ourselves. The PTY size is fixed by
      // the host, so we report no size (0/0); the host advertises the
      // authoritative grid back in its `ready` message.
      void sendHello(
        { protocolVersion: PROTOCOL_VERSION, cols: 0, rows: 0 },
        peerId,
      );
    });

    onReady((msg) => {
      if (!isReadyMessage(msg)) return;
      window.clearTimeout(hostTimer);
      setReady(msg);
      setStatus("connected");
      setDetail(null);
    });

    onOutput((data) => {
      const bytes = toUint8Array(data);
      if (bytes) outputSinkRef.current?.(bytes);
    });

    onBye((msg) => {
      const reason = isByeMessage(msg) ? msg.reason : "The host ended the session.";
      window.clearTimeout(hostTimer);
      setStatus("disconnected");
      setDetail(reason);
    });

    room.onPeerLeave(() => {
      window.clearTimeout(hostTimer);
      setStatus((prev) => (prev === "connected" ? "disconnected" : prev));
      setDetail((prev) => prev ?? "The host disconnected.");
    });

    return () => {
      window.clearTimeout(hostTimer);
      connRef.current = null;
      void sendBye({ reason: "The viewer closed the page." }).catch(() => {});
      void room.leave().catch(() => {});
    };
  }, [roomCode, attempt, config]);

  const sendInput = useCallback((data: Uint8Array) => {
    void connRef.current?.sendInput(data).catch(() => {});
  }, []);

  const onOutput = useCallback((fn: (data: Uint8Array) => void) => {
    outputSinkRef.current = fn;
  }, []);

  const submitPassword = useCallback((password: string) => {
    passwordRef.current = password.length > 0 ? password : undefined;
    setAttempt((n) => n + 1);
  }, []);

  const reconnect = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  return {
    status,
    ready,
    detail,
    sendInput,
    onOutput,
    submitPassword,
    reconnect,
  };
}
