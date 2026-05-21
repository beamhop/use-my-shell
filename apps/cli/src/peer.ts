/**
 * Trystero P2P room for the host side.
 *
 * Runs in this host Bun process — outside the sandbox VM. It is the WebRTC
 * bridge between the sandbox's PTY stream and the browser. Node/Bun has no
 * native `RTCPeerConnection`, so trystero is given the `werift` polyfill.
 */

import { RTCPeerConnection } from "werift";
import { joinRoom } from "trystero";
import type { Room } from "trystero";
import {
  ACTIONS,
  APP_ID,
  buildIceServers,
  type ByeMessage,
  type HelloMessage,
  type IceServer,
  type ReadyMessage,
  type ResizeMessage,
  type TurnCredentials,
} from "@use-my-shell/protocol";

/**
 * Read TURN credentials from the environment. Returns `undefined` when they
 * are not set — the connection then relies on STUN only.
 */
function turnFromEnv(): TurnCredentials | undefined {
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  if (username && credential) return { username, credential };
  return undefined;
}

export interface HostPeer {
  room: Room;
  /** Send raw PTY output bytes to a specific browser peer. */
  sendOutput: (data: Uint8Array, peerId: string) => void;
  /** Send the session-ready handshake to a specific peer. */
  sendReady: (msg: ReadyMessage, peerId: string) => void;
  /** Send a graceful-close notice (to one peer, or all if omitted). */
  sendBye: (msg: ByeMessage, peerId?: string) => void;
  /** Register a handler for browser keystroke input. */
  onInput: (fn: (data: Uint8Array, peerId: string) => void) => void;
  /** Register a handler for browser terminal-resize events. */
  onResize: (fn: (msg: ResizeMessage, peerId: string) => void) => void;
  /** Register a handler for the browser's hello handshake. */
  onHello: (fn: (msg: HelloMessage, peerId: string) => void) => void;
  /** Register a handler for a browser's graceful close. */
  onBye: (fn: (msg: ByeMessage, peerId: string) => void) => void;
  /** Register a handler for a peer joining the room. */
  onPeerJoin: (fn: (peerId: string) => void) => void;
  /** Register a handler for a peer leaving the room. */
  onPeerLeave: (fn: (peerId: string) => void) => void;
  /** Leave the room and release resources. */
  leave: () => Promise<void>;
}

export interface PeerOptions {
  roomCode: string;
  /** Optional shared password. Browsers must supply the same value to connect. */
  password?: string;
}

/**
 * Join the trystero room and wire up all actions.
 *
 * Every action is registered up front: trystero requires both peers to
 * declare the same set of actions before any peer connects.
 */
export function createHostPeer(opts: PeerOptions): HostPeer {
  // STUN-only by default; TURN relay candidates are added when TURN
  // credentials are present in the environment.
  const iceServers: IceServer[] = buildIceServers(turnFromEnv());

  // werift provides a WebRTC implementation for Node/Bun; its
  // RTCPeerConnection is structurally compatible with the browser API
  // trystero drives. The config is cast because the CLI tsconfig has no DOM
  // lib, so `typeof RTCPeerConnection` / `RTCConfiguration` in trystero's
  // types have no matching values here.
  const config = {
    appId: APP_ID,
    password: opts.password,
    rtcPolyfill: RTCPeerConnection,
    rtcConfig: { iceServers },
  } as unknown as Parameters<typeof joinRoom>[0];

  const room = joinRoom(config, opts.roomCode);

  // Binary actions for the PTY byte streams.
  const [sendOutputRaw] = room.makeAction<Uint8Array>(ACTIONS.output);
  const [, receiveInput] = room.makeAction<Uint8Array>(ACTIONS.input);

  // JSON actions for control messages.
  const [, receiveResize] = room.makeAction<ResizeMessage>(ACTIONS.resize);
  const [, receiveHello] = room.makeAction<HelloMessage>(ACTIONS.hello);
  const [sendReadyRaw] = room.makeAction<ReadyMessage>(ACTIONS.ready);
  const [sendByeRaw, receiveBye] = room.makeAction<ByeMessage>(ACTIONS.bye);

  return {
    room,
    sendOutput: (data, peerId) => {
      void sendOutputRaw(data, peerId);
    },
    sendReady: (msg, peerId) => {
      void sendReadyRaw(msg, peerId);
    },
    sendBye: (msg, peerId) => {
      void sendByeRaw(msg, peerId);
    },
    onInput: (fn) => receiveInput((data, peerId) => fn(data, peerId)),
    onResize: (fn) => receiveResize((msg, peerId) => fn(msg, peerId)),
    onHello: (fn) => receiveHello((msg, peerId) => fn(msg, peerId)),
    onBye: (fn) => receiveBye((msg, peerId) => fn(msg, peerId)),
    onPeerJoin: (fn) => room.onPeerJoin(fn),
    onPeerLeave: (fn) => room.onPeerLeave(fn),
    leave: () => room.leave(),
  };
}
